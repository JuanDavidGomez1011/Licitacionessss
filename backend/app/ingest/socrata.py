"""Cliente de la API SODA (Socrata Open Data API) de Datos Abiertos Colombia.

Responsabilidades:
  - construir consultas con filtros SoQL (`$where`), orden y paginacion
  - reintentos con backoff exponencial ante 429/5xx/errores de red
  - normalizar los tipos de Socrata (los campos fecha llegan como epoch en milisegundos)
  - exponer un iterador de paginas para no cargar todo en memoria
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger(__name__)

RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
# Socrata devuelve un objeto con este campo cuando no encuentra coincidencias
SODA_NOT_FOUND = 0

# `noticeUID=CO1.NTC.10951052` dentro de la URL de OpportunityDetail.
_NOTICE_UID = re.compile(r"noticeUID=(CO1\.NTC\.\d+)", re.IGNORECASE)


class SocrataError(RuntimeError):
    pass


@dataclass
class Page:
    rows: list[dict[str, Any]]
    total: int | None


class SocrataClient:
    def __init__(
        self,
        base_url: str | None = None,
        app_token: str | None = None,
        timeout: float | None = None,
        page_size: int | None = None,
    ) -> None:
        self.base_url = (base_url or settings.socrata_base_url).rstrip("/")
        self.app_token = app_token if app_token is not None else settings.socrata_app_token
        self.timeout = timeout or settings.http_timeout
        self.page_size = min(page_size or settings.page_size, 50_000)
        self._client: httpx.Client | None = None

    # --- ciclo de vida --------------------------------------------------
    def __enter__(self) -> "SocrataClient":
        headers = {"Accept": "application/json", "User-Agent": "plataforma-licitaciones/1.0"}
        if self.app_token:
            headers["X-App-Token"] = self.app_token
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            follow_redirects=True,
        )
        return self

    def __exit__(self, *exc: object) -> None:
        if self._client:
            self._client.close()
            self._client = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self.__enter__()
        assert self._client is not None
        return self._client

    # --- consultas ------------------------------------------------------
    def _get(self, url: str, params: dict[str, Any]) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(1, settings.max_retries + 1):
            try:
                resp = self.client.get(url, params=params)
                if resp.status_code == 404:
                    return resp
                if resp.status_code in RETRY_STATUS:
                    raise httpx.HTTPStatusError(
                        f"HTTP {resp.status_code}", request=resp.request, response=resp
                    )
                resp.raise_for_status()
                return resp
            except (httpx.HTTPError, httpx.InvalidURL) as exc:
                last_exc = exc
                if attempt == settings.max_retries:
                    break
                wait = min(2 ** (attempt - 1), 8)
                log.warning(
                    "socrata: fallo en %s (intento %d/%d): %s; reintento en %ss",
                    url, attempt, settings.max_retries, exc, wait,
                )
                time.sleep(wait)
        raise SocrataError(f"no se pudo consultar {url} tras {settings.max_retries} intentos: {last_exc}")

    def count(self, dataset: str, where: str | None = None) -> int:
        params: dict[str, Any] = {"$select": "count(*) as n"}
        if where:
            params["$where"] = where
        resp = self._get(f"/resource/{dataset}.json", params)
        data = resp.json()
        if isinstance(data, dict) and data.get("error"):
            raise SocrataError(str(data.get("message") or data))
        return int(data[0]["n"]) if data else 0

    def fetch_page(
        self,
        dataset: str,
        where: str | None = None,
        order: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        select: str | None = None,
    ) -> Page:
        limit = min(limit or self.page_size, 50_000)
        params: dict[str, Any] = {"$limit": limit, "$offset": offset}
        if where:
            params["$where"] = where
        if order:
            params["$order"] = order
        if select:
            params["$select"] = select
        resp = self._get(f"/resource/{dataset}.json", params)
        data = resp.json()
        if isinstance(data, dict):
            if data.get("error") == SODA_NOT_FOUND:
                return Page(rows=[], total=0)
            if data.get("error"):
                raise SocrataError(str(data.get("message") or data))
        rows = data if isinstance(data, list) else []
        return Page(rows=rows, total=len(rows) if len(rows) >= limit else None)

    def iter_rows(
        self,
        dataset: str,
        where: str | None = None,
        order: str | None = None,
        max_rows: int | None = None,
        select: str | None = None,
        page_size: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Itera filas paginando con `$limit`/`$offset` hasta agotar o `max_rows`."""
        limit = min(page_size or self.page_size, 50_000)
        offset = 0
        yielded = 0
        while True:
            page = self.fetch_page(
                dataset, where=where, order=order, limit=limit, offset=offset, select=select
            )
            if not page.rows:
                return
            for row in page.rows:
                yield row
                yielded += 1
                if max_rows is not None and yielded >= max_rows:
                    return
            if len(page.rows) < limit:
                return
            offset += limit
            if max_rows is not None and offset >= max_rows:
                return
            time.sleep(settings.request_delay)

    # --- metadatos ------------------------------------------------------
    def metadata(self, dataset: str) -> dict[str, Any]:
        resp = self._get(f"/api/views/{dataset}", {})
        return resp.json()


