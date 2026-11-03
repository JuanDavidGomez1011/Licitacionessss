"""Extractor de 'SECOP II - Contratos Electronicos' (Socrata `jbjy-vk9h`).

Los contratos se relacionan con los procesos via `proceso_de_compra`, por lo que
la ingesta primero asegura que exista el tender correspondiente.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.ingest.socrata import (
    SocrataClient,
    fit_to_model,
    notice_uid,
    socrata_datetime,
    socrata_float,
    socrata_text,
    socrata_url,
    socrata_where_date,
)
from app.ingest.upsert import _chunks, bulk_upsert
from app.models import Contract, Tender

log = logging.getLogger(__name__)

SELECT_COLUMNS: list[tuple[str, str]] = [
    ("id_contrato", "id_contrato"),
    ("proceso_de_compra", "proceso_de_compra"),
    ("referencia_del_contrato", "referencia_del_contrato"),
    ("nombre_entidad", "nombre_entidad"),
    ("nit_entidad", "nit_entidad"),
    ("departamento", "departamento"),
    ("ciudad", "ciudad"),
    ("localizaci_n", "localizacion"),
    ("estado_contrato", "estado_contrato"),
    ("descripcion_del_proceso", "descripcion_del_proceso"),
    ("objeto_del_contrato", "objeto_del_contrato"),
    ("valor_del_contrato", "valor_del_contrato"),
    ("valor_pagado", "valor_pagado"),
    ("valor_facturado", "valor_facturado"),
    ("valor_pendiente_de_pago", "valor_pendiente_de_pago"),
    ("fecha_de_firma", "fecha_de_firma"),
    ("fecha_de_inicio_del_contrato", "fecha_de_inicio"),
    ("fecha_de_fin_del_contrato", "fecha_de_fin"),
    ("tipo_de_contrato", "tipo_de_contrato"),
    ("modalidad_de_contratacion", "modalidad_de_contratacion"),
    ("proveedor_adjudicado", "proveedor_adjudicado"),
    ("es_pyme", "es_pyme"),
    ("codigo_de_categoria_principal", "codigo_de_categoria_principal"),
    ("urlproceso", "urlproceso"),
    ("ultima_actualizacion", "ultima_actualizacion"),
]

_FLOAT_FIELDS = {"valor_del_contrato", "valor_pagado", "valor_facturado", "valor_pendiente_de_pago"}
_DATE_FIELDS = {"fecha_de_firma", "fecha_de_inicio", "fecha_de_fin", "ultima_actualizacion"}
_URL_FIELDS = {"urlproceso"}

SELECT_EXPR = ",".join(src for src, _ in SELECT_COLUMNS)
DATE_ORDER_COLUMN = "fecha_de_firma"


@dataclass
class ExtractResult:
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    orphans: int = 0


def row_to_dict(row: dict[str, Any]) -> dict[str, Any] | None:
    ident = socrata_text(row.get("id_contrato"))
    if not ident:
        return None
    out: dict[str, Any] = {}
    for src, dst in SELECT_COLUMNS:
        if dst in _FLOAT_FIELDS:
            out[dst] = socrata_float(row.get(src))
        elif dst in _DATE_FIELDS:
            out[dst] = socrata_datetime(row.get(src))
        elif dst in _URL_FIELDS:
            out[dst] = socrata_url(row.get(src))
        else:
            out[dst] = socrata_text(row.get(src))
    # El enlace con el proceso no puede ir por `proceso_de_compra`: aqui SECOP
    # publica ids `CO1.PCCNTR.*` y en procesos son `CO1.REQ.*`, asi que no
    # casa nunca. La clave comun es el noticeUID de la URL.
    out["notice_uid"] = notice_uid(out.get("urlproceso"))
    return fit_to_model(Contract, out)


def fetch_contracts(
    client: SocrataClient,
    since: datetime,
    until: datetime | None = None,
    max_rows: int | None = None,
) -> list[dict[str, Any]]:
    where = socrata_where_date(DATE_ORDER_COLUMN, since, until)
    log.info("GET %s where=%s max_rows=%s", settings.dataset_contratos, where, max_rows)
    rows = list(
        client.iter_rows(
            dataset=settings.dataset_contratos,
            where=where,
            order=f"{DATE_ORDER_COLUMN} DESC",
            max_rows=max_rows,
            select=SELECT_EXPR,
        )
    )
    log.info("jbjy-vk9h devolvio %d filas", len(rows))
    return rows


def attach_known_tenders(session: Session, payload: list[dict[str, Any]]) -> int:
    """Resuelve la FK `proceso_id` cruzando `notice_uid`, y cuenta los huerfanos.

    Antes esto cruzaba `proceso_de_compra` contra `tenders.id_del_proceso`, lo
    cual no puede funcionar: SECOP publica `CO1.PCCNTR.*` en el dataset de
    contratos y `CO1.REQ.*` en el de procesos, asi que el resultado era siempre
    0% enlazado (75.434 huerfanos de 75.434). La clave que si comparten es el
    `noticeUID=CO1.NTC.*` que va dentro de la URL de OpportunityDetail.

    La busqueda va troceada: un `IN (...)` con todas las claves de la ventana
    excede el tope de 65.535 bind params de Postgres igual que el INSERT (ver
    `app.ingest.upsert`).
    """
    uids = {p["notice_uid"] for p in payload if p.get("notice_uid")}
    if not uids:
        return 0

    # notice_uid -> id_del_proceso, en trozas por el tope de bind params.
    known: dict[str, str] = {}
    for trozo in _chunks(sorted(uids), 20_000):
        filas = session.execute(
            select(Tender.notice_uid, Tender.id_del_proceso).where(Tender.notice_uid.in_(trozo))
        ).all()
        known.update({uid: ident for uid, ident in filas if uid})

    orphans = 0
    for p in payload:
        link = known.get(p.get("notice_uid") or "")
        p["proceso_id"] = link
        if not link:
            orphans += 1
    log.info(
        "contratos: %d enlazados a un proceso por noticeUID, %d sin proceso en la ventana",
        len(payload) - orphans, orphans,
    )
    return orphans


def upsert_contracts(session: Session, payload: list[dict[str, Any]]) -> ExtractResult:
    if not payload:
        return ExtractResult()
    orphans = attach_known_tenders(session, payload)
    insertadas, actualizadas = bulk_upsert(session, Contract, payload, "id_contrato")
    return ExtractResult(
        fetched=len(payload),
        inserted=insertadas,
        updated=actualizadas,
        orphans=orphans,
    )


def sync_contratos(
    session: Session,
    client: SocrataClient,
    since: datetime,
    until: datetime | None = None,
    max_rows: int | None = None,
) -> ExtractResult:
    rows = fetch_contracts(client, since=since, until=until, max_rows=max_rows)
    payload = [m for m in (row_to_dict(r) for r in rows) if m]
    return upsert_contracts(session, payload)
