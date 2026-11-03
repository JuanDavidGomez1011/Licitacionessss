"""Embeddings locales y similaridad coseno.

Sirve para dos cosas:
  1. reducir candidatos: de miles de procesos a los N mas similares al perfil
  2. refinar el score del LLM con una señal cuantitativa y reproducible
"""

from __future__ import annotations

import logging
import math
import re
from typing import Any, Iterable, Sequence

from app.config import settings

log = logging.getLogger(__name__)

# Palabras vacias del espanol/ingles que no aportan a la comparacion semantica
STOPWORDS = {
    "de", "la", "el", "los", "las", "del", "un", "una", "unos", "unas", "y", "o", "u",
    "en", "para", "por", "con", "sin", "sobre", "entre", "a", "al", "que", "se", "su",
    "sus", "es", "son", "fue", "ser", "como", "mas", "menos", "muy", "este", "esta",
    "estos", "estas", "todo", "toda", "todos", "todas", "otro", "otra", "lo", "al",
    "the", "of", "and", "for", "with", "to", "in", "on", "a", "an", "or", "by", "at",
    "contratacion", "contratación", "proceso", "procedimiento", "servicio", "servicios",
    "suministro", "suministrar", "adquisicion", "adquisición", "compra", "comprar",
}
_TOKEN_RE = re.compile(r"[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+")


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Similitud coseno. Devuelve 0.0 si alguna de las entradas es invalida."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=False):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return max(-1.0, min(1.0, dot / (math.sqrt(na) * math.sqrt(nb))))


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


def keyword_overlap(text: str, keywords: Iterable[str]) -> list[str]:
    """Palabras clave del perfil que aparecen literalmente en el texto."""
    if not text:
        return []
    tokens = set(tokenize(text))
    return [k for k in keywords if k and set(tokenize(k)) & tokens]


def build_profile_text(profile: Any) -> str:
    """Representacion textual del perfil de empresa usada para los embeddings."""
    parts: list[str] = [
        profile.nombre or "",
        profile.descripcion or "",
        " ".join(profile.actividades or []),
        " ".join(profile.palabras_clave or []),
    ]
    return "\n".join(p for p in parts if p).strip()


def build_tender_text(tender: Any) -> str:
    """Texto que se envia a la IA: objeto + descripcion + contexto."""
    parts = [
        tender.nombre_del_procedimiento or "",
        tender.descripcion or "",
        tender.objeto_contrato or "",
        " ".join(filter(None, [tender.tipo_contrato, tender.subtipo_contrato])),
    ]
    return "\n".join(p for p in parts if p).strip()


def semantic_score(similarity: float) -> float:
    """Mapea la similitud coseno a 0-100 de forma acotada.

    nomic-embed-text sobre textos relacionados cae tipicamente en 0.6-0.9 y
    textos ajenos por debajo de 0.5; se remapea esa banda util.
    """
    floor, ceil = 0.45, 0.88
    if similarity <= floor:
        return 0.0
    if similarity >= ceil:
        return 100.0
    return round((similarity - floor) / (ceil - floor) * 100, 1)


def blend_scores(semantic: float, llm: float, semantic_weight: float = 0.35) -> float:
    """Mezcla la senal vectorial con el juicio del LLM."""
    w = max(0.0, min(1.0, semantic_weight))
    value = (semantic * w) + (llm * (1 - w))
    return int(round(max(0.0, min(100.0, value))))


def vector_to_list(vector: Sequence[float] | None) -> list[float] | None:
    if vector is None:
        return None
    vals = [float(v) for v in vector]
    if len(vals) != settings.embedding_dims:
        log.debug("vector con %d dims (esperadas %d)", len(vals), settings.embedding_dims)
    return vals