# --- normalizacion de tipos Socrata --------------------------------------
def socrata_datetime(value: Any) -> datetime | None:
    """Normaliza una fecha de Socrata a datetime UTC con zona horaria.

    Los datasets de SECOP II declaran sus fechas como `calendar_date`, por lo que
    llegan como cadenas ISO-8601. Se acepta tambien epoch en milisegundos, que es
    lo que usan los datasets declarados como `floating timestamp`.
    """
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(text[:19])
            except ValueError:
                return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num <= 0:
        return None
    if num > 1e12:  # segundos -> milisegundos
        num *= 1000
    try:
        return datetime.fromtimestamp(num / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def socrata_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def socrata_int(value: Any) -> int | None:
    f = socrata_float(value)
    return int(f) if f is not None else None


def socrata_text(value: Any) -> str | None:
    """Normaliza un valor de Socrata a texto plano.

    Los campos de tipo `url` no llegan como cadena sino como objeto
    `{"url": "https://..."}`; sin aplanar, `str()` guardaba la repr del dict en
    la base de datos. Los campos `point` llevan `{lon, lat}` y no son texto.
    """
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        if "url" in value:
            return socrata_text(value["url"])
        if "lat" in value and "lon" in value:
            return f"{value['lat']},{value['lon']}"
        return None
    if isinstance(value, list):
        return ",".join(str(v) for v in value) or None
    text = str(value).strip()
    return text or None


def socrata_url(value: Any) -> str | None:
    """Igual que `socrata_text` pero tolerante a filas ya guardadas como repr.

    Permite reparar en caliente los registros previos al aplanado de `url`.
    """
    text = socrata_text(value)
    if text is None:
        return None
    if text.startswith("{") and "'url':" in text:
        inner = text.split("'url':", 1)[1].strip()
        return inner.strip("'\"} ").strip() or None
    return text


def notice_uid(url: str | None) -> str | None:
    """Extrae el `noticeUID` de una URL de OpportunityDetail de SECOP.

    Es la unica clave que comparten los dos datasets. `proceso_de_compra` de
    contratos trae ids `CO1.PCCNTR.*` (que son ids de contrato), mientras que
    `tenders.id_del_proceso` trae `CO1.REQ.*`: enlazar por ahi no casa nunca.
    En cambio las dos URLs llevan el mismo `noticeUID=CO1.NTC.*`.
    """
    if not url:
        return None
    match = _NOTICE_UID.search(url)
    return match.group(1) if match else None


def fit_to_model(model: type, payload: dict[str, Any]) -> dict[str, Any]:
    """Recorta los textos que no caben en el ancho declarado del modelo.

    Sin esto, una sola fila con un valor largo tumba la ingesta completa. Pasó
    con `contracts.referencia_del_contrato`: 181 filas del dataset oficial meten
    ahí el objeto entero del contrato, y Postgres abortaba los ~100.000
    registros del lote con

        value too long for type character varying(160)

    Recortar es peor que perder la fila entera, asi que solo se recorta lo
    imprescindible y se avisa por log con el ancho real, para que el ancho
    declarado se corrija en `models.py` si hace falta.
    """
    out = dict(payload)
    for nombre, columna in model.__table__.columns.items():
        ancho = getattr(columna.type, "length", None)
        if not ancho:
            continue
        valor = out.get(nombre)
        if isinstance(valor, str) and len(valor) > ancho:
            log.warning(
                "valor recortado: %s.%s excede %d caracteres (llega %d). "
                "Conviene ensanchar la columna.",
                model.__tablename__, nombre, ancho, len(valor),
            )
            out[nombre] = valor[:ancho]
    return out


def socrata_where_datetime(column: str, since: datetime, until: datetime | None = None) -> str:
    """Predicado SoQL sobre una columna de fecha.

    Los datasets de SECOP II usan `calendar_date`, que SoQL solo acepta con
    literales ISO-8601: comparar contra epoch en milisegundos devuelve HTTP 400.
    """
    start = _soql_literal(since)
    clause = f"{column} >= {start}"
    if until is not None:
        clause += f" AND {column} <= {_soql_literal(until)}"
    return clause


def _soql_literal(value: datetime) -> str:
    text = value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"'{text}'"


def socrata_where_date(column: str, since: datetime, until: datetime | None = None) -> str:
    """Igual que `socrata_where_datetime` pero truncando a dia (UTC)."""
    start = since.astimezone(timezone.utc).date().isoformat()
    clause = f"{column} >= '{start}'"
    if until is not None:
        clause += f" AND {column} <= '{until.astimezone(timezone.utc).date().isoformat()}'"
    return clause


def soql_quote(value: str) -> str:
    """Escapa una cadena para usarla como literal en SoQL."""
    return "'" + value.replace("'", "''") + "'"


def last_days(days: int) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=days), now
