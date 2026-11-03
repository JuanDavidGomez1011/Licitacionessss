"""Orquestador de sincronizacion: descarga -> persiste -> puntua con IA."""

from __future__ import annotations

import datetime as dt
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select

from app.ai.matchmaker import ScoreResult, embed_profile, get_active_profile
from app.ai.ollama_client import OllamaClient, OllamaUnavailable
from app.config import settings
from app.db import session_scope
from app.ingest.secop_contratos import sync_contratos
from app.ingest.secop_procesos import sync_procesos
from app.ingest.socrata import SocrataClient
from app.models import Contract, Match, SyncRun, Tender

log = logging.getLogger(__name__)

# Un unico sync a la vez. Sin esto, el cron y el boton "Sincronizar ahora" del
# panel pueden solaparse: los dos hacen upsert sobre las mismas filas y ambos
# puntuan los mismos pendientes, lo que produce bloqueos y trabajo duplicado.
_lock = threading.Lock()

# Cuantas filas mira `failed_streak` como minimo, para poder reportar la racha
# aunque el umbral de alerta este desactivado.
STREAK_LOOKBACK = 50


def sync_en_curso() -> bool:
    return _lock.locked()


@dataclass
class SyncReport:
    procesos: dict[str, Any] = field(default_factory=dict)
    contratos: dict[str, Any] = field(default_factory=dict)
    scoring: dict[str, Any] = field(default_factory=dict)
    duration_s: float = 0.0
    ok: bool = True
    en_curso: bool = False
    errores: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "en_curso": self.en_curso,
            "duration_s": round(self.duration_s, 2),
            "procesos": self.procesos,
            "contratos": self.contratos,
            "scoring": self.scoring,
            "errores": self.errores,
        }


def _window(days: int | None = None) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=days or settings.sync_lookback_days), now


def _widen(days: int | None, minimum: int) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=max(days or settings.sync_lookback_days, minimum)), now


def _catchup_report(
    dataset: str, first: Any, original_days: int | None, report: SyncReport
) -> tuple[datetime, datetime]:
    """Si la ventana incremental vino vacia, se ensancha para recuperar dias perdidos.

    El dataset oficial se publica a diario pero puede tener dias sin movimiento, y
    si la maquina estuvo apagada el incremental no traeria nada. Sin esto, una
    instalacion nueva podria quedarse sin datos para siempre.
    """
    if first.fetched or not settings.sync_catchup_days:
        return _window(original_days)
    catch = _widen(original_days, settings.sync_catchup_days)
    log.warning(
        "%s: ventana de %s dias vacia; reintento con %s dias",
        dataset, original_days or settings.sync_lookback_days, settings.sync_catchup_days,
    )
    report.errores.append(
        f"{dataset}: ventana incremental vacia, se Amplio a {settings.sync_catchup_days} dias"
    )
    return catch


def run_sync(
    lookback_days: int | None = None,
    max_procesos: int | None = None,
    max_contratos: int | None = None,
    include_contracts: bool = True,
    score: bool = True,
    score_candidate_pool: int | None = None,
    force: bool = False,
) -> SyncReport:
    """Ciclo completo de sincronizacion. Pensado para el ciclo autonomo.

    Si ya hay una sincronizacion corriendo se devuelve un reporte con
    `en_curso=True` en vez de solaparse, salvo que `force=True`.
    """
    if not _lock.acquire(blocking=force):
        log.info("sync: ya hay una sincronizacion en curso; se omite esta pasada")
        return SyncReport(ok=True, en_curso=True)
    try:
        return _run_sync_locked(
            lookback_days, max_procesos, max_contratos,
            include_contracts, score, score_candidate_pool,
        )
    finally:
        _lock.release()


