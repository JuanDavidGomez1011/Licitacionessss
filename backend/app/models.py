"""Modelos ORM. El esquema sigue la estructura de OCDS: `tender`, `award`, `organization`."""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Tender(Base, TimestampMixin):
    """SECOP II - Procesos de Contratacion (dataset p6dx-8zbt)."""

    __tablename__ = "tenders"

    pk: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    id_del_proceso: Mapped[str] = mapped_column(String(80), unique=True, index=True, nullable=False)
    referencia_del_proceso: Mapped[str | None] = mapped_column(String(120), index=True)

    # --- organization ---
    entidad: Mapped[str | None] = mapped_column(String(400), index=True)
    nit_entidad: Mapped[str | None] = mapped_column(String(40), index=True)
    departamento_entidad: Mapped[str | None] = mapped_column(String(120), index=True)
    ciudad_entidad: Mapped[str | None] = mapped_column(String(120), index=True)

    # --- contenido (base para la IA) ---
    nombre_del_procedimiento: Mapped[str | None] = mapped_column(Text)
    descripcion: Mapped[str | None] = mapped_column(Text)
    objeto_contrato: Mapped[str | None] = mapped_column(Text)

    # --- valor y condiciones ---
    precio_base: Mapped[float | None] = mapped_column(Float)
    modalidad_de_contratacion: Mapped[str | None] = mapped_column(String(200), index=True)
    justificacion_modalidad: Mapped[str | None] = mapped_column(Text)
    duracion: Mapped[int | None] = mapped_column(Integer)
    unidad_de_duracion: Mapped[str | None] = mapped_column(String(60))
    numero_de_lotes: Mapped[int | None] = mapped_column(Integer)

    # --- clasificacion UNSPSC ---
    codigo_principal_categoria: Mapped[str | None] = mapped_column(String(80), index=True)
    categorias_adicionales: Mapped[str | None] = mapped_column(Text)

    # --- estado y fechas (OCDS: status / tenderPeriod) ---
    estado_del_procedimiento: Mapped[str | None] = mapped_column(String(80), index=True)
    adjudicado: Mapped[str | None] = mapped_column(String(20))
    fecha_publicacion: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    fecha_recepcion: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    fecha_apertura_respuesta: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    tipo_contrato: Mapped[str | None] = mapped_column(String(120))
    subtipo_contrato: Mapped[str | None] = mapped_column(String(120))
    url_proceso: Mapped[str | None] = mapped_column(Text)
    # Clave de union con contratos: los dos datasets comparten el noticeUID de
    # la URL, no el id (`CO1.REQ.*` en procesos, `CO1.PCCNTR.*` en contratos).
    notice_uid: Mapped[str | None] = mapped_column(String(40), index=True)
    estado_resumen: Mapped[str | None] = mapped_column(String(80))
    fecha_ultima_publicacion: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    origen: Mapped[str] = mapped_column(String(40), default="socrata")

    matches: Mapped[list["Match"]] = relationship(
        back_populates="tender", cascade="all, delete-orphan", uselist=False
    )
    actions: Mapped[list["TenderAction"]] = relationship(
        back_populates="tender", cascade="all, delete-orphan"
    )
    contracts: Mapped[list["Contract"]] = relationship(back_populates="tender")

    __table_args__ = (
        Index("ix_tenders_score_recent", "fecha_publicacion"),
        Index("ix_tenders_entidad_depto", "entidad", "departamento_entidad"),
    )


