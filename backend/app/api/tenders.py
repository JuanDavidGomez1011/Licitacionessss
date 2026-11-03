"""Rutas de licitaciones: listado filtrable ordenado por score, detalle y acciones."""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Select, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.ai.embedder import cosine_similarity, vector_to_list
from app.ai.matchmaker import rescore_tender
from app.ai.ollama_client import OllamaClient
from app.config import settings
from app.db import get_db
from app.models import Match, Tender, TenderAction
from app.ocds import tender_to_ocds
from app.schemas import ActionOut, ActionRequest, MatchOut, Opportunity, OpportunityPage

log = logging.getLogger(__name__)
router = APIRouter(prefix="/licitaciones", tags=["licitaciones"])


def _base_query() -> Select:
    return (
        select(Tender, Match, TenderAction)
        .join(Match, Match.tender_id == Tender.id_del_proceso, isouter=True)
        .outerjoin(TenderAction, TenderAction.tender_id == Tender.id_del_proceso)
    )


def _dias_restantes(t: Tender) -> int | None:
    if not t.fecha_apertura_respuesta:
        return None
    limite = t.fecha_apertura_respuesta
    if limite.tzinfo is None:
        limite = limite.replace(tzinfo=dt.timezone.utc)
    return (limite - dt.datetime.now(dt.timezone.utc)).days


def _to_opportunity(t: Tender, m: Match | None, a: TenderAction | None) -> Opportunity:
    return Opportunity(
        id_del_proceso=t.id_del_proceso,
        referencia_del_proceso=t.referencia_del_proceso,
        titulo=t.nombre_del_procedimiento,
        entidad=t.entidad,
        departamento=t.departamento_entidad,
        ciudad=t.ciudad_entidad,
        descripcion=(t.descripcion or t.objeto_contrato or "")[:600] or None,
        precio_base=t.precio_base,
        modalidad=t.modalidad_de_contratacion,
        estado=t.estado_del_procedimiento,
        categoria=t.codigo_principal_categoria,
        lotes=t.numero_de_lotes,
        fecha_publicacion=t.fecha_publicacion,
        fecha_apertura_respuesta=t.fecha_apertura_respuesta,
        dias_restantes=_dias_restantes(t),
        url_proceso=t.url_proceso,
        match=MatchOut.model_validate(m) if m else None,
        acciones=[a.accion] if a else [],
    )


