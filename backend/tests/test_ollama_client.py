"""Cliente de Ollama: troceado de embeddings y reintentos.

El fallo que estos tests fijan: mandar cientos de textos en una sola peticion a
`/api/embed` tumba el tokenizer interno de Ollama, que responde 400 con
"connection refused" hacia su propio sidecar. `embed()` no reintentaba, asi que
el error se llevaba por delante la llamada entera.

No se levanta Ollama ni se toca la base: son doubles de `httpx`, que es donde
ocurre la decision (cuantos textos por peticion, y si se reduce el lote).
"""

from __future__ import annotations

import httpx
import pytest

from app.ai.ollama_client import OllamaClient, OllamaUnavailable


class _Respuesta:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload

    @property
    def text(self) -> str:
        return str(self._payload)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=httpx.Request("POST", "http://x"), response=self
            )


class _Falso:
    """Doble de `httpx.Client` que registra los lotes y falla a partir de cierto tamano."""

    def __init__(self, max_por_peticion: int | None = None, status: int = 400) -> None:
        self.lotes: list[int] = []
        self.max_por_peticion = max_por_peticion
        self.status = status

    def get(self, *_a, **_k):
        return _Respuesta(200, {"models": [{"name": "nomic-embed-text"}]})

    def post(self, _url, json=None, **_k):
        entrada = (json or {}).get("input") or []
        n = len(entrada) if isinstance(entrada, list) else 1
        self.lotes.append(n)
        if self.max_por_peticion is not None and n > self.max_por_peticion:
            return _Respuesta(
                self.status,
                {"error": 'Post "http://127.0.0.1:57602/tokenize": connection refused'},
            )
        return _Respuesta(200, {"embeddings": [[0.1] * 768 for _ in range(n)]})

    def close(self) -> None:
        pass


def _cliente(falso: _Falso) -> OllamaClient:
    c = OllamaClient()
    c._client = falso  # type: ignore[assignment]
    return c


def test_lote_pequeno_va_en_una_sola_peticion():
    """Los 40 candidatos del ciclo diario no deben partirse: son una peticion."""
    falso = _Falso()
    out = _cliente(falso).embed(["a", "b", "c"], chunk_size=128)
    assert len(out) == 3
    assert falso.lotes == [3]


def test_trocea_por_el_chunk_size():
    falso = _Falso()
    out = _cliente(falso).embed([f"t{i}" for i in range(500)], chunk_size=128)
    assert len(out) == 500
    assert falso.lotes == [128, 128, 128, 116]
    assert max(falso.lotes) <= 128


def test_reduce_el_lote_hasta_que_responda():
    """El 400 del tokenizer no puede tumbar la llamada entera.

    Con el tokenizer roto a partir de 64 textos por peticion, el cliente tiene
    que llegar a mandar 64/32/16/... sin rendirse, y devolver los 300 vectores.
    """
    falso = _Falso(max_por_peticion=64)
    out = _cliente(falso).embed([f"t{i}" for i in range(300)], chunk_size=128)
    assert len(out) == 300
    # el 128 solo se intenta una vez: en cuanto se sabe que revienta, los
    # siguientes lotes ya van directos a 64
    assert falso.lotes == [128, 64, 64, 64, 64, 44]


def test_si_falla_aunque_sea_de_uno_en_uno_propaga_el_error():
    """Con el tokenizer del todo roto hay que fallar, no devolver silencio."""
    falso = _Falso(max_por_peticion=0)
    with pytest.raises(OllamaUnavailable) as exc:
        _cliente(falso).embed(["a", "b"], chunk_size=128)
    assert "embeddings fallaron" in str(exc.value)


def test_texto_vacio_no_llama_a_ollama():
    falso = _Falso()
    assert _cliente(falso).embed([]) == []
    assert falso.lotes == []
