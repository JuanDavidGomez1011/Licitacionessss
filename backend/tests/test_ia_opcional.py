"""IA opcional: qué tiene que pasar cuando Ollama está apagado.

Contexto: Ollama ya no se levanta solo (`start.ps1` exige `-ConOllama`) porque
era justo lo que se comía la VRAM, y cuando se levanta va con
`OLLAMA_NUM_GPU=0` (solo RAM). Ver ESTADO-PROYECTO.md §3.8.2.

Apagado es un estado **legítimo**, no una avería, y estos tests fijan las dos
cosas que dependían de eso:

  - `/api/salud` no se queda en "degradado" para siempre (con
    `OLLAMA_REQUIRED=false`, que es el valor por defecto)
  - el ciclo de ingesta no se marca fallido solo porque no hay IA, que si no
    llenaría `sync_runs` de falsos errores cada 30 minutos

No se levanta Ollama ni se sale a internet: se dobla `OllamaClient.is_available`
y la ingesta. La base es la de pruebas de siempre.
"""

from __future__ import annotations

import pytest

from app.api.sync import salud
from app.config import settings
from app.ingest import runner
from app.ingest.secop_contratos import ExtractResult


@pytest.fixture
def sin_ollama(monkeypatch):
    """Ollama que no contesta. Es la clase de `app.ai.ollama_client`, la misma
    que usan `runner` y `app.api.sync`, así que un solo monkeypatch las dos."""
    monkeypatch.setattr(runner.OllamaClient, "is_available", lambda self: False)


@pytest.fixture
def con_ollama(monkeypatch):
    monkeypatch.setattr(runner.OllamaClient, "is_available", lambda self: True)


class _SocrataFalso:
    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return None


def _ingesta_falsa(*_a, **_k):
    return ExtractResult(fetched=3, inserted=3, updated=0)


@pytest.fixture
def ingesta_doblada(monkeypatch):
    monkeypatch.setattr(runner, "SocrataClient", _SocrataFalso)
    monkeypatch.setattr(runner, "sync_procesos", _ingesta_falsa)
    monkeypatch.setattr(runner, "sync_contratos", _ingesta_falsa)


class TestSalud:
    def test_sin_ia_la_plataforma_no_esta_degradada(self, sin_ollama, monkeypatch):
        monkeypatch.setattr(settings, "ollama_required", False)

        h = salud()

        assert h.estado == "ok", (
            "sin IA no hay nada roto: entra data nueva, pero queda sin puntuar"
        )
        assert h.ollama == "apagada (opcional)"
        assert h.ia_requerida is False

    def test_si_la_ia_es_requerida_sigue_siendo_degradado(self, sin_ollama, monkeypatch):
        monkeypatch.setattr(settings, "ollama_required", True)

        h = salud()

        assert h.estado == "degradado"
        assert h.ia_requerida is True

    def test_con_ollama_encendido_no_habla_de_ia_apagada(self, con_ollama, monkeypatch):
        monkeypatch.setattr(settings, "ollama_required", False)

        h = salud()

        assert h.estado == "ok"
        assert h.ollama == "ok"
        assert h.modelo_llm == settings.ollama_llm


class TestScoring:
    def test_run_scoring_no_revienta_sin_ollama(self, sin_ollama):
        out = runner.run_scoring()

        assert out["ok"] is False
        assert out["ollama_disponible"] is False
        assert settings.ollama_url in out["error"]

    def test_sin_ollama_la_ingesta_no_es_un_ciclo_fallido(self, sin_ollama, ingesta_doblada):
        report = runner.run_sync(include_contracts=False)

        assert report.ok is True, (
            "la descarga si se hizo: marcarla fallida seria mentir y ademas "
            "ensuciaria la alerta de `sync_runs`"
        )
        assert report.scoring["ollama_disponible"] is False
        assert report.scoring["omitido"] is True

    def test_un_fallo_de_scoring_de_verdad_si_ensucia_el_ciclo(self, ingesta_doblada, monkeypatch):
        monkeypatch.setattr(
            runner, "run_scoring", lambda **_k: {"ok": False, "error": "el matchmaker revento"}
        )

        report = runner.run_sync(include_contracts=False)

        assert report.ok is False, "aqui si hay fallo: el matchmaker se cae con IA puesta"
        assert "omitido" not in report.scoring