@router.get("", response_model=OpportunityPage)
def listar(
    db: Session = Depends(get_db),
    q: str | None = Query(default=None, description="texto libre sobre objeto y descripcion"),
    score_min: int = Query(default=settings.score_min_threshold, ge=0, le=100),
    score_max: int = Query(default=100, ge=0, le=100),
    entidades: str | None = None,
    departamentos: str | None = None,
    modalidades: str | None = None,
    estados: str | None = None,
    solo_con_match: bool = True,
    excluir_ocultas: bool = True,
    excluir_descartadas: bool = True,
    solo_guardadas: bool = False,
    solo_por_vencer: bool = False,
    dias_por_vencer: int | None = Query(default=None, ge=0, le=365),
    precio_min: float | None = Query(default=None, ge=0),
    precio_max: float | None = Query(default=None, ge=0),
    desde: dt.date | None = Query(default=None, description="fecha minima de publicacion"),
    hasta: dt.date | None = Query(default=None, description="fecha maxima de publicacion"),
    order_by: str = Query(default="score", pattern="^(score|fecha|precio)$"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> OpportunityPage:
    """Panel principal: oportunidades ordenadas de mayor a menor score."""
    stmt = _base_query()
    where: list[Any] = []

    if solo_con_match:
        where.append(Match.tender_id.isnot(None))
    if score_min > 0 or score_max < 100:
        where.append(Match.score.between(score_min, score_max))
    if q:
        pat = f"%{q.strip()}%"
        where.append(
            or_(
                Tender.nombre_del_procedimiento.ilike(pat),
                Tender.descripcion.ilike(pat),
                Tender.objeto_contrato.ilike(pat),
                Tender.entidad.ilike(pat),
            )
        )
    for column, raw in (
        (Tender.entidad, entidades),
        (Tender.departamento_entidad, departamentos),
        (Tender.modalidad_de_contratacion, modalidades),
        (Tender.estado_del_procedimiento, estados),
    ):
        clause = _in_csv(column, raw)
        if clause is not None:
            where.append(clause)

    if precio_min is not None:
        where.append(Tender.precio_base >= precio_min)
    if precio_max is not None:
        where.append(Tender.precio_base <= precio_max)
    if desde:
        where.append(Tender.fecha_publicacion >= _naive(desde))
    if hasta:
        where.append(Tender.fecha_publicacion < _naive(hasta + dt.timedelta(days=1)))
    if solo_por_vencer and dias_por_vencer is not None:
        limite = _naive(dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=dias_por_vencer))
        where.append(Tender.fecha_apertura_respuesta.isnot(None))
        where.append(Tender.fecha_apertura_respuesta >= limite)

    if excluir_ocultas:
        where.append(
            ~Tender.id_del_proceso.in_(
                select(TenderAction.tender_id).where(TenderAction.accion == "ocultar")
            )
        )
    if excluir_descartadas:
        where.append(
            ~Tender.id_del_proceso.in_(
                select(TenderAction.tender_id).where(TenderAction.accion == "descartar")
            )
        )
    if solo_guardadas:
        where.append(
            Tender.id_del_proceso.in_(
                select(TenderAction.tender_id).where(TenderAction.accion == "guardar")
            )
        )

    if where:
        stmt = stmt.where(*where)

    order = {
        "score": (Match.score.desc().nullslast(), Tender.fecha_publicacion.desc().nullslast()),
        "fecha": (Tender.fecha_publicacion.desc().nullslast(), Match.score.desc().nullslast()),
        "precio": (Tender.precio_base.desc().nullslast(), Match.score.desc().nullslast()),
    }[order_by]
    stmt = stmt.order_by(*order)

    count_stmt = (
        select(func.count())
        .select_from(Tender)
        .outerjoin(Match, Match.tender_id == Tender.id_del_proceso)
    )
    if where:
        count_stmt = count_stmt.where(*where)
    total = db.execute(count_stmt).scalar() or 0

    rows = db.execute(stmt.limit(limit).offset(offset)).all()
    items = [_to_opportunity(t, m, a) for t, m, a in rows]

    return OpportunityPage(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        generado_en=dt.datetime.now(dt.timezone.utc),
    )


def _naive(value: dt.date | dt.datetime) -> dt.datetime:
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    return dt.datetime(value.year, value.month, value.day, tzinfo=dt.timezone.utc)


def _get_tender(db: Session, id_proceso: str) -> Tender:
    """Busca por la clave natural (`id_del_proceso`), no por el pk interno."""
    tender = db.execute(
        select(Tender).where(Tender.id_del_proceso == id_proceso)
    ).scalar_one_or_none()
    if tender is None:
        raise HTTPException(404, f"licitacion {id_proceso} no encontrada")
    return tender


def _in_csv(column: Any, raw: str | None) -> Any:
    """`Bogota D.C.,Antioquia` -> OR de comparaciones case-insensitive exactas.

    Se compara con `lower()` en lugar de `ilike` para que un valor con
    comodines coming del usuario no se interprete como patron SQL.
    """
    if not raw:
        return None
    values = [v.strip() for v in raw.split(",") if v.strip()]
    if not values:
        return None
    return or_(*[func.lower(column) == v.lower() for v in values])


@router.get("/facetas")
def facetas(
    score_min: int = Query(default=0, ge=0, le=100),
    solo_con_match: bool = True,
    limite: int = Query(default=25, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Valores distintos de los filtros, con su conteo, para poblar los desplegables.

    Se declara antes de `/{id_proceso}` a proposito: FastAPI resuelve en orden de
    declaracion y `facetas` seria capturado como `id_proceso`.
    """
    base = select(Tender)
    if solo_con_match:
        base = base.join(Match, Match.tender_id == Tender.id_del_proceso)
    if score_min > 0:
        base = base.where(Match.score >= score_min)
    sub = base.subquery()

    def valores(column: Any) -> list[dict[str, Any]]:
        col = sub.c[column.key]
        stmt = (
            select(col, func.count())
            .select_from(sub)
            .where(col.isnot(None))
            .group_by(col)
            .order_by(func.count().desc())
            .limit(limite)
        )
        return [{"valor": str(v), "n": int(n)} for v, n in db.execute(stmt).all()]

    rango = db.execute(
        select(func.min(sub.c["precio_base"]), func.max(sub.c["precio_base"])).select_from(sub)
    ).one()

    return {
        "entidades": valores(Tender.entidad),
        "departamentos": valores(Tender.departamento_entidad),
        "modalidades": valores(Tender.modalidad_de_contratacion),
        "estados": valores(Tender.estado_del_procedimiento),
        "categorias": valores(Tender.codigo_principal_categoria),
        "precio_min": rango[0],
        "precio_max": rango[1],
        "total": db.execute(select(func.count()).select_from(sub)).scalar() or 0,
    }


@router.get("/{id_proceso}")
def detalle(id_proceso: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = _get_tender(db, id_proceso)
    match = db.execute(select(Match).where(Match.tender_id == id_proceso)).scalar_one_or_none()
    acciones = db.execute(
        select(TenderAction).where(TenderAction.tender_id == id_proceso)
    ).scalars().all()
    contratos = [
        {
            "id_contrato": c.id_contrato,
            "valor": c.valor_del_contrato,
            "fecha_firma": c.fecha_de_firma.isoformat() if c.fecha_de_firma else None,
            "proveedor": c.proveedor_adjudicado,
            "estado": c.estado_contrato,
        }
        for c in t.contracts[:5]
    ]
    return {
        "licitacion": _to_opportunity(t, match, acciones[0] if acciones else None).model_dump(mode="json"),
        "match": MatchOut.model_validate(match).model_dump(mode="json") if match else None,
        "acciones": [ActionOut.model_validate(a).model_dump(mode="json") for a in acciones],
        "contratos": contratos,
        "ocds": tender_to_ocds(t),
    }


@router.post("/{id_proceso}/recalcular")
def recalcular(id_proceso: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = _get_tender(db, id_proceso)
    with OllamaClient() as embedder, OllamaClient() as llm:
        result = rescore_tender(db, embedder, llm, t)
    if result is None:
        raise HTTPException(400, "no hay perfil de empresa configurado")
    db.commit()
    return {"ok": True, "match": result}


@router.post("/{id_proceso}/accion", response_model=list[ActionOut])
def accion(id_proceso: str, body: ActionRequest, db: Session = Depends(get_db)) -> list[ActionOut]:
    """Registra ocultar / descartar / guardar / restaurar.

    Es idempotente: `tender_actions` tiene unique en `(tender_id, accion)`, asi que
    repetir la misma accion hace upsert en vez de reventar el INSERT. Guardar dos
    veces la misma licitacion es el caso normal de la UI (el boton se puede pulsar
    de nuevo al recargar la lista).
    """
    _get_tender(db, id_proceso)

    if body.accion == "restaurar":
        db.execute(
            delete(TenderAction).where(
                TenderAction.tender_id == id_proceso,
                TenderAction.accion.in_(["ocultar", "descartar"]),
            )
        )
    else:
        db.execute(
            delete(TenderAction).where(
                TenderAction.tender_id == id_proceso,
                TenderAction.accion.in_(["ocultar", "descartar"]),
            )
        )
        now = dt.datetime.now(dt.timezone.utc)
        stmt = pg_insert(TenderAction).values(
            tender_id=id_proceso, accion=body.accion, nota=body.nota, created_at=now
        )
        db.execute(
            stmt.on_conflict_do_update(
                index_elements=["tender_id", "accion"],
                set_={"nota": body.nota, "created_at": now},
            )
        )
    db.commit()

    return list(
        db.execute(select(TenderAction).where(TenderAction.tender_id == id_proceso)).scalars()
    )


@router.get("/similares/{id_proceso}")
def similares(
    id_proceso: str,
    limite: int = Query(default=5, ge=1, le=50),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Licitaciones parecidas por similitud coseno de sus embeddings (pgvector)."""
    origen = db.execute(select(Match).where(Match.tender_id == id_proceso)).scalar_one_or_none()
    if origen is None or not origen.embedding:
        raise HTTPException(400, "la licitacion no tiene embedding calculado")

    vector = vector_to_list(origen.embedding)
    base = db.execute(
        select(Tender, Match).join(Match, Match.tender_id == Tender.id_del_proceso)
    ).all()
    scored = [
        (_cos(vector, m.embedding), t, m)
        for t, m in base
        if m.tender_id != id_proceso and m.embedding
    ]
    scored.sort(key=lambda x: x[0], reverse=True)
    return {
        "items": [
            {"similitud": round(sim, 4), "oportunidad": _to_opportunity(t, m, None).model_dump(mode="json")}
            for sim, t, m in scored[:limite]
        ]
    }


def _cos(a: list[float] | None, b: Any) -> float:
    return cosine_similarity(a, vector_to_list(b))

