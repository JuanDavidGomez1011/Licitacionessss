"""Cronometraje por etapa de una pasada del barrido. De un solo uso."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
logging.basicConfig(level=logging.WARNING)

from app.ai.embedder import build_tender_text, cosine_similarity
from app.ai.ollama_client import OllamaClient
from app.db import session_scope

from app.ai.matchmaker import _pendientes, _persist, _score_batch, ScoreResult, get_active_profile, ensure_profile_embedding

POOL = 500

t = time.perf_counter()
with session_scope() as s:
    pend = _pendientes(s, limit=POOL)
t_pend = time.perf_counter() - t
print(f"_pendientes        {t_pend:7.2f} s  ({len(pend)} filas)")

with OllamaClient() as ollama:
    t = time.perf_counter()
    with session_scope() as s:
        pvec = ensure_profile_embedding(s, ollama, get_active_profile(s))
    t_prof = time.perf_counter() - t
    print(f"perfil+embedding   {t_prof:7.2f} s")

    t = time.perf_counter()
    textos = [build_tender_text(x) for x in pend]
    t_txt = time.perf_counter() - t
    chars = sum(len(x) for x in textos)
    print(f"build_tender_text  {t_txt:7.2f} s  ({chars} chars, {chars/len(textos):.0f} medio)")

    t = time.perf_counter()
    vecs = []
    for i in range(0, len(textos), 256):
        vecs.extend(ollama.embed(textos[i : i + 256]))
    t_emb = time.perf_counter() - t
    print(f"ollama.embed       {t_emb:7.2f} s  ({len(textos)/t_emb:.0f}/s)")

    t = time.perf_counter()
    sims = [cosine_similarity(pvec, v) for v in vecs]
    t_cos = time.perf_counter() - t
    print(f"cosine_similarity  {t_cos:7.2f} s")

from app.ai.matchmaker import Candidate
from app.ai.embedder import vector_to_list

cands = [
    Candidate(tender=x, similarity=s, vector=vector_to_list(v))
    for x, s, v in zip(pend, sims, vecs)
]
res = ScoreResult()
t = time.perf_counter()
with session_scope() as s:
    profile = get_active_profile(s)
    kws = list(profile.palabras_clave or [])
    payloads = _score_batch(cands, ollama, profile, False, kws, res)
t_score = time.perf_counter() - t
print(f"_score_batch       {t_score:7.2f} s  ({len(payloads)} payloads)")

t = time.perf_counter()
with session_scope() as s:
    _persist(s, payloads)
t_pers = time.perf_counter() - t
print(f"_persist           {t_pers:7.2f} s")

print(f"\nTOTAL              {t_pend+t_prof+t_txt+t_emb+t_cos+t_score+t_pers:7.2f} s")
