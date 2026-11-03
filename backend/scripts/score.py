"""Script de IA local standalone: puntua licitaciones con Ollama.

    python scripts/score.py --perfil
    python scripts/score.py --perfil --pool 20
    python scripts/score.py --sin-llm --pool 40
    python scripts/score.py --todo
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("score")


def main() -> int:
    ap = argparse.ArgumentParser(description="Puntua licitaciones contra el Perfil de Empresa")
    ap.add_argument("--perfil", action="store_true", help="recarga el perfil desde app/seed/profile.yaml")
    ap.add_argument("--pool", type=int, default=0, help="candidatos a evaluar (0 = valor por defecto)")
    ap.add_argument("--sin-llm", action="store_true", help="solo embeddings, sin llamar al LLM")
    ap.add_argument("--todo", action="store_true", help="repuntua TODO lo descargado")
    ap.add_argument("--top", type=int, default=15, help="cuantas filas mostrar")
    args = ap.parse_args()

    from scripts import pg_manager

    pg_manager.start()
    pg_manager.ensure_database()

    from app.config import settings
    from app.db import init_schema, session_scope
    from app.ingest.runner import run_scoring
    from app.models import Match

    init_schema()

    if args.perfil:
        import yaml

        from app.models import CompanyProfile
        from app.schemas import ProfileIn

        data = yaml.safe_load(settings.profile_path.read_text(encoding="utf-8")) or {}
        allowed = set(ProfileIn.model_fields)
        body = ProfileIn(**{k: v for k, v in data.items() if k in allowed})
        with session_scope() as session:
            profile = session.query(CompanyProfile).first()
            if profile is None:
                session.add(CompanyProfile(**body.model_dump(exclude={"activo"}), activo=body.activo))
            else:
                for field in body.model_dump(exclude={"activo"}):
                    setattr(profile, field, getattr(body, field))
                profile.activo = body.activo
                profile.embedding = None
                profile.version = (profile.version or 1) + 1
        log.info("perfil cargado: %s", body.nombre)

    log.info("ollama=%s llm=%s embeddings=%s", settings.ollama_url, settings.ollama_llm, settings.ollama_embed_model)
    out = run_scoring(
        candidate_pool=args.pool or None,
        use_llm=not args.sin_llm,
        rescore_all=args.todo,
    )
    log.info("resultado: %s", out)
    if not out.get("ok"):
        return 1

    with session_scope() as session:
        from sqlalchemy import select

        from app.models import Tender

        rows = session.execute(
            select(Match, Tender)
            .join(Tender, Tender.id_del_proceso == Match.tender_id)
            .order_by(Match.score.desc())
            .limit(args.top)
        ).all()

    print(f"\n{'=' * 100}\nTOP {len(rows)} POR SCORE\n{'=' * 100}")
    for m, t in rows:
        print(f"\n[{m.score:3d}] {t.nombre_del_procedimiento or '(sin nombre)'}")
        print(f"      entidad : {t.entidad or '-'}")
        print(f"      modal.  : {t.modalidad_de_contratacion or '-'} | {t.departamento_entidad or '-'}")
        if t.precio_base:
            print(f"      precio  : {t.precio_base:,.0f} COP")
        if m.semantic_similarity is not None:
            print(f"      similit.: {m.semantic_similarity:.3f} | modelo: {m.model}")
        for b in m.bullets or []:
            print(f"        - {b}")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
