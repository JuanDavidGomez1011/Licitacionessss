"""Cliente HTTP de Ollama para inferencia 100% local (sin salida a internet).

Cubre las dos familias que usa la plataforma:
  - `/api/embed` o `/api/embeddings`  -> vectores para comparar semanticamente
  - `/api/chat` con `format: json`     -> score 0-100 + 3 vinetas
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger(__name__)


class OllamaUnavailable(RuntimeError):
    """El servidor de Ollama no esta levantado o no expone el modelo pedido."""


class OllamaClient:
    def __init__(self, base_url: str | None = None, timeout: float | None = None) -> None:
        self.base_url = (base_url or settings.ollama_url).rstrip("/")
        self.timeout = timeout or settings.ollama_timeout
        self._client: httpx.Client | None = None
        # Tamano de lote que el tokenizer de Ollama ha Aguirreido. Se recuerda
        # porque, si se descubrio que 128 textos revientan el sidecar, reintentar
        # 128 en cada lote siguiente es una peticion que se va a saber mal: en el
        # barrido completo son ~2.600 rechazos garantizados.
        self._embed_chunk_ok: int | None = None

    def __enter__(self) -> "OllamaClient":
        self._client = httpx.Client(base_url=self.base_url, timeout=self.timeout)
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._client:
            self._client.close()
            self._client = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(base_url=self.base_url, timeout=self.timeout)
        return self._client

    # --- salud ----------------------------------------------------------
    def is_available(self) -> bool:
        try:
            resp = self.client.get("/api/tags", timeout=5.0)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    def list_models(self) -> list[str]:
        try:
            resp = self.client.get("/api/tags", timeout=10.0)
            resp.raise_for_status()
            return [m.get("name", "") for m in resp.json().get("models", [])]
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaUnavailable(f"no se pudo listar modelos en {self.base_url}: {exc}") from exc

    def has_model(self, model: str) -> bool:
        try:
            names = self.list_models()
        except OllamaUnavailable:
            return False
        wanted = model.lower()
        return any(
            n.lower() == wanted
            or n.lower().split(":")[0] == wanted.split(":")[0]
            for n in names
        )

    def ensure_model(self, model: str) -> None:
        if not self.has_model(model):
            raise OllamaUnavailable(
                f"el modelo '{model}' no esta en Ollama. Ejecuta: ollama pull {model}"
            )

    # --- embeddings -----------------------------------------------------
    def embed(self, texts: list[str], model: str | None = None, chunk_size: int | None = None) -> list[list[float]]:
        """Devuelve un vector por texto. Trocea la llamada a `/api/embed`.

        Trocear no es una optimizacion, es una necesidad: mandar cientos de
        textos en una sola peticion tumba el tokenizer interno de Ollama, que
        responde 400 con "connection refused" hacia su propio sidecar, y
        `embed` no reintentaba, asi que el fallo se llevaba por delante la
        ingesta entera (el mismo patron que el bug #7, pero aqui la victima es
        la llamada, no la sentencia SQL).

        Ante un fallo se reintenta con el lote a la mitad, hasta llegar a uno
        texto por peticion. Asi el mismo `embed` aguanta tanto los 40
        candidatos del ciclo diario como el barrido completo del dataset.
        """
        if not texts:
            return []
        model = model or settings.ollama_embed_model
        chunk = chunk_size or self._embed_chunk_ok or settings.embed_chunk_size
        chunk = max(1, min(chunk, len(texts)))

        out: list[list[float]] = []
        for i in range(0, len(texts), chunk):
            out.extend(self._embed_with_backoff(texts[i : i + chunk], model, chunk))
        return out

    def _embed_with_backoff(self, texts: list[str], model: str, chunk: int) -> list[list[float]]:
        attempt_chunk = min(chunk, self._embed_chunk_ok or chunk)
        last_exc: Exception | None = None
        while attempt_chunk >= 1:
            vectors: list[list[float]] = []
            try:
                for i in range(0, len(texts), attempt_chunk):
                    vectors.extend(self._embed_once(texts[i : i + attempt_chunk], model))
                # El lote que funciono es el techo del que se volvera a
                # intentar: el del reintento, no el del primer intento, que ya
                # se sabe malo.
                self._embed_chunk_ok = attempt_chunk
                return vectors
            except (httpx.HTTPStatusError, httpx.HTTPError, OllamaUnavailable) as exc:
                last_exc = exc
                if attempt_chunk == 1:
                    break
                attempt_chunk = max(1, attempt_chunk // 2)
                log.warning(
                    "embeddings con lote de %d fallaron (%s); reintento con %d",
                    chunk, _motivo(exc), attempt_chunk,
                )
        self._embed_chunk_ok = 1
        assert last_exc is not None
        raise last_exc

    def _embed_once(self, texts: list[str], model: str) -> list[list[float]]:
        payload = {"model": model, "input": texts, "keep_alive": settings.ollama_keep_alive}
        try:
            resp = self.client.post("/api/embed", json=payload)
            if resp.status_code == 404:
                return self._embed_legacy(texts, model)
            resp.raise_for_status()
            vectors = resp.json().get("embeddings")
            if not vectors:
                raise OllamaUnavailable(f"/api/embed devolvio payload sin 'embeddings'")
            return [list(map(float, v)) for v in vectors]
        except httpx.HTTPStatusError as exc:
            raise OllamaUnavailable(
                f"embeddings fallaron ({exc.response.status_code}) con '{model}': {exc.response.text[:300]}"
            ) from exc
        except httpx.HTTPError as exc:
            raise OllamaUnavailable(f"no hay conexion con Ollama en {self.base_url}: {exc}") from exc

    def _embed_legacy(self, texts: list[str], model: str) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            resp = self.client.post(
                "/api/embeddings", json={"model": model, "prompt": text}
            )
            resp.raise_for_status()
            data = resp.json()
            if "embedding" not in data:
                raise OllamaUnavailable("/api/embeddings devolvio payload sin 'embedding'")
            out.append(list(map(float, data["embedding"])))
        return out

    def embed_one(self, text: str, model: str | None = None) -> list[float]:
        vectors = self.embed([text], model=model)
        if not vectors:
            raise OllamaUnavailable("no se obtuvo embedding")
        return vectors[0]

    # --- chat ------------------------------------------------------------
    def chat_json(
        self,
        system: str,
        user: str,
        model: str | None = None,
        temperature: float = 0.1,
        num_predict: int = 700,
    ) -> dict[str, Any]:
        """Pide JSON estructurado al LLM. `format='json'` fuerza salida valida."""
        model = model or settings.ollama_llm
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": "json",
            "stream": False,
            "temperature": temperature,
            "num_predict": num_predict,
            "num_ctx": settings.ollama_num_ctx,
            "keep_alive": settings.ollama_keep_alive,
        }
        last_exc: Exception | None = None
        for attempt in range(1, settings.max_retries + 1):
            try:
                resp = self.client.post("/api/chat", json=payload)
                resp.raise_for_status()
                content = resp.json()["message"]["content"]
                parsed = _extract_json(content)
                if parsed is None:
                    raise ValueError(f"contenido no parseable como JSON: {content[:300]}")
                return parsed
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                last_exc = exc
                if attempt == settings.max_retries:
                    break
                time.sleep(min(2 ** attempt, 8))
        raise OllamaUnavailable(f"chat con '{model}' fallo tras {settings.max_retries} intentos: {last_exc}")


def _motivo(exc: Exception) -> str:
    """Resumen corto de un fallo de HTTP, para el log de reintentos."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}: {exc.response.text[:120]}"
    return str(exc)[:160] or type(exc).__name__


def _extract_json(content: str) -> Any | None:
    """Extrae JSON de la respuesta del LLM, tolerando vallas o texto alrededor."""
    if not content:
        return None
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    inicio = min(
        (i for i in (text.find("{"), text.find("[")) if i != -1),
        default=-1,
    )
    if inicio == -1:
        return None
    cierre = "}" if text[inicio] == "{" else "]"
    fin = text.rfind(cierre)
    if fin <= inicio:
        return None
    try:
        return json.loads(text[inicio : fin + 1])
    except json.JSONDecodeError:
        return None
