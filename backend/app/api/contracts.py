"""Rutas de contratos ya adjudicados (contratados)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Contract, Match, Tender
from app.ocds import contract_to_ocds
from app.schemas import TenderOut

router = APIRouter(prefix="/contratos", tags=["contratos"])


@router.get("")
def listar(
    db: Session = Depends(get_db),
    q: str | None = None,
    entidades: str | None = None,
    departamentos: str | None = None,
    estados: str | None = None,
    es_pyme: bool | None = None,
    con_proceso: bool = False,
    valor_min: float | None = Query(default=None, ge=0),
    valor_max: float | None = Query(default=None, ge=0),
    desde: dt.date | None = None,
    hasta: dt.date | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    stmt = select(Contract)
    conds: list[Any] = []

    if q:
        pat = f"%{q.strip()}%"
        conds.append(
            or_(
                Contract.objeto_del_contrato.ilike(pat),
                Contract.descripcion_del_proceso.ilike(pat),
                Contract.nombre_entidad.ilike(pat),
                Contract.proveedor_adjudicado.ilike(pat),
            )
        )
    if entidades:
        conds.append(func.lower(Contract.nombre_entidad).in_([e.strip().lower() for e in entidades.split(",") if e.strip()]))
    if departamentos:
        conds.append(func.lower(Contract.departamento).in_([d.strip().lower() for d in departamentos.split(",") if d.strip()]))
    if estados:
        conds.append(func.lower(Contract.estado_contrato).in_([e.strip().lower() for e in estados.split(",") if e.strip()]))
    if es_pyme is not None:
        conds.append(Contract.es_pyme == ("Sí" if es_pyme else "No"))
    if con_proceso:
        conds.append(Contract.proceso_id.isnot(None))
    if valor_min is not None:
        conds.append(Contract.valor_del_contrato >= valor_min)
    if valor_max is not None:
        conds.append(Contract.valor_del_contrato <= valor_max)
    if desde:
        conds.append(Contract.fecha_de_firma >= _naive(desde))
    if hasta:
        conds.append(Contract.fecha_de_firma < _naive(hasta + dt.timedelta(days=1)))

    if conds:
        stmt = stmt.where(*conds)
    stmt = stmt.order_by(Contract.fecha_de_firma.desc().nullslast()).limit(limit).offset(offset)

    total_stmt = select(func.count()).select_from(Contract)
    if conds:
        total_stmt = total_stmt.where(*conds)
    total = db.execute(total_stmt).scalar() or 0

    rows = db.execute(stmt).scalars().all()
    return {
        "items": [
            {
                "id_contrato": c.id_contrato,
                "proceso_de_compra": c.proceso_id,
                "entidad": c.nombre_entidad,
                "departamento": c.departamento,
                "ciudad": c.ciudad,
                "objeto": c.objeto_del_contrato or c.descripcion_del_proceso,
                "valor": c.valor_del_contrato,
                "valor_pagado": c.valor_pagado,
                "proveedor": c.proveedor_adjudicado,
                "es_pyme": c.es_pyme,
                "estado": c.estado_contrato,
                "fecha_firma": c.fecha_de_firma.isoformat() if c.fecha_de_firma else None,
                "fecha_inicio": c.fecha_de_inicio.isoformat() if c.fecha_de_inicio else None,
                "fecha_fin": c.fecha_de_fin.isoformat() if c.fecha_de_fin else None,
                "url": c.urlproceso,
            }
            for c in rows
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def _naive(value: dt.date | dt.datetime) -> dt.datetime:
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    return dt.datetime(value.year, value.month, value.day, tzinfo=dt.timezone.utc)


@router.get("/estadisticas")
def estadisticas(db: Session = Depends(get_db)) -> dict[str, Any]:
    por_depto = db.execute(
        select(Contract.departamento, func.count(), func.sum(Contract.valor_del_contrato))
        .group_by(Contract.departamento)
        .order_by(func.count().desc())
        .limit(15)
    ).all()
    por_modalidad = db.execute(
        select(Contract.modalidad_de_contratacion, func.count(), func.sum(Contract.valor_del_contrato))
        .group_by(Contract.modalidad_de_contratacion)
        .order_by(func.count().desc())
        .limit(15)
    ).all()
    por_proveedor = db.execute(
        select(Contract.proveedor_adjudicado, func.count(), func.sum(Contract.valor_del_contrato))
        .where(Contract.proveedor_adjudicado.isnot(None))
        .group_by(Contract.proveedor_adjudicado)
        .order_by(func.sum(Contract.valor_del_contrato).desc().nullslast())
        .limit(15)
    ).all()
    total = db.execute(select(func.sum(Contract.valor_del_contrato))).scalar() or 0
    return {
        "valor_total": round(float(total), 2),
        "por_departamento": [
            {"departamento": d, "contratos": n, "valor": round(float(v or 0), 2)} for d, n, v in por_depto
        ],
        "por_modalidad": [
            {"modalidad": m, "contratos": n, "valor": round(float(v or 0), 2)} for m, n, v in por_modalidad
        ],
        "por_proveedor": [
            {"proveedor": p, "contratos": n, "valor": round(float(v or 0), 2)} for p, n, v in por_proveedor
        ],
    }


@router.get("/{id_contrato}")
def detalle(id_contrato: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = db.get(Contract, id_contrato)
    if c is None:
        raise HTTPException(404, f"contrato {id_contrato} no encontrado")
    proceso = None
    match = None
    if c.proceso_id:
        t = db.get(Tender, c.proceso_id)
        if t is not None:
            proceso = TenderOut.model_validate(t).model_dump(mode="json")
            match = db.execute(select(Match).where(Match.tender_id == t.id_del_proceso)).scalar_one_or_none()
    return {
        "contrato": {
            "id_contrato": c.id_contrato,
            "referencia": c.referencia_del_contrato,
            "entidad": c.nombre_entidad,
            "nit_entidad": c.nit_entidad,
            "departamento": c.departamento,
            "ciudad": c.ciudad,
            "localizacion": c.localizacion,
            "objeto": c.objeto_del_contrato,
            "descripcion": c.descripcion_del_proceso,
            "valor": c.valor_del_contrato,
            "valor_pagado": c.valor_pagado,
            "valor_facturado": c.valor_facturado,
            "proveedor": c.proveedor_adjudicado,
            "es_pyme": c.es_pyme,
            "estado": c.estado_contrato,
            "fecha_firma": c.fecha_de_firma.isoformat() if c.fecha_de_firma else None,
            "fecha_inicio": c.fecha_de_inicio.isoformat() if c.fecha_de_inicio else None,
            "fecha_fin": c.fecha_de_fin.isoformat() if c.fecha_de_fin else None,
            "url": c.urlproceso,
        },
        "proceso": proceso,
        "score": match.score if match else None,
        "ocds": contract_to_ocds(c),
    }
