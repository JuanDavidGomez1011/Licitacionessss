"""Bootstrap: prepara base de datos, esquema y perfil de empresa.

    python scripts/bootstrap.py --perfil
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("bootstrap")


def ensure_db() -> str:
    from scripts import pg_manager

    pg_manager.start()
    pg_manager.ensure_database()
    return pg_manager.database_url()


def main() -> int:
    ap = argparse.ArgumentParser(description="Prepara la plataforma para el primer uso")
    ap.add_argument("--perfil", action="store_true", help="carga el perfil de empresa desde app/seed/profile.yaml")
    ap.add_argument("--recrear-db", action="store_true", help="borra el cluster local y lo vuelve a inicializar")
    args = ap.parse_args()

    from scripts import pg_manager

    if args.recrear_db:
        log.warning("recreando el cluster de PostgreSQL en %s", pg_manager.PGDATA)
        pg_manager.init_cluster(force=True)

    url = ensure_db()
    log.info("base de datos: %s", url)

    from app.db import init_schema

    init_schema()
    log.info("esquema creado")

    if args.perfil:
        import yaml

        from app.db import session_scope
        from app.models import CompanyProfile
        from app.schemas import ProfileIn

        path = BACKEND / "app" / "seed" / "profile.yaml"
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        allowed = set(ProfileIn.model_fields)
        body = ProfileIn(**{k: v for k, v in data.items() if k in allowed})
        with session_scope() as session:
            profile = session.query(CompanyProfile).first()
            if profile is None:
                profile = CompanyProfile(**body.model_dump(exclude={"activo"}), activo=body.activo)
                session.add(profile)
                log.info("perfil creado: %s", body.nombre)
            else:
                for field in body.model_dump(exclude={"activo"}):
                    setattr(profile, field, getattr(body, field))
                profile.activo = body.activo
                profile.embedding = None
                profile.version = (profile.version or 1) + 1
                log.info("perfil actualizado: %s (version %d)", body.nombre, profile.version)

    log.info("listo. Arranca la API con: python -m uvicorn app.main:app --reload --port 8000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
