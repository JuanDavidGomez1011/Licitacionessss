"""Extractor de 'SECOP II - Procesos de Contratacion' (Socrata `p6dx-8zbt`).

Descarga unicamente los procesos nuevos o modificados dentro de una ventana de
fecha de publicacion y los persiste en la tabla `tenders`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.ingest.socrata import (
    SocrataClient,
    fit_to_model,
    notice_uid,
    socrata_datetime,
    socrata_float,
    socrata_int,
    socrata_text,
    socrata_url,
    socrata_where_date,
)
from app.ingest.upsert import bulk_upsert
from app.models import Tender

log = logging.getLogger(__name__)

# Columnas que se materializan en el modelo. El orden define el $select.
SELECT_COLUMNS: list[tuple[str, str]] = [
    ("id_del_proceso", "id_del_proceso"),
    ("referencia_del_proceso", "referencia_del_proceso"),
    ("entidad", "entidad"),
    ("nit_entidad", "nit_entidad"),
    ("departamento_entidad", "departamento_entidad"),
    ("ciudad_entidad", "ciudad_entidad"),
    ("nombre_del_procedimiento", "nombre_del_procedimiento"),
    ("descripci_n_del_procedimiento", "descripcion"),
    ("precio_base", "precio_base"),
    ("modalidad_de_contratacion", "modalidad_de_contratacion"),
    ("justificaci_n_modalidad_de", "justificacion_modalidad"),
    ("duracion", "duracion"),
    ("unidad_de_duracion", "unidad_de_duracion"),
    ("numero_de_lotes", "numero_de_lotes"),
    ("codigo_principal_de_categoria", "codigo_principal_categoria"),
    ("categorias_adicionales", "categorias_adicionales"),
    ("estado_del_procedimiento", "estado_del_procedimiento"),
    ("adjudicado", "adjudicado"),
    ("fecha_de_publicacion_del", "fecha_publicacion"),
    ("fecha_de_recepcion_de", "fecha_recepcion"),
    ("fecha_de_apertura_de_respuesta", "fecha_apertura_respuesta"),
    ("fecha_de_ultima_publicaci", "fecha_ultima_publicacion"),
    ("tipo_de_contrato", "tipo_contrato"),
    ("subtipo_de_contrato", "subtipo_contrato"),
    ("urlproceso", "url_proceso"),
    ("estado_resumen", "estado_resumen"),
]

_INT_FIELDS = {"duracion", "numero_de_lotes"}
_FLOAT_FIELDS = {"precio_base"}
_URL_FIELDS = {"url_proceso"}
_DATE_FIELDS = {
    "fecha_publicacion",
    "fecha_recepcion",
    "fecha_apertura_respuesta",
    "fecha_ultima_publicacion",
}

SELECT_EXPR = ",".join(src for src, _ in SELECT_COLUMNS)

# El dataset es enorme: se pide el incremental por fecha de ultima publicacion,
# que es la que Colombia Compra Eficiente actualiza al re-publicar un proceso.
DATE_ORDER_COLUMN = "fecha_de_ultima_publicaci"
DATE_SELECT_COLUMN = "fecha_de_publicacion_del"


@dataclass
class ExtractResult:
    fetched: int = 0
    inserted: int = 0
    updated: int = 0


def row_to_dict(row: dict[str, Any]) -> dict[str, Any] | None:
    """Normaliza una fila de Socrata a columnas del modelo."""
    ident = socrata_text(row.get("id_del_proceso"))
    if not ident:
        return None
    out: dict[str, Any] = {}
    for src, dst in SELECT_COLUMNS:
        if dst in _INT_FIELDS:
            out[dst] = socrata_int(row.get(src))
        elif dst in _FLOAT_FIELDS:
            out[dst] = socrata_float(row.get(src))
        elif dst in _DATE_FIELDS:
            out[dst] = socrata_datetime(row.get(src))
        elif dst in _URL_FIELDS:
            out[dst] = socrata_url(row.get(src))
        else:
            out[dst] = socrata_text(row.get(src))
    out["origen"] = "socrata"
    # Clave de union con los contratos (ver `socrata.notice_uid`).
    out["notice_uid"] = notice_uid(out.get("url_proceso"))
    return fit_to_model(Tender, out)


def _to_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload = []
    for row in rows:
        mapped = row_to_dict(row)
        if mapped:
            payload.append(mapped)
    return payload


def fetch_tenders(
    client: SocrataClient,
    since: datetime,
    until: datetime | None = None,
    max_rows: int | None = None,
) -> list[dict[str, Any]]:
    """Descarga filas crudas del dataset de procesos.

    `fecha_de_ultima_publicaci` es `calendar_date`: se filtra por dia, no por
    instante, para no caer en ventanas vacias por la granularidad.
    """
    where = socrata_where_date(DATE_ORDER_COLUMN, since, until)
    log.info("GET %s where=%s max_rows=%s", settings.dataset_procesos, where, max_rows)
    rows = list(
        client.iter_rows(
            dataset=settings.dataset_procesos,
            where=where,
            order=f"{DATE_SELECT_COLUMN} DESC",
            max_rows=max_rows,
            select=SELECT_EXPR,
        )
    )
    log.info("%s devolvio %d filas", settings.dataset_procesos, len(rows))
    return rows


def upsert_tenders(session: Session, payload: list[dict[str, Any]]) -> ExtractResult:
    """Inserta o actualiza por `id_del_proceso`, en lotes que quepan en Postgres."""
    if not payload:
        return ExtractResult(fetched=0)
    insertadas, actualizadas = bulk_upsert(session, Tender, payload, "id_del_proceso")
    return ExtractResult(fetched=len(payload), inserted=insertadas, updated=actualizadas)


def sync_procesos(
    session: Session,
    client: SocrataClient,
    since: datetime,
    until: datetime | None = None,
    max_rows: int | None = None,
) -> ExtractResult:
    rows = fetch_tenders(client, since=since, until=until, max_rows=max_rows)
    return upsert_tenders(session, _to_payload(rows))
