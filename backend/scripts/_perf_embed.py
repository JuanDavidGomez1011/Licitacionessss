"""De un solo uso: busca el tamano de lote de /api/embed que aguanta."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
logging.basicConfig(level=logging.ERROR)

import httpx

from app.ai.embedder import build_tender_text
from app.ai.ollama_client import OllamaClient
from app.config import settings
from app.db import session_scope
from app.models import Tender
from sqlalchemy import select

with session_scope() as s:
    pend = list(
        s.execute(
            select(Tender)
            .where(Tender.descripcion.isnot(None))
            .order_by(Tender.fecha_publicacion.desc().nullslast())
            .limit(500)
        ).scalars()
    )
textos = [build_tender_text(t) for t in pend]
lens = sorted(len(x) for x in textos)
print(f"texto: min={lens[0]} p50={lens[len(lens)//2]} p95={lens[int(len(lens)*0.95)]} max={lens[-1]}")

with OllamaClient() as ollama:
    c = httpx.Client(base_url=settings.ollama_url, timeout=600.0)
    for n in (8, 16, 32, 64, 128, 256):
        trozo = textos[:n]
        payload = {
            "model": settings.ollama_embed_model,
            "input": trozo,
            "keep_alive": settings.ollama_keep_alive,
        }
        t0 = time.perf_counter()
        try:
            r = c.post("/api/embed", json=payload)
            dt = time.perf_counter() - t0
            if r.status_code == 200:
                print(f"  {n:4d} textos  OK    {dt:6.2f} s  ({n/dt:6.1f}/s)")
            else:
                print(f"  {n:4d} textos  HTTP{r.status_code} {dt:6.2f} s  {r.text[:110]}")
        except Exception as exc:
            print(f"  {n:4d} textos  EXC   {type(exc).__name__}: {exc}")
    c.close()
