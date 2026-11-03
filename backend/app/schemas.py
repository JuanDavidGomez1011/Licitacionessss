"""Schemas de entrada/salida de la API."""

from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TenderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id_del_proceso: str
    referencia_del_proceso: str | None = None
    entidad: str | None = None
    nit_entidad: str | None = None
    departamento_entidad: str | None = None
    ciudad_entidad: str | None = None
    nombre_del_procedimiento: str | None = None
    descripcion: str | None = None
    precio_base: float | None = None
    modalidad_de_contratacion: str | None = None
    justificacion_modalidad: str | None = None
    duracion: int | None = None
    unidad_de_duracion: str | None = None
    numero_de_lotes: int | None = None
    codigo_principal_categoria: str | None = None
    estado_del_procedimiento: str | None = None
    adjudicado: str | None = None
    fecha_publicacion: dt.datetime | None = None
    fecha_recepcion: dt.datetime | None = None
    fecha_apertura_respuesta: dt.datetime | None = None
    tipo_contrato: str | None = None
    subtipo_contrato: str | None = None
    url_proceso: str | None = None


class MatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    score: int
    bullets: list[str] = Field(default_factory=list)
    rationale: str | None = None
    matched_keywords: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    semantic_similarity: float | None = None
    model: str | None = None
    scored_at: dt.datetime | None = None


class ActionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    accion: str
    nota: str | None = None
    created_at: dt.datetime | None = None


class Opportunity(BaseModel):
    """Tarjeta que consume el frontend."""

    id_del_proceso: str
    referencia_del_proceso: str | None = None
    titulo: str | None = None
    entidad: str | None = None
    departamento: str | None = None
    ciudad: str | None = None
    descripcion: str | None = None
    precio_base: float | None = None
    modalidad: str | None = None
    estado: str | None = None
    categoria: str | None = None
    lotes: int | None = None
    fecha_publicacion: dt.datetime | None = None
    fecha_apertura_respuesta: dt.datetime | None = None
    dias_restantes: int | None = None
    url_proceso: str | None = None
    match: MatchOut | None = None
    acciones: list[str] = Field(default_factory=list)

    @field_validator("titulo", mode="before")
    @classmethod
    def _v(cls, v: Any) -> Any:
        return v


class OpportunityPage(BaseModel):
    items: list[Opportunity]
    total: int
    limit: int
    offset: int
    generado_en: dt.datetime


class ProfileIn(BaseModel):
    nombre: str = Field(min_length=1, max_length=200)
    descripcion: str = ""
    actividades: list[str] = Field(default_factory=list)
    palabras_clave: list[str] = Field(default_factory=list)
    exclusiones: list[str] = Field(default_factory=list)
    modalidades_preferidas: list[str] = Field(default_factory=list)
    departamentos_preferidos: list[str] = Field(default_factory=list)
    presupuesto_minimo: float | None = None
    presupuesto_maximo: float | None = None
    activo: bool = True

    @field_validator("actividades", "palabras_clave", "exclusiones", "modalidades_preferidas", "departamentos_preferidos", mode="before")
    @classmethod
    def _split(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if isinstance(v, str):
            return [t.strip() for t in v.split(",") if t.strip()]
        return [str(t).strip() for t in v if str(t).strip()]


class ProfileOut(ProfileIn):
    model_config = ConfigDict(from_attributes=True)

    version: int
    embedding: bool = False
    actualizado_en: dt.datetime | None = None


class ActionRequest(BaseModel):
    accion: str = Field(pattern="^(ocultar|descartar|guardar|restaurar)$")
    nota: str | None = None


class SyncRequest(BaseModel):
    lookback_days: int | None = Field(default=None, ge=1, le=365)
    max_procesos: int | None = Field(default=None, ge=1, le=50_000)
    max_contratos: int | None = Field(default=None, ge=1, le=50_000)
    include_contracts: bool = True
    score: bool = True
    score_candidate_pool: int | None = Field(default=None, ge=0, le=2000)


class ScoreRequest(BaseModel):
    candidate_pool: int | None = Field(default=None, ge=0, le=5000)
    use_llm: bool = True
    rescore_all: bool = False


class HealthOut(BaseModel):
    estado: str
    base_datos: str
    ollama: str
    modelo_llm: str
    modelo_embeddings: str
    datasets: dict[str, str]
    alerta_sync: dict[str, Any] | None = None
    # False cuando la IA es opcional (Ollama apagado a proposito, ESTADO-PROYECTO
    # §3.8.2). El panel lo muestra como informacion y no como averia.
    ia_requerida: bool = True