class Contract(Base, TimestampMixin):
    """SECOP II - Contratos Electronicos (dataset jbjy-vk9h)."""

    __tablename__ = "contracts"

    pk: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    id_contrato: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    # 600, no 160: hay 181 filas en el dataset oficial que meten aqui el objeto
    # completo del contrato ("PRESTAR APOYO TECNICO PARA LA RECOPILACION ...").
    # Con 160 Postgres abortaba la ingesta entera con
    # `value too long for type character varying(160)`. Ver `socrata.fit_to_model`.
    referencia_del_contrato: Mapped[str | None] = mapped_column(String(600), index=True)

    # Valor tal cual lo publica SECOP (`CO1.PCCNTR.*`): no es una FK a tenders.
    proceso_de_compra: Mapped[str | None] = mapped_column(String(40), index=True)
    # FK real al proceso, resuelta cruzando `notice_uid` (ver `socrata.notice_uid`).
    proceso_id: Mapped[str | None] = mapped_column(
        String(80), ForeignKey("tenders.id_del_proceso", ondelete="SET NULL"), index=True
    )
    notice_uid: Mapped[str | None] = mapped_column(String(40), index=True)

    nombre_entidad: Mapped[str | None] = mapped_column(String(400), index=True)
    nit_entidad: Mapped[str | None] = mapped_column(String(40))
    departamento: Mapped[str | None] = mapped_column(String(120), index=True)
    ciudad: Mapped[str | None] = mapped_column(String(120), index=True)
    localizacion: Mapped[str | None] = mapped_column(Text)

    estado_contrato: Mapped[str | None] = mapped_column(String(80), index=True)
    descripcion_del_proceso: Mapped[str | None] = mapped_column(Text)
    objeto_del_contrato: Mapped[str | None] = mapped_column(Text)

    valor_del_contrato: Mapped[float | None] = mapped_column(Float)
    valor_pagado: Mapped[float | None] = mapped_column(Float)
    valor_facturado: Mapped[float | None] = mapped_column(Float)
    valor_pendiente_de_pago: Mapped[float | None] = mapped_column(Float)

    fecha_de_firma: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    fecha_de_inicio: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    fecha_de_fin: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    tipo_de_contrato: Mapped[str | None] = mapped_column(String(160))
    modalidad_de_contratacion: Mapped[str | None] = mapped_column(String(200), index=True)
    proveedor_adjudicado: Mapped[str | None] = mapped_column(String(400))
    es_pyme: Mapped[str | None] = mapped_column(String(20))
    codigo_de_categoria_principal: Mapped[str | None] = mapped_column(String(80), index=True)
    urlproceso: Mapped[str | None] = mapped_column(Text)
    ultima_actualizacion: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    tender: Mapped[Tender | None] = relationship(back_populates="contracts")

    __table_args__ = (Index("ix_contracts_entidad_fecha", "nombre_entidad", "fecha_de_firma"),)


class Match(Base):
    """Resultado del 'Matchmaker': score 0-100 + resumen de 3 vinetas."""

    __tablename__ = "matches"

    pk: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tender_id: Mapped[str] = mapped_column(
        String(80), ForeignKey("tenders.id_del_proceso", ondelete="CASCADE"), index=True, nullable=False
    )
    score: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    bullets: Mapped[list[str]] = mapped_column(JSONB, default=list)
    rationale: Mapped[str | None] = mapped_column(Text)
    matched_keywords: Mapped[list[str]] = mapped_column(JSONB, default=list)
    gaps: Mapped[list[str]] = mapped_column(JSONB, default=list)
    semantic_similarity: Mapped[float | None] = mapped_column(Float, index=True)
    embedding: Mapped[Any] = mapped_column(JSONB, nullable=True)
    model: Mapped[str] = mapped_column(String(80), default="")
    profile_version: Mapped[int] = mapped_column(Integer, default=1)
    scored_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    tender: Mapped[Tender] = relationship(back_populates="matches")

    __table_args__ = (UniqueConstraint("tender_id", name="uq_matches_tender"),)


class TenderAction(Base):
    """Acciones del usuario: descartar / ocultar / guardar."""

    __tablename__ = "tender_actions"

    pk: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tender_id: Mapped[str] = mapped_column(
        String(80), ForeignKey("tenders.id_del_proceso", ondelete="CASCADE"), index=True, nullable=False
    )
    accion: Mapped[str] = mapped_column(String(20), index=True, nullable=False)
    nota: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    tender: Mapped[Tender] = relationship(back_populates="actions")

    __table_args__ = (UniqueConstraint("tender_id", "accion", name="uq_tender_action"),)


class CompanyProfile(Base, TimestampMixin):
    """Perfil de empresa contra el que se calcula la compatibilidad."""

    __tablename__ = "company_profile"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    version: Mapped[int] = mapped_column(Integer, default=1)
    nombre: Mapped[str] = mapped_column(String(200), default="Mi Empresa")
    descripcion: Mapped[str] = mapped_column(Text, default="")
    actividades: Mapped[list[str]] = mapped_column(JSONB, default=list)
    palabras_clave: Mapped[list[str]] = mapped_column(JSONB, default=list)
    exclusiones: Mapped[list[str]] = mapped_column(JSONB, default=list)
    modalidades_preferidas: Mapped[list[str]] = mapped_column(JSONB, default=list)
    departamentos_preferidos: Mapped[list[str]] = mapped_column(JSONB, default=list)
    presupuesto_minimo: Mapped[float | None] = mapped_column(Float)
    presupuesto_maximo: Mapped[float | None] = mapped_column(Float)
    activo: Mapped[bool] = mapped_column(Boolean, default=True)
    embedding: Mapped[Any] = mapped_column(JSONB, nullable=True)


class SyncRun(Base):
    """Traza de cada ejecucion de sincronizacion."""

    __tablename__ = "sync_runs"

    pk: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dataset: Mapped[str] = mapped_column(String(120), index=True)
    status: Mapped[str] = mapped_column(String(20), index=True, default="running")
    started_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    rows_fetched: Mapped[int] = mapped_column(Integer, default=0)
    rows_inserted: Mapped[int] = mapped_column(Integer, default=0)
    rows_updated: Mapped[int] = mapped_column(Integer, default=0)
    scored: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