def _run_sync_locked(
    lookback_days: int | None,
    max_procesos: int | None,
    max_contratos: int | None,
    include_contracts: bool,
    score: bool,
    score_candidate_pool: int | None,
) -> SyncReport:
    started = time.perf_counter()
    report = SyncReport()
    since, until = _window(lookback_days)
    log.info("sync: ventana %s -> %s", since.isoformat(), until.isoformat())

    with SocrataClient() as api, OllamaClient() as embedder, OllamaClient() as llm:
        with session_scope() as session:
            _track(session, "procesos:p6dx-8zbt")
            try:
                res = sync_procesos(session, api, since=since, until=until, max_rows=max_procesos)
                if not res.fetched:
                    since, until = _catchup_report(
                        "procesos", res, lookback_days, report
                    )
                    res = sync_procesos(session, api, since=since, until=until, max_rows=max_procesos)
                report.procesos = res.__dict__
                log.info("sync procesos: %s", report.procesos)
            except Exception as exc:
                report.ok = False
                report.errores.append(f"procesos: {exc}")
                log.exception("fallo la ingesta de procesos")
                res = None
            _finish(session, "procesos:p6dx-8zbt", res, report)

            if include_contracts:
                _track(session, "contratos:jbjy-vk9h")
                try:
                    cres = sync_contratos(session, api, since=since, until=until, max_rows=max_contratos)
                    if not cres.fetched:
                        c_since, c_until = _catchup_report(
                            "contratos", cres, lookback_days, report
                        )
                        cres = sync_contratos(
                            session, api, since=c_since, until=c_until, max_rows=max_contratos
                        )
                    report.contratos = cres.__dict__
                    log.info("sync contratos: %s", report.contratos)
                except Exception as exc:
                    report.ok = False
                    report.errores.append(f"contratos: {exc}")
                    log.exception("fallo la ingesta de contratos")
                    cres = None
                _finish(session, "contratos:jbjy-vk9h", cres, report)

        if score:
            report.scoring = run_scoring(candidate_pool=score_candidate_pool)
            if not report.scoring.get("ok", True):
                # Ollama apagado no es un fallo del ciclo: la ingesta si se hizo.
                # Marcarlo como fallido llenaria `sync_runs` de falsos errores
                # cada 30 minutos, que es como se distingue "se cayo Socrata" de
                # "no hay IA". Se dice explicitamente y se sigue.
                if report.scoring.get("ollama_disponible") is False:
                    log.warning(
                        "puntaje omitido: no hay Ollama en %s (arrancalo con -ConOllama)",
                        settings.ollama_url,
                    )
                    report.scoring["omitido"] = True
                else:
                    report.ok = False

    report.duration_s = time.perf_counter() - started
    return report


def run_scoring(
    candidate_pool: int | None = None,
    use_llm: bool = True,
    rescore_all: bool = False,
) -> dict[str, Any]:
    """Puntua lo pendiente contra el perfil de empresa."""
    out: dict[str, Any] = {"ok": False}
    with OllamaClient() as embedder, OllamaClient() as llm:
        out["ollama_disponible"] = llm.is_available()
        if not out["ollama_disponible"]:
            # Aviso y no error: con Ollama apagado a proposito (§3.8.2) esto es
            # el estado normal, no una averia. Escalar a `log.error` metia ruido
            # cada 30 minutos en el log de la API.
            out["error"] = f"no hay respuesta de Ollama en {settings.ollama_url}"
            log.warning("%s: el puntaje con IA no se puede calcular", out["error"])
            return out
        try:
            embedder.ensure_model(settings.ollama_embed_model)
        except OllamaUnavailable as exc:
            out["error"] = str(exc)
            return out
        use_llm = use_llm and llm.has_model(settings.ollama_llm)

        with session_scope() as session:
            profile = get_active_profile(session)
            if profile is None:
                out["error"] = "no hay perfil de empresa configurado"
                return out
            if rescore_all:
                session.query(Match).delete()
                session.flush()
            try:
                res: ScoreResult = embed_profile(
                    session, profile, embedder, llm,
                    use_llm=use_llm, candidate_pool=candidate_pool,
                )
                out.update(
                    {
                        "ok": True,
                        "scored": res.scored,
                        "skipped": res.skipped,
                        "failed": res.failed,
                        "errors": res.errors,
                        "llm_usado": settings.ollama_llm if use_llm else None,
                        "perfil": profile.nombre,
                    }
                )
            except Exception as exc:
                out["error"] = str(exc)
                log.exception("fallo el matchmaker")
    return out


