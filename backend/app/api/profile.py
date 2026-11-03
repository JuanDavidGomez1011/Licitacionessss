"""Rutas del Perfil de Empresa (el criterio del matchmaker)."""

from __future__ import annotations

import logging
from typing import Any

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.embedder import build_profile_text
from app.ai.matchmaker import get_active_profile
from app.config import settings
from app.db import get_db
from app.models import CompanyProfile
from app.schemas import ProfileIn, ProfileOut

log = logging.getLogger(__name__)
router = APIRouter(prefix="/perfil", tags=["perfil"])


def _out(p: CompanyProfile) -> ProfileOut:
    return ProfileOut(
        nombre=p.nombre,
        descripcion=p.descripcion or "",
        actividades=p.actividades or [],
        palabras_clave=p.palabras_clave or [],
        exclusiones=p.exclusiones or [],
        modalidades_preferidas=p.modalidades_preferidas or [],
        departamentos_preferidos=p.departamentos_preferidos or [],
        presupuesto_minimo=p.presupuesto_minimo,
        presupuesto_maximo=p.presupuesto_maximo,
        activo=p.activo,
        version=p.version,
        embedding=bool(p.embedding),
        actualizado_en=p.updated_at,
    )


@router.get("", response_model=ProfileOut)
def leer(db: Session = Depends(get_db)) -> ProfileOut:
    profile = get_active_profile(db)
    if profile is None:
        raise HTTPException(404, "no hay perfil configurado; ejecuta bootstrap.py --perfil")
    return _out(profile)


@router.put("", response_model=ProfileOut)
def guardar(body: ProfileIn, db: Session = Depends(get_db)) -> ProfileOut:
    """Guarda el perfil e invalida su embedding (se recalcula al volver a puntuar)."""
    profile = db.execute(select(CompanyProfile)).scalars().first()
    created = profile is None
    if created:
        profile = CompanyProfile(nombre=body.nombre)
        db.add(profile)
    else:
        profile.version = (profile.version or 1) + 1
    for field in body.model_dump(exclude={"activo"}):
        setattr(profile, field, getattr(body, field))
    profile.activo = body.activo
    profile.embedding = None  # el texto cambio: el vector guardado ya no aplica
    db.commit()
    db.refresh(profile)
    log.info("perfil %s (version %d)", "creado" if created else "actualizado", profile.version)
    return _out(profile)


@router.post("/recalcular-embedding")
def recalcular_embedding(db: Session = Depends(get_db)) -> dict[str, Any]:
    from app.ai.ollama_client import OllamaClient, OllamaUnavailable

    profile = get_active_profile(db)
    if profile is None:
        raise HTTPException(404, "no hay perfil configurado")
    with OllamaClient() as client:
        client.ensure_model(settings.ollama_embed_model)
        try:
            vector = client.embed_one(build_profile_text(profile))
        except OllamaUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
    profile.embedding = list(vector)
    db.commit()
    return {"ok": True, "dimensiones": len(vector), "modelo": settings.ollama_embed_model}


@router.post("/cargar-desde-yaml")
def cargar_desde_yaml(db: Session = Depends(get_db)) -> dict[str, Any]:
    path = settings.profile_path
    if not path.exists():
        raise HTTPException(404, f"no existe {path}")
    data: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not data.get("nombre"):
        raise HTTPException(400, "el YAML no define 'nombre'")
    allowed = set(ProfileIn.model_fields)
    body = ProfileIn(**{k: v for k, v in data.items() if k in allowed})
    return guardar(body, db).model_dump(mode="json")
