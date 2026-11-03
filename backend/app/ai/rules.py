"""Filtro determinista de reglas del Perfil de Empresa.

Un LLM pequeno tiende a ser complaciente: si el proceso menciona tecnologia,
dice que hay compatibilidad aunque el objeto sea otra cosa muy distinta. Este
modulo planta los cortes duros antes (y despues) del LLM:

  - las exclusiones del perfil descartan el proceso
  - el rango de presupuesto deja fuera lo que no es del tamano de la empresa
  - modalidad y territorio solo penalizan, no eliminan (el SECOP usa etiquetas
    heterogeneas y es normal que aparezcan variantes no listadas)

Cada corte queda registrado como razon para que el score sea auditable.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

# Topes por regla
CAP_EXCLUSION = 5
CAP_BUDGET = 20
PENALTY_MODALIDAD = 15
PENALTY_TERRITORIO = 10

_ACCENTS = str.maketrans("áéíóúüñÁÉÍÓÚÜÑ", "aeiouunAEIOUUN")
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def norm(value: Any) -> str:
    """Minusculas, sin acentos, espacios colapsados."""
    if not value:
        return ""
    text = unicodedata.normalize("NFKD", str(value)).translate(_ACCENTS).lower()
    return " ".join(text.split())


def tokens(value: str) -> set[str]:
    return set(_TOKEN_RE.findall(norm(value)))


@dataclass
class RuleVerdict:
    max_score: int = 100
    penalizacion: int = 0
    razones: list[str] = field(default_factory=list)
    descartado: bool = False

    def aplicar(self, score_llm: float) -> int:
        """Combina el score del LLM con las reglas."""
        if self.max_score < 100:
            value = min(score_llm, self.max_score)
        else:
            value = score_llm - self.penalizacion
        return int(max(0, min(100, round(value))))


def _hits(term: str, text: str) -> bool:
    """True si el termino aparece como frase o como conjunto de palabras."""
    t = tokens(term)
    if not t:
        return False
    if len(t) == 1:
        return t <= tokens(text)
    return t <= tokens(text)


def evaluate(
    profile: Any,
    *,
    text: str,
    precio: float | None,
    modalidad: str | None,
    departamento: str | None,
) -> RuleVerdict:
    verdict = RuleVerdict()
    haystack = norm(text)
    if not haystack:
        verdict.max_score = 0
        verdict.descartado = True
        verdict.razones.append("El proceso no tiene objeto ni descripcion publicados")
        return verdict

    # 1. exclusiones
    for exclusion in profile.exclusiones or []:
        if exclusion and _hits(exclusion, haystack):
            verdict.max_score = min(verdict.max_score, CAP_EXCLUSION)
            verdict.descartado = True
            verdict.razones.append(f"Excluido por el perfil: '{exclusion}'")
            break

    # 2. presupuesto
    if precio is not None:
        minimo = profile.presupuesto_minimo
        maximo = profile.presupuesto_maximo
        if minimo is not None and precio < minimo:
            verdict.max_score = min(verdict.max_score, CAP_BUDGET)
            verdict.razones.append(
                f"Presupuesto {precio:,.0f} COP por debajo del minimo {minimo:,.0f}".replace(",", ".")
            )
        if maximo is not None and precio > maximo:
            verdict.max_score = min(verdict.max_score, CAP_BUDGET)
            verdict.razones.append(
                f"Presupuesto {precio:,.0f} COP por encima del maximo {maximo:,.0f}".replace(",", ".")
            )

    # 3. modalidad (penaliza, no descarta)
    preferidas = [m for m in (profile.modalidades_preferidas or []) if m]
    if preferidas and modalidad:
        m_norm = norm(modalidad)
        if not any(m_norm in norm(p) or norm(p) in m_norm for p in preferidas):
            verdict.penalizacion += PENALTY_MODALIDAD
            verdict.razones.append(f"Modalidad no preferida: {modalidad}")

    # 4. territorio (penaliza, no descarta)
    depts = [d for d in (profile.departamentos_preferidos or []) if d]
    if depts and departamento:
        d_norm = norm(departamento)
        if not any(d_norm in norm(p) or norm(p) in d_norm for p in depts):
            verdict.penalizacion += PENALTY_TERRITORIO
            verdict.razones.append(f"Territorio fuera de los preferidos: {departamento}")

    return verdict
