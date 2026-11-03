"""El 'Matchmaker': puntua cada licitacion contra el Perfil de Empresa.

Estrategia en dos etapas, para no gastar CPU con el LLM en todo el dataset:

  1. Embeddings + similitud coseno sobre el texto del perfil -> orden rapido de
     candidatos. Es barato (una llamada por lote) y ya descarta lo irrelevante.
  2. Solo los N mejores pasan al LLM, que aporta el juicio contextual y redacta
     las 3 vinetas. El score final mezcla ambas senal.

El score guardado en BD (0-100) es la mezcla; la similaridad queda registrada
aparte para poder auditar por que se dio ese puntaje.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.ai.embedder import (
    blend_scores,
    build_profile_text,
    build_tender_text,
    cosine_similarity,
    keyword_overlap,
    semantic_score,
    vector_to_list,
)
from app.ai.ollama_client import OllamaClient, OllamaUnavailable
from app.ai.prompts import SYSTEM, build_user_prompt, normalize_scoring
from app.ai.rules import evaluate as evaluate_rules
from app.config import settings
from app.models import CompanyProfile, Match, Tender

log = logging.getLogger(__name__)


@dataclass
class ScoreResult:
    scored: int = 0
    skipped: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass
class Candidate:
    tender: Tender
    similarity: float
    vector: list[float] | None = None


def get_active_profile(session: Session) -> CompanyProfile | None:
    profile = session.execute(
        select(CompanyProfile).where(CompanyProfile.activo.is_(True)).order_by(CompanyProfile.id)
    ).scalars().first()
    if profile is None:
        profile = session.execute(select(CompanyProfile)).scalars().first()
    return profile


def ensure_profile_embedding(session: Session, client: OllamaClient, profile: CompanyProfile) -> list[float]:
    """Calcula (y cachea) el vector del perfil."""
    if profile.embedding:
        return list(map(float, profile.embedding))
    text = build_profile_text(profile)
    if not text.strip():
        raise ValueError("el perfil de empresa esta vacio: no se puede generar embedding")
    vector = client.embed_one(text)
    profile.embedding = list(vector)
    session.flush()
    return vector


def embed_profile(
    session: Session,
    profile: CompanyProfile,
    client: OllamaClient,
    llm: OllamaClient,
    use_llm: bool = True,
    candidate_pool: int | None = None,
    batch_size: int | None = None,
    keywords: Sequence[str] | None = None,
) -> ScoreResult:
    """Puntua las licitaciones pendientes usando el vector del perfil."""
    result = ScoreResult()
    profile_vector = ensure_profile_embedding(session, client, profile)
    pool = candidate_pool if candidate_pool is not None else settings.score_candidate_pool
    size = batch_size or settings.score_batch_size
    kws = list(keywords if keywords is not None else (profile.palabras_clave or []))

    if pool <= 0:
        return _score_all(session, llm, profile, result, use_llm=use_llm, kws=kws)

    # --- etapa 1: candidato mas similar --------------------------------
    # El total se cuenta con COUNT y no con `len(_pendientes(limit=None))`: ese
    # trae los pendientes uno por uno como objetos ORM solo para saber cuantos
    # hay. Con 336.000 pendientes (o 300.000, tras un barrido) son 300.000
    # hidrataciones por llamada, y como `embed_profile` la usa en cada ciclo
    # de 30 minutos para un numero que va al log, se comida el tiempo de la
    # pasada entera. El anti-join se resuelve igual; lo que cambia es que no se
    # trae las filas.
    total_pending = _contar_pendientes(session)
    pendings = _pendientes(session, limit=pool)
    if not pendings:
        return result
    result.skipped = max(0, total_pending - len(pendings))

    vectors = client.embed([build_tender_text(t) or "(sin texto)" for t in pendings])
    scored: list[Candidate] = []
    for tender, vector in zip(pendings, vectors, strict=False):
        sim = cosine_similarity(profile_vector, vector)
        scored.append(Candidate(tender=tender, similarity=sim, vector=vector_to_list(vector)))

    scored.sort(key=lambda c: c.similarity, reverse=True)
    log.info(
        "matchmaker: %d candidatos de %d pendientes, mejor similitud %.3f (id=%s)",
        len(scored), total_pending, scored[0].similarity, scored[0].tender.id_del_proceso,
    )

    # --- etapa 2: LLM sobre el lote superior ---------------------------
    payloads: list[dict[str, Any]] = []
    for i in range(0, len(scored), size):
        payloads.extend(_score_batch(scored[i : i + size], llm, profile, use_llm, kws, result))

    _persist(session, payloads)
    result.scored = len(payloads)
    return result


def _score_all(
    session: Session,
    llm: OllamaClient,
    profile: CompanyProfile,
    result: ScoreResult,
    use_llm: bool,
    kws: list[str],
) -> ScoreResult:
    """Puntua todo lo pendiente (modo exhaustivo, sin embeddings)."""
    pendings = _pendientes(session, limit=None)
    payloads: list[dict[str, Any]] = []
    size = settings.score_batch_size
    for i in range(0, len(pendings), size):
        batch = [Candidate(tender=t, similarity=0.0) for t in pendings[i : i + size]]
        payloads.extend(_score_batch(batch, llm, profile, use_llm, kws, result))
    _persist(session, payloads)
    result.scored = len(payloads)
    return result


def _pendientes(session: Session, limit: int | None) -> list[Tender]:
    stmt = _stmt_pendientes().order_by(Tender.fecha_publicacion.desc().nullslast())
    if limit:
        stmt = stmt.limit(limit)
    return list(session.execute(stmt).scalars())


def _contar_pendientes(session: Session) -> int:
    """Cuantas licitaciones siguen sin puntuar, sin traerlas."""
    return int(
        session.execute(
            select(func.count()).select_from(Tender).outerjoin(Match, Match.tender_id == Tender.id_del_proceso)
            .where(Match.tender_id.is_(None))
        ).scalar_one()
    )


def _stmt_pendientes():
    return (
        select(Tender)
        .outerjoin(Match, Match.tender_id == Tender.id_del_proceso)
        .where(Match.tender_id.is_(None))
    )


def _score_batch(
    batch: list[Candidate],
    llm: OllamaClient,
    profile: CompanyProfile,
    use_llm: bool,
    keywords: list[str],
    result: ScoreResult,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for cand in batch:
        tender = cand.tender
        description = tender.descripcion or tender.objeto_contrato or ""
        full_text = " ".join(
            filter(None, [tender.nombre_del_procedimiento or "", description])
        )
        overlaps = keyword_overlap(full_text, keywords)
        sem = semantic_score(cand.similarity)

        # --- reglas deterministas: cortan antes de gastar LLM -----------
        verdict = evaluate_rules(
            profile,
            text=full_text,
            precio=tender.precio_base,
            modalidad=tender.modalidad_de_contratacion,
            departamento=tender.departamento_entidad,
        )

        if verdict.descartado:
            log.info(
                "matchmaker: %s descartado por reglas (%s)",
                tender.id_del_proceso, "; ".join(verdict.razones),
            )
            out.append(
                _payload(
                    cand, sem,
                    {
                        "score": 0,
                        "bullets": verdict.razones[:3],
                        "rationale": "Excluido por las reglas del perfil de empresa.",
                        "gaps": [],
                    },
                    overlaps, llm=None, score_override=0, max_score=0,
                )
            )
            continue

        if not use_llm:
            # Las reglas tambien se aplican aqui. Antes no se hacia: la rama
            # vectorial se quedaba con `int(sem)` y el veredicto solo aparecia en
            # las vinetas, asi que una tarjeta podia decir "presupuesto por debajo
            # del minimo" y puntuar 77 al mismo tiempo. El tope por presupuesto
            # (CAP_BUDGET) y las penalizaciones son deterministas: no dependen
            # del LLM, asi que no hay motivo para que apliquen en una ruta y en
            # la otra no. Sin esto, el score de un barrido y el de un ciclo con
            # LLM no son comparables, que es justo lo que la mezcla 35/65 supone.
            out.append(
                _payload(cand, sem, {"score": int(sem), "bullets": verdict.razones, "rationale": ""},
                         overlaps, llm=None, score_override=verdict.aplicar(sem),
                         max_score=verdict.max_score)
            )
            continue

        try:
            raw = llm.chat_json(
                system=SYSTEM,
                user=build_user_prompt(profile, tender, description=description, price=tender.precio_base),
            )
            parsed = normalize_scoring(raw)
        except (OllamaUnavailable, ValueError) as exc:
            result.failed += 1
            log.warning("matchmaker: fallo puntuando %s: %s", tender.id_del_proceso, exc)
            if len(result.errors) < 10:
                result.errors.append(f"{tender.id_del_proceso}: {exc}")
            # se cae al score vectorial para no perder la oportunidad
            out.append(
                _payload(cand, sem,
                         {"score": int(sem), "bullets": verdict.razones,
                          "rationale": "puntuacion vectorial (LLM no disponible)"},
                         overlaps, llm=None)
            )
            continue

        # el LLM propone, las reglas disponan
        score = verdict.aplicar(parsed["score"])
        if verdict.razones and len(parsed["bullets"]) < 3:
            parsed["bullets"] = (parsed["bullets"] + verdict.razones)[:3]
        if verdict.razones:
            parsed["rationale"] = (parsed["rationale"] + " " + "; ".join(verdict.razones)).strip()

        out.append(_payload(cand, sem, parsed, overlaps, llm=settings.ollama_llm,
                            score_override=score, max_score=verdict.max_score))
    return out


def _payload(
    cand: Candidate,
    semantic: float,
    parsed: dict[str, Any],
    overlaps: list[str],
    llm: str | None,
    score_override: int | None = None,
    max_score: int | None = None,
) -> dict[str, Any]:
    """Arma la fila de `matches`.

    `max_score` es el tope duro de las reglas (`RuleVerdict.max_score`), y se
    aplica **despues** de mezclar, no antes. Importa: mezclar primero y topar
    despues no es lo mismo que topar la mezcla. Con el tope de presupuesto (20)
    y la mezcla 35/65, limitar solo la parte del LLM dejaba el score en
    `0.35*77 + 0.65*20 = 40`, y una exclusion del perfil (tope 5) quedaba en 27.
    El vector tiene la palabra final sobre lo que las reglas ya rechazaron, que
    es justo lo contrario de "el LLM propone, las reglas disponan": las reglas
    dejan de ser un corte y pasan a ser un descuento. Por eso el corte va al
    final. Las penalizaciones (modalidad, territorio) si se aplican antes de
    mezclar, que es como estan documentadas y medidas.
    """
    llm_score = float(score_override if score_override is not None else parsed["score"])
    score = blend_scores(semantic, llm_score)
    if max_score is not None:
        score = min(score, int(max_score))
    return {
        "tender_id": cand.tender.id_del_proceso,
        "score": max(0, min(100, int(score))),
        "bullets": parsed.get("bullets", []),
        "rationale": parsed.get("rationale", ""),
        "matched_keywords": parsed.get("matched_keywords") or overlaps,
        "gaps": parsed.get("gaps", []),
        "semantic_similarity": round(cand.similarity, 4),
        "embedding": cand.vector,
        "model": llm or "vectorial",
        "profile_version": 1,
    }


def _persist(session: Session, payloads: list[dict[str, Any]]) -> None:
    if not payloads:
        return
    stmt = pg_insert(Match).values(payloads)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Match.tender_id],
        set_={
            "score": stmt.excluded.score,
            "bullets": stmt.excluded.bullets,
            "rationale": stmt.excluded.rationale,
            "matched_keywords": stmt.excluded.matched_keywords,
            "gaps": stmt.excluded.gaps,
            "semantic_similarity": stmt.excluded.semantic_similarity,
            "embedding": stmt.excluded.embedding,
            "model": stmt.excluded.model,
            "profile_version": stmt.excluded.profile_version,
            "scored_at": stmt.excluded.scored_at,
        },
    )
    session.execute(stmt)


def rescore_tender(
    session: Session, client: OllamaClient, llm: OllamaClient, tender: Tender, use_llm: bool = True
) -> dict[str, Any] | None:
    """Repuntua una licitacion puntual (usado por el endpoint de detalle)."""
    profile = get_active_profile(session)
    if profile is None:
        return None
    profile_vector = ensure_profile_embedding(session, client, profile)
    text = build_tender_text(tender) or "(sin texto)"
    vector = client.embed_one(text)
    cand = Candidate(tender=tender, similarity=cosine_similarity(profile_vector, vector), vector=vector_to_list(vector))
    result = ScoreResult()
    payloads = _score_batch([cand], llm, profile, use_llm, list(profile.palabras_clave or []), result)
    if not payloads:
        return None
    _persist(session, payloads)
    return payloads[0]
