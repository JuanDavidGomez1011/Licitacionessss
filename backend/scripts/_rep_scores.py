"""De un solo uso: como se reparten los scores segun quien los puso."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
logging.basicConfig(level=logging.ERROR)

from sqlalchemy import func, select

from app.config import settings
from app.db import session_scope
from app.models import Match

print(f"base: {settings.pg_database}")
with session_scope() as s:
    filas = s.execute(
        select(
            Match.model,
            func.count(),
            func.avg(Match.score),
            func.min(Match.score),
            func.max(Match.score),
            func.avg(Match.semantic_similarity),
        ).group_by(Match.model)
    ).all()
    print(f"{'modelo':<16}{'n':>9}{'medio':>8}{'min':>6}{'max':>6}{'simil.':>9}")
    for modelo, n, avg, mn, mx, sim in filas:
        print(f"{modelo:<16}{n:>9}{float(avg or 0):>8.1f}{mn:>6}{mx:>6}{float(sim or 0):>9.3f}")

    total = s.scalar(select(func.count()).select_from(Match))
    llm = s.scalar(select(func.count()).select_from(Match).where(Match.model != "vectorial"))
    print(f"\ntotal matches: {total} | refidadas por LLM: {llm} | solo vector: {total - llm}")

    print("\n-- donde caen las refinadas --")
    for lim in (10, 25, 50, 100, 500, 2000):
        n = s.scalar(
            select(func.count())
            .select_from(Match)
            .where(Match.model != "vectorial", Match.score >= 0)
            .where(
                Match.tender_id.in_(
                    select(Match.tender_id).order_by(Match.score.desc()).limit(lim)
                )
            )
        )
        print(f"  dentro del top {lim:>5}: {n} de {llm}")

    print("\n-- las 5 mejores refinadas --")
    for m in s.execute(
        select(Match.score, Match.tender_id, Match.semantic_similarity, Match.model)
        .where(Match.model != "vectorial")
        .order_by(Match.score.desc())
        .limit(5)
    ).all():
        print(f"  {m[0]:3d} sim={m[2]:.3f} {m[1]} ({m[3]})")
