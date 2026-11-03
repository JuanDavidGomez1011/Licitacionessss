"""Planificador: sincronizacion autonoma de SECOP II.

Tres disparadores, todos alimentando el mismo `run_sync`, que ya se serializa con
un lock (ver `app.ingest.runner`):

- `sync_periodico`: cada `SYNC_INTERVAL_MINUTES` con ventana corta. Es el que
  mantiene el panel al dia mientras el servidor queda encendido.
- `sync_diario`: a las 03:15 con la ventana ancha, para recuperar dias perdidos.
- `sync_arranque`: al levantar, solo si lo ultimo sincronizado ya esta viejo.
"""

from __future__ import annotations

import datetime as dt
import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.config import settings

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _job_sync(lookback_days: int | None, motivo: str) -> None:
    from app.ingest.runner import run_sync, sync_en_curso

    if sync_en_curso():
        log.info("sync (%s): omitido, ya hay uno en curso", motivo)
        return
    log.info("sync (%s): iniciando", motivo)
    try:
        report = run_sync(lookback_days=lookback_days)
        log.info(
            "sync (%s): ok=%s nuevas_procesos=%s duracion=%ss %s",
            motivo,
            report.ok,
            report.procesos.get("inserted"),
            round(report.duration_s, 1),
            report.errores or "",
        )
    except Exception:
        log.exception("sync (%s): fallo", motivo)


def _job_periodico() -> None:
    _job_sync(settings.sync_lookback_frequent_days, "periodico")


def _job_diaria() -> None:
    _job_sync(settings.sync_lookback_days, "diario")


def _job_arranque() -> None:
    from app.ingest.runner import _last_run

    umbral = settings.sync_startup_if_stale_minutes
    ultima = _last_run()
    if ultima and ultima.get("started_at"):
        try:
            edad = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(
                ultima["started_at"]
            )
        except ValueError:
            edad = None
        if edad is not None and edad.total_seconds() < umbral * 60:
            log.info(
                "arranque: lo ultimo sincronizado hace %.0f min, no hace falta catch-up",
                edad.total_seconds() / 60,
            )
            return
        log.info(
            "arranque: lo ultimo sincronizado hace %.0f min (umbral %s), se sincroniza",
            edad.total_seconds() / 60,
            umbral,
        )
    else:
        log.info("arranque: nunca se ha sincronizado, se arranca ahora")
    _job_sync(settings.sync_lookback_days, "arranque")


def start_scheduler() -> BackgroundScheduler | None:
    global _scheduler
    if not settings.enable_scheduler:
        log.info("planificador desactivado (ENABLE_SCHEDULER=false)")
        return None
    if _scheduler is not None and _scheduler.running:
        return _scheduler

    scheduler = BackgroundScheduler(timezone="America/Bogota")

    if settings.sync_interval_minutes > 0:
        scheduler.add_job(
            _job_periodico,
            IntervalTrigger(minutes=settings.sync_interval_minutes),
            id="sync_periodico",
            name=(
                f"Sincronizacion cada {settings.sync_interval_minutes} min "
                f"(ventana {settings.sync_lookback_frequent_days} d) + scoring IA"
            ),
            replace_existing=True,
            misfire_grace_time=600,
            coalesce=True,
            max_instances=1,
        )

    scheduler.add_job(
        _job_diaria,
        CronTrigger(hour=settings.sync_cron_hour, minute=settings.sync_cron_minute),
        id="sync_diario",
        name="Sincronizacion diaria SECOP II (ventana ancha) + scoring IA",
        replace_existing=True,
        misfire_grace_time=3600,
        coalesce=True,
        max_instances=1,
    )

    scheduler.add_job(
        _job_arranque,
        DateTrigger(run_date=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=20)),
        id="sync_arranque",
        name="Catch-up al arrancar si los datos estan viejos",
        replace_existing=True,
        misfire_grace_time=120,
        coalesce=True,
        max_instances=1,
    )

    scheduler.start()
    _scheduler = scheduler
    log.info(
        "planificador activo: cada %s min (ventana %s d) + diario %02d:%02d America/Bogota",
        settings.sync_interval_minutes,
        settings.sync_lookback_frequent_days,
        settings.sync_cron_hour,
        settings.sync_cron_minute,
    )
    return scheduler


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("planificador detenido")
    _scheduler = None


def jobs() -> list[dict]:
    if _scheduler is None:
        return []
    return [
        {
            "id": j.id,
            "name": j.name,
            "next_run": j.next_run_time.isoformat() if j.next_run_time else None,
        }
        for j in _scheduler.get_jobs()
    ]
