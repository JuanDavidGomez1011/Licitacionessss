"""Tests de la alerta de sincronizaciones fallidas.

Contexto: el bug #7 fallo dos ciclos seguidos y nadie se entero. La alerta
convierte el historial de `sync_runs` en una senal que `/api/salud` expone.
"""

from __future__ import annotations

import datetime as dt

from app.config import settings
from app.ingest.runner import failed_streak
from app.models import SyncRun


def _run(session, status: str, minutes_ago: int, error: str | None = None) -> None:
    momento = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)
    session.add(
        SyncRun(
            dataset="procesos:p6dx-8zbt",
            status=status,
            started_at=momento,
            finished_at=momento,
            error=error,
        )
    )
    session.flush()


class TestFailedStreak:
    def test_sin_historial_no_hay_alerta(self, session):
        info = failed_streak()
        assert info["consecutivas"] == 0
        assert info["alerta"] is False
        assert info["ultimo_error"] is None

    def test_ultima_sync_correcta_no_avisa(self, session):
        _run(session, "ok", 1)
        session.commit()
        info = failed_streak()
        assert info["consecutivas"] == 0
        assert info["alerta"] is False

    def test_umbral_por_defecto(self):
        assert settings.sync_alert_failed_streak == 3

    def test_cuenta_solo_los_consecutivos_al_principio(self, session):
        """Un `ok` corta la racha: lo que importa es el estado mas reciente."""
        _run(session, "failed", 1, "red caída")
        _run(session, "failed", 30, "red caída")
        _run(session, "ok", 60)
        _run(session, "failed", 90, "fallo viejo")
        session.commit()

        info = failed_streak()
        assert info["consecutivas"] == 2
        assert info["alerta"] is False, "2 seguidas no supera el umbral de 3"
        assert "red caída" in (info["ultimo_error"] or "")

    def test_dispara_la_alerta_al_superar_el_umbral(self, session):
        for i in range(4):
            _run(session, "failed", i * 10, f"fallo {i}")
        session.commit()

        info = failed_streak()
        assert info["consecutivas"] == 4
        assert info["alerta"] is True

    def test_umbral_desactivado(self, session, monkeypatch):
        monkeypatch.setattr(settings, "sync_alert_failed_streak", 0)
        for i in range(9):
            _run(session, "failed", i * 10)
        session.commit()

        info = failed_streak()
        assert info["consecutivas"] == 9
        assert info["alerta"] is False, "con umbral 0 la alerta nunca se dispara"

    def test_umbral_de_un_solo_fallo(self, session, monkeypatch):
        monkeypatch.setattr(settings, "sync_alert_failed_streak", 1)
        _run(session, "failed", 1, "algo se rompio")
        session.commit()
        assert failed_streak()["alerta"] is True
