"""Barrido de puntuacion: deja `matches` completa sin gastar LLM en 336.000 filas.

Por que existe esto
-------------------
`score.py --todo` recorre el modo `_score_all()`, que **llama al LLM por cada
fila pendiente**. Con ~336.000 procesos y `qwen3:14b` a ~15 s por licitacion eso
son ~58 dias de CPU. No es un trabajo que se pueda lanzar y forgetting.

El matchmaker ya esta disenado en dos etapas justamente para esto: las
embeddings son baratas y el LLM aporta el juicio. Este script usa la etapa 1
para **todas** las pendientes (`use_llm=False`) y luego reserva el LLM para las
que de verdad lo merecen: las mejor posicionadas por similitud.

    python scripts/barrido_scores.py --fase barrido --lote 500
    python scripts/barrido_scores.py --fase refinar --n 60
    python scripts/barrido_scores.py --fase todo --n 60
    python scripts/barrido_scores.py --medir          # solo cronometra

Las dos fases reanudan donde se quedaron: `barrido` puntua lo que no tenga
fila en `matches`, y `refinar` coge las que el propio barrido dejo marcadas como
`vectorial`, de mejor similitud a peor.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
log = logging.getLogger("barrido")


def main() -> int:
    ap = argparse.ArgumentParser(description="Barrido de puntuacion por embeddings + refinado con LLM")
    ap.add_argument("--fase", choices=("barrido", "refinar", "rehacer", "todo"), default="barrido")
    ap.add_argument("--lote", type=int, default=500, help="pendientes por pasada de embeddings")
    ap.add_argument("--n", type=int, default=60, help="cuantas pasar por el LLM en la fase refinar")
    ap.add_argument("--max-filas", type=int, default=0, help="tope de filas por corrida (0 = hasta agotar)")
    ap.add_argument("--medir", action="store_true", help="cronometra embeddings y LLM y sale")
    args = ap.parse_args()

    from scripts import pg_manager

    pg_manager.start()
    pg_manager.ensure_database()

    from app.config import settings
    from app.db import init_schema, session_scope

    init_schema()

    from app.ai.ollama_client import OllamaClient

    # El incidente de §5.6 del ESTADO-PROYECTO: un script suelto que escribe en
    # la base no queda aislado por los tests (la base se aisla porque
    # conftest.py fija PG_DATABASE *antes* de importar app.config). Este script
    # escribe de verdad, asi que dice en voz alta a cual escribe.
    log.warning("escribe en la base: %s", settings.database_url)
    if settings.pg_database.endswith("_test"):
        log.error("esta apuntando a una base de tests (%s)", settings.pg_database)
        return 1

    with OllamaClient() as ollama:
        if args.medir:
            return _medir(ollama, settings)
        if not ollama.is_available():
            log.error("no hay Ollama en %s", settings.ollama_url)
            return 1

        if args.fase in ("barrido", "todo"):
            rc = _barrido(ollama, settings, args.lote, args.max_filas)
            if rc != 0:
                return rc
        if args.fase == "rehacer":
            return _rehacer(settings, args.lote, args.max_filas)
        if args.fase in ("refinar", "todo"):
            return _refinar(ollama, settings, args.n)
    return 0


# --- fase 1b: recalcular el score de lo ya barrido --------------------------
def _rehacer(settings, lote: int, max_filas: int) -> int:
    """Recalcula el score de las filas `vectorial` sin volver a embeber.

    Existe por el bug de las reglas: la rama sin LLM no aplicaba el veredicto
    (`rules.RuleVerdict.aplicar`), asi que el tope por presupuesto y las
    penalizaciones no se reflejaban en el score y solo aparecian en las
    vinetas. Corregir el score no obliga a recalcular el embedding: el vector ya
    esta en la columna `matches.embedding` y la similitud con el perfil tampoco
    ha cambiado, asi que esta fase no llama a Ollama en absoluto y solo cuesta
    CPU y disco.

    Va de mejor a peor similitud, que es el orden en el que el panel los
    muestra: los primeros que se arreglan son los que estaban arriba, con lo
    que la lista nunca se queda vacia mientras corrige.
    """
    from sqlalchemy import select

    from app.ai.embedder import cosine_similarity, vector_to_list
    from app.ai.matchmaker import (
        Candidate,
        ScoreResult,
        _persist,
        _score_batch,
        get_active_profile,
    )
    from app.db import session_scope
    from app.models import Match, Tender

    total = 0
    inicio = time.perf_counter()
    # Los ids ya rehechos. Sin esto la fase es un bucle infinito: al persistir,
    # la fila sigue marcada `model='vectorial'` (el score lo recalcula esta
    # misma fase, no el LLM), asi que la consulta de seleccion la devuelve otra
    # vez y otra vez. Se lleva ~30 MB con las 339.000 filas, que es nada al lado
    # de las que ya se han traido a memoria de cualquier otra forma.
    hechos: set[str] = set()
    while True:
        if max_filas and total >= max_filas:
            log.info("tope de --max-filas alcanzado (%d)", total)
            break
        paso = min(lote, max_filas - total) if max_filas else lote
        t0 = time.perf_counter()

        with session_scope() as session:
            pvec = list(map(float, get_active_profile(session).embedding or []))
            # Se piden `paso + hechos` porque la seleccion se hace en SQL y no
            # conoce `hechos`: si no, un lote ya visto podria llenar el cupo
            # entero y el avance se quedaria en cero.
            stmt = (
                select(Match, Tender)
                .join(Tender, Tender.id_del_proceso == Match.tender_id)
                .where(Match.model == "vectorial")
                .order_by(Match.semantic_similarity.desc().nullslast())
                .limit(paso + len(hechos))
            )
            candidatos = [
                (m, t) for m, t in session.execute(stmt).all() if m.tender_id not in hechos
            ][:paso]
            if not candidatos:
                log.info("no quedan filas 'vectorial'; rehacer completo")
                break

            cands = [
                Candidate(
                    tender=t,
                    similarity=cosine_similarity(pvec, list(map(float, m.embedding or []))),
                    vector=vector_to_list(m.embedding),
                )
                for m, t in candidatos
            ]
            profile = get_active_profile(session)
            kws = list(profile.palabras_clave or [])
            res = ScoreResult()
            payloads = _score_batch(cands, None, profile, False, kws, res)
            _persist(session, payloads)
            hechos.update(p["tender_id"] for p in payloads)

        total += len(payloads)
        dt = time.perf_counter() - t0
        restantes = _cuantas_faltan(settings)
        log.info("rehechas %d | quedan ~%d | %.1f/s | paso %.1fs", total, restantes, len(payloads) / dt if dt else 0, dt)

    log.info(
        "rehacer: %d filas en %.1f min",
        total, (time.perf_counter() - inicio) / 60,
    )
    return 0


def _cuantas_faltan(settings) -> int:
    """Cuantas filas `vectorial` quedan, para el log de avance."""
    from sqlalchemy import func, select

    from app.db import session_scope
    from app.models import Match

    with session_scope() as session:
        return int(
            session.scalar(
                select(func.count()).select_from(Match).where(Match.model == "vectorial")
            ) or 0
        )


# --- fase 1: embeddings sobre todo lo pendiente ----------------------------
def _barrido(ollama, settings, lote: int, max_filas: int) -> int:
    from app.ai.matchmaker import embed_profile, get_active_profile
    from app.db import session_scope
    from app.models import Match

    if lote <= 0:
        log.error("--lote tiene que ser > 0")
        return 1

    # `embed_profile` con use_llm=False no llama al LLM en ningun punto: es la
    # etapa 1 del matchmaker, tal cual la usa el ciclo autonomo pero con el pool
    # entero en vez de 40. Se reusa la funcion en vez de reimplementarla para que
    # el score guardado sea el mismo que el del ciclo diario.
    total = 0
    inicio = time.perf_counter()
    while True:
        if max_filas and total >= max_filas:
            log.info("tope de --max-filas alcanzado (%d)", total)
            break
        paso = min(lote, max_filas - total) if max_filas else lote
        t0 = time.perf_counter()
        with session_scope() as session:
            profile = get_active_profile(session)
            if profile is None:
                log.error("no hay perfil de empresa: bootstrap.py --perfil")
                return 1
            res = embed_profile(
                session, profile, ollama, ollama, use_llm=False, candidate_pool=paso
            )
        if not res.scored:
            log.info("no quedan pendientes; barrido completo")
            break
        total += res.scored
        dt = time.perf_counter() - t0
        with session_scope() as session:
            pend = session.query(Match).count()
        log.info(
            "+%d puntadas | matches=%d | %.1f/s | paso %.1fs",
            res.scored, pend, res.scored / dt if dt else 0, dt,
        )

    if total:
        log.info(
            "barrido: %d filas en %.1f min (%.1f filas/s)",
            total, (time.perf_counter() - inicio) / 60,
            total / max(0.001, time.perf_counter() - inicio),
        )
    return 0


# --- fase 2: el LLM solo sobre las mejor posicionadas ------------------------
def _refinar(ollama, settings, n: int) -> int:
    from sqlalchemy import select

    from app.ai.matchmaker import (
        Candidate,
        _persist,
        _score_batch,
        ScoreResult,
        embed_profile,
        get_active_profile,
    )
    from app.db import session_scope
    from app.models import Match, Tender

    if not ollama.has_model(settings.ollama_llm):
        log.error("el modelo %s no esta en Ollama", settings.ollama_llm)
        return 1

    with session_scope() as session:
        profile = get_active_profile(session)
        if profile is None:
            log.error("no hay perfil de empresa")
            return 1
        from app.ai.matchmaker import ensure_profile_embedding

        pvec = ensure_profile_embedding(session, ollama, profile)

    stmt = (
        select(Match, Tender)
        .join(Tender, Tender.id_del_proceso == Match.tender_id)
        # Solo lo que dejo el barrido. Al persistir, `model` pasa a ser el del
        # LLM, asi que la siguiente corrida coge el siguiente lote.
        .where(Match.model == "vectorial")
        # `score > 0` descarta lo que las reglas ya tumbaron: si `descartado` es
        # True el veredicto es definitivo y el LLM no puede cambiarlo (ver
        # rules.py), asi que gastar 15 s en el seria tirar CPU.
        .where(Match.score > 0)
        .order_by(Match.semantic_similarity.desc().nullslast())
        .limit(n)
    )
    with session_scope() as session:
        filas = session.execute(stmt).all()

    if not filas:
        log.info("no hay filas 'vectorial' pendientes de refinar")
        return 0

    from app.ai.embedder import cosine_similarity, vector_to_list

    cands: list[Candidate] = []
    for match, tender in filas:
        vec = list(map(float, match.embedding)) if match.embedding is not None else None
        cands.append(Candidate(tender=tender, similarity=cosine_similarity(pvec, vec), vector=vec))

    log.info("refinando %d filas con %s", len(cands), settings.ollama_llm)
    t0 = time.perf_counter()
    result = ScoreResult()
    payloads: list[dict] = []
    with session_scope() as session:
        profile = get_active_profile(session)
        kws = list(profile.palabras_clave or [])
        for i in range(0, len(cands), settings.score_batch_size):
            payloads.extend(
                _score_batch(cands[i : i + settings.score_batch_size], ollama, profile, True, kws, result)
            )
            log.info("  %d/%d (%.1f s por fila)", len(payloads), len(cands), (time.perf_counter() - t0) / max(1, len(payloads)))
        _persist(session, payloads)

    log.info(
        "refinar: %d puntuadas, %d fallidas, %.1f min",
        len(payloads), result.failed, (time.perf_counter() - t0) / 60,
    )
    for e in result.errors[:5]:
        log.warning("  %s", e)
    return 0


# --- solo medida ------------------------------------------------------------
def _medir(ollama, settings) -> int:
    from app.ai.embedder import build_tender_text
    from app.db import session_scope
    from app.models import Tender
    from sqlalchemy import select

    if not ollama.is_available():
        log.error("no hay Ollama en %s", settings.ollama_url)
        return 1

    with session_scope() as session:
        tenders = list(
            session.execute(
                select(Tender)
                .where(Tender.descripcion.isnot(None))
                .order_by(Tender.fecha_publicacion.desc().nullslast())
                .limit(200)
            ).scalars()
        )
    textos = [
        " ".join(filter(None, [t.nombre_del_procedimiento, t.descripcion, t.objeto_contrato]))[:2000]
        or "(sin texto)"
        for t in tenders
    ]
    if not textos:
        log.error("no hay procesos con descripcion para medir")
        return 1

    for n in (50, 200):
        t0 = time.perf_counter()
        vecs = ollama.embed(textos[:n])
        dt = time.perf_counter() - t0
        log.info("embeddings: %d textos en %.1f s -> %.1f/s (dims=%d)", n, dt, n / dt, len(vecs[0]))

    if ollama.has_model(settings.ollama_llm):
        from app.ai.matchmaker import get_active_profile
        from app.ai.prompts import SYSTEM, build_user_prompt

        with session_scope() as session:
            profile = get_active_profile(session)
            muestra = tenders[0]
            t0 = time.perf_counter()
            ollama.chat_json(
                system=SYSTEM,
                user=build_user_prompt(
                    profile, muestra, description=muestra.descripcion or "", price=muestra.precio_base
                ),
            )
            log.info("LLM %s: 1 llamada en %.1f s", settings.ollama_llm, time.perf_counter() - t0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
