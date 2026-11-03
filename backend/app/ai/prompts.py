"""Prompts del Matchmaker.

El LLM debe responder siempre JSON estricto. Se le da un unico objeto concreto
y se le pide explicitamente que no invente datos ausentes, para evitar que un
modelo pequeno alucine catalysis de los montos o del objeto.
"""

from __future__ import annotations

import json
from typing import Any

SYSTEM = """Eres un analista de compras publicas en Colombia. Tu trabajo es evaluar si un proceso de contratacion del SECOP II encaja con el perfil de una empresa.

Reglas estrictas:
1. Responde EXCLUSIVAMENTE con un objeto JSON valido. Sin texto antes ni despues, sin bloques de codigo.
2. Evalua solo el objeto, la descripcion y el nombre del proceso. No inventes clauses, niorantias, ni deadlines que no esten en el texto.
3. El score es un entero de 0 a 100 y representa la probabilidad de que esta empresa gane Y le convenga el contrato.
4. Se estricto. La mayoria de los procesos NO son compatibles. Ante la duda, baja el score.
   Usa esta escala y no la esquives:
     0-20  el objeto no corresponde a la actividad de la empresa
     21-40 tema cercano pero la empresa no podria competir
     41-60 encaje parcial; la empresa tendria que ampliar su oferta
     61-80 encaje claro y el presupuesto es viable
     81-100 encaje casi perfecto
5. No regales puntos por que aparezcan palabras como "servicios" o "soporte". Deben describir el objeto real del contrato.
6. Las vinetas resumen el porque del score: maximo 3, cada una de 8 a 22 palabras, en espanol.
7. Si el texto esta vacio o es irrelevante, devuelve score 0 y bullets vacios.
8. Las exclusiones del perfil son motivo suficiente para score 0 aunque el texto sea parecido.

Esquema JSON exacto:
{
  "score": <entero 0-100>,
  "bullets": ["<vineta 1>", "<vineta 2>", "<vineta 3>"],
  "rationale": "<una o dos frases que justifican el score>",
  "matched_keywords": ["<palabras clave del perfil que aparecen en el texto>"],
  "gaps": ["<requisito o habilitacion que el texto no confirma>"]
}"""

USER_TEMPLATE = """## PERFIL DE LA EMPRESA
Nombre: {nombre}
Descripcion: {descripcion}
Actividades: {actividades}
Palabras clave: {palabras_clave}
Modalidades preferidas: {modalidades}
Exclusiones (descartan el proceso): {exclusiones}
Rango de presupuesto de interes: {rango_presupuesto}
Territorios de interes: {departamentos}

## PROCESO DE CONTRATACION
Entidad: {entidad}
Nombre: {nombre_procedimiento}
Modalidad: {modalidad}
Estado: {estado}
Presupuesto base: {precio}
Fecha de publicacion: {fecha_publicacion}
Fecha limite de presentacion: {fecha_apertura}
Codigo UNSPSC: {categoria}
Lotes: {lotes}
Duracion: {duracion}

Objeto / descripcion del contrato:
---
{objeto_texto}
---

Evalua la compatibilidad y devuelve solo el JSON."""

BULK_SUMMARY_SYSTEM = """Resume un grupo de procesos de contratacion del SECOP II para un informe ejecutivo.
Responde EXCLUSIVAMENTE con un objeto JSON valido con esta forma exacta:
{
  "titulo": "<titulo corto del grupo>",
  "resumen": "<2 frases sobre que se esta contratando y por que importa>",
  "puntos_clave": ["<punto 1>", "<punto 2>", "<punto 3>"],
  "riesgos": ["<riesgo o requisito a verificar>"]
}"""


def build_user_prompt(
    profile: Any,
    tender: Any,
    *,
    description: str,
    price: float | None,
) -> str:
    rango = "sin definir"
    if getattr(profile, "presupuesto_minimo", None) or getattr(profile, "presupuesto_maximo", None):
        lo = profile.presupuesto_minimo or 0
        hi = profile.presupuesto_maximo or "sin tope"
        rango = f"entre {lo:,.0f} y {hi} COP".replace(",", ".")

    def join(values: list[str] | None) -> str:
        return ", ".join(values or []) or "no especificadas"

    return USER_TEMPLATE.format(
        nombre=profile.nombre or "sin nombre",
        descripcion=profile.descripcion or "no indicada",
        actividades=join(profile.actividades),
        palabras_clave=join(profile.palabras_clave),
        modalidades=join(profile.modalidades_preferidas),
        exclusiones=join(profile.exclusiones),
        rango_presupuesto=rango,
        departamentos=join(profile.departamentos_preferidos),
        entidad=tender.entidad or "no indicada",
        nombre_procedimiento=tender.nombre_del_procedimiento or "sin nombre",
        modalidad=tender.modalidad_de_contratacion or "no indicada",
        estado=tender.estado_del_procedimiento or "no indicado",
        precio=f"{price:,.0f} COP".replace(",", ".") if price else "no publicado",
        fecha_publicacion=_fmt(tender.fecha_publicacion),
        fecha_apertura=_fmt(tender.fecha_apertura_respuesta),
        categoria=tender.codigo_principal_categoria or "no informado",
        lotes=tender.numero_de_lotes or "no informado",
        duracion=(
            f"{tender.duracion} {tender.unidad_de_duracion}"
            if tender.duracion and tender.unidad_de_duracion
            else "no informada"
        ),
        objeto_texto=(description or "sin descripcion publicada").strip()[:4000],
    )


def _fmt(value: Any) -> str:
    if value is None:
        return "no publicada"
    return value.strftime("%Y-%m-%d %H:%M")


def normalize_scoring(raw: Any) -> dict[str, Any]:
    """Sana la salida del LLM: score acotado, 3 vinetas como maximo, listas de texto."""
    if not isinstance(raw, dict):
        return {"score": 0, "bullets": [], "rationale": "", "matched_keywords": [], "gaps": []}

    try:
        score = int(round(float(raw.get("score", 0))))
    except (TypeError, ValueError):
        score = 0
    score = max(0, min(100, score))

    def as_list(key: str, limit: int) -> list[str]:
        value = raw.get(key)
        if not isinstance(value, list):
            return []
        out = [str(v).strip() for v in value if str(v).strip()]
        return out[:limit]

    rationale = raw.get("rationale")
    return {
        "score": score,
        "bullets": as_list("bullets", 3),
        "rationale": str(rationale).strip()[:600] if rationale else "",
        "matched_keywords": as_list("matched_keywords", 12),
        "gaps": as_list("gaps", 6),
    }