# --- trazas -------------------------------------------------------------
def _track(session, dataset: str) -> SyncRun:
    run = SyncRun(dataset=dataset, status="running")
    session.add(run)
    session.flush()
    return run


def _finish(session, dataset: str, result: Any, report: SyncReport) -> None:
    run = session.execute(
        select(SyncRun).where(SyncRun.dataset == dataset).order_by(SyncRun.started_at.desc())
    ).scalars().first()
    if run is None:
        return
    run.finished_at = datetime.now(timezone.utc)
    if result is None:
        run.status = "failed"
        run.error = "; ".join(report.errores)[:2000] or "error desconocido"
    else:
        run.status = "ok"
        run.rows_fetched = result.fetched
        run.rows_inserted = result.inserted
        run.rows_updated = result.updated


def _last_run() -> dict[str, Any] | None:
    with session_scope() as session:
        run = session.execute(
            select(SyncRun).order_by(SyncRun.started_at.desc()).limit(1)
        ).scalars().first()
        if run is None:
            return None
        return {
            "dataset": run.dataset,
            "status": run.status,
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "rows_fetched": run.rows_fetched,
            "rows_inserted": run.rows_inserted,
            "rows_updated": run.rows_updated,
            "error": run.error,
        }


def failed_streak() -> dict[str, Any]:
    """Racha de sincronizaciones fallidas seguidas, y si ya supera el umbral.

    El bug #7 fallo dos ciclos seguidos y nadie se entero: `run_sync` capturaba
    la excepcion por dataset y devolvia `ok=False`, pero el panel no miraba ese
    campo y el servidor tampoco avisaba. Esto convierte el historial en una
    senal que `/api/salud` puede exponer.
    """
    limite = settings.sync_alert_failed_streak
    with session_scope() as session:
        rows = session.execute(
            select(SyncRun.status, SyncRun.dataset, SyncRun.started_at, SyncRun.error)
            .order_by(SyncRun.started_at.desc())
            # El tope de filas no depende del umbral: aunque la alerta este
            # desactivada, el contador tiene que poder reportar la racha real.
            .limit(max(limite * 4, STREAK_LOOKBACK))
        ).all()

    racha = 0
    ultimo_error: str | None = None
    for status, _dataset, _started, error in rows:
        if status != "failed":
            break
        racha += 1
        if ultimo_error is None:
            ultimo_error = error
    return {
        "consecutivas": racha,
        "umbral": limite,
        "alerta": bool(limite and racha >= limite),
        "ultimo_error": ultimo_error,
    }


def platform_stats() -> dict[str, Any]:
    with session_scope() as session:
        total_tenders = session.scalar(select(func.count()).select_from(Tender)) or 0
        total_contracts = session.scalar(select(func.count()).select_from(Contract)) or 0
        scored = session.scalar(select(func.count()).select_from(Match)) or 0
        avg = session.scalar(select(func.avg(Match.score))) or 0
        high = session.scalar(
            select(func.count()).select_from(Match).where(Match.score >= 70)
        ) or 0
        last_run = session.execute(select(SyncRun).order_by(SyncRun.started_at.desc()).limit(1)).scalars().first()
        newest = session.scalar(select(func.max(Tender.fecha_publicacion)))
        return {
            "tenders": total_tenders,
            "contracts": total_contracts,
            "scored": scored,
            "avg_score": round(float(avg), 1),
            "high_matches": high,
            "en_curso": sync_en_curso(),
            "last_sync": {
                "dataset": last_run.dataset,
                "status": last_run.status,
                "started_at": last_run.started_at.isoformat() if last_run.started_at else None,
                "rows_fetched": last_run.rows_fetched,
                "rows_inserted": last_run.rows_inserted,
                "error": last_run.error,
            } if last_run else None,
            "alerta_sync": failed_streak(),
            "newest_tender_at": newest.isoformat() if newest else None,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
