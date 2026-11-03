"""Rutas de operacion: sincronizacion manual, scoring, salud y scheduler."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.ollama_client import OllamaClient
from app.config import settings
from app.db import engine, get_db
from app.ingest.runner import failed_streak, platform_stats, run_scoring, run_sync
from app.models import Match, SyncRun
from app.scheduler import jobs
from app.schemas import HealthOut, ScoreRequest, SyncRequest

log = logging.getLogger(__name__)
router = APIRouter(tags=["operacion"])


@router.get("/salud", response_model=HealthOut)
def salud() -> HealthOut:
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("select 1")
        db = "ok"
    except Exception as exc:
        db = f"error: {exc}"
    try:
        with OllamaClient() as client:
            ollama = "ok" if client.is_available() else "sin respuesta"
    except Exception as exc:
        ollama = f"error: {exc}"

    # Con Ollama apagado a proposito (IA opcional, §3.8.2) esto no es una
    # averia: sin IA no se puntua lo nuevo, pero la ingesta, la API y el panel
    # funcionan, y `/api/salud` en "degradado" permanente solo meteria ruido y
    # acabaria ignorado. Con OLLAMA_REQUIRED=true vuelve a ser una averia.
    ia_ok = ollama == "ok"
    if not ia_ok and not settings.ollama_required:
        ollama = "apagada (opcional)"

    alerta = failed_streak()
    if alerta.get("alerta"):
        log.error(
            "alerta: %d sincronizaciones fallidas seguidas (umbral %s): %s",
            alerta["consecutivas"], alerta["umbral"], alerta.get("ultimo_error"),
        )

    degradado = db != "ok" or bool(alerta.get("alerta")) or (
        settings.ollama_required and not ia_ok
    )
    return HealthOut(
        estado="degradado" if degradado else "ok",
        base_datos=db,
        ollama=ollama,
        modelo_llm=settings.ollama_llm,
        modelo_embeddings=settings.ollama_embed_model,
        ia_requerida=settings.ollama_required,
        datasets={
            "procesos": settings.dataset_procesos,
            "contratos": settings.dataset_contratos,
        },
        alerta_sync=alerta,
    )


@router.post("/sync")
def sincronizar(body: SyncRequest | None = None) -> dict[str, Any]:
    body = body or SyncRequest()
    log.info("sync manual solicitado: %s", body.model_dump())
    report = run_sync(
        lookback_days=body.lookback_days,
        max_procesos=body.max_procesos,
        max_contratos=body.max_contratos,
        include_contracts=body.include_contracts,
        score=body.score,
        score_candidate_pool=body.score_candidate_pool,
    )
    return report.to_dict()


@router.post("/sync/background", status_code=202)
def sincronizar_en_segundo_plano(
    background: BackgroundTasks,
    lookback_days: int | None = Query(default=None, ge=1, le=365),
    max_procesos: int | None = Query(default=None, ge=1, le=50_000),
) -> dict[str, Any]:
    """Lanza un ciclo de sincronizacion sin bloquear la respuesta.

    Es el endpoint que usa el boton "Sincronizar ahora" del panel. Si ya hay un
    ciclo corriendo no se encola otro: `run_sync` se salta y el panel einfach
    sigue al primero.
    """
    from app.ingest.runner import sync_en_curso

    if sync_en_curso():
        return {
            "ok": True,
            "lanzado": False,
            "mensaje": "ya hay una sincronizacion en curso",
        }
    background.add_task(run_sync, lookback_days, max_procesos)
    return {
        "ok": True,
        "lanzado": True,
        "mensaje": "sincronizacion lanzada en segundo plano",
    }


@router.get("/sync/estado")
def estado_sync() -> dict[str, Any]:
    """Estado del ciclo autonomo: si hay uno en curso, cuando fue el ultimo y
    cuando toca el siguiente. El panel lo consulta para mostrar el progreso."""
    from app.ingest.runner import _last_run, sync_en_curso

    ultima = _last_run()
    planificador = jobs()
    return {
        "en_curso": sync_en_curso(),
        "ultimo": ultima,
        "proximo": next(
            (j["next_run"] for j in planificador if j.get("next_run")), None
        ),
        "jobs": planificador,
        "intervalo_minutos": settings.sync_interval_minutes,
        "cron_activo": settings.enable_scheduler,
        "alerta": failed_streak(),
    }


@router.post("/score")
def puntuar(body: ScoreRequest | None = None) -> dict[str, Any]:
    body = body or ScoreRequest()
    return run_scoring(
        candidate_pool=body.candidate_pool,
        use_llm=body.use_llm,
        rescore_all=body.rescore_all,
    )


@router.get("/estadisticas")
def estadisticas() -> dict[str, Any]:
    return platform_stats()


@router.get("/sync/historial")
def historial(limite: int = Query(default=20, ge=1, le=200), db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.execute(select(SyncRun).order_by(SyncRun.started_at.desc()).limit(limite)).scalars().all()
    return {
        "items": [
            {
                "id": r.pk,
                "dataset": r.dataset,
                "status": r.status,
                "inicio": r.started_at.isoformat() if r.started_at else None,
                "fin": r.finished_at.isoformat() if r.finished_at else None,
                "leidas": r.rows_fetched,
                "insertadas": r.rows_inserted,
                "actualizadas": r.rows_updated,
                "error": r.error,
            }
            for r in rows
        ]
    }


@router.get("/scheduler")
def scheduler() -> dict[str, Any]:
    return {
        "activo": settings.enable_scheduler,
        "cron": f"{settings.sync_cron_minute} {settings.sync_cron_hour} * * *",
        "intervalo_minutos": settings.sync_interval_minutes,
        "jobs": jobs(),
    }


@router.get("/top")
def top(limite: int = Query(default=20, ge=1, le=200), db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.execute(select(Match).order_by(Match.score.desc()).limit(limite)).scalars().all()
    return {
        "items": [
            {
                "tender_id": m.tender_id,
                "score": m.score,
                "bullets": m.bullets,
                "rationale": m.rationale,
                "similitud": m.semantic_similarity,
                "modelo": m.model,
            }
            for m in rows
        ]
    }
