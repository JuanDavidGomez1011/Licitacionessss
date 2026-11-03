"""Script de extraccion standalone: descarga procesos/contratos del SECOP II.

    python scripts/extract.py --dias 3 --limite 100
    python scripts/extract.py --dias 1 --dataset procesos
    python scripts/extract.py --dias 7 --dataset contratos
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("extract")


def main() -> int:
    ap = argparse.ArgumentParser(description="Descarga datos de SECOP II a PostgreSQL")
    ap.add_argument("--dataset", choices=["procesos", "contratos", "ambos"], default="procesos")
    ap.add_argument("--dias", type=int, default=3, help="ventana de fechas hacia atras")
    ap.add_argument("--limite", type=int, default=100, help="maximo de filas por dataset (0 = sin limite)")
    ap.add_argument("--sin-db", action="store_true", help="solo consulta el conteo, no escribe")
    args = ap.parse_args()

    from scripts import pg_manager

    pg_manager.start()
    pg_manager.ensure_database()

    from app.config import settings
    from app.db import init_schema, session_scope
    from app.ingest.secop_contratos import sync_contratos
    from app.ingest.secop_procesos import sync_procesos
    from app.ingest.socrata import SocrataClient, last_days, socrata_where_datetime

    init_schema()
    since, until = last_days(args.dias)
    limit = None if args.limite == 0 else args.limite
    log.info("ventana: %s -> %s | limite: %s", since.isoformat(), until.isoformat(), limit or "sin tope")

    with SocrataClient() as api:
        if args.dataset in ("procesos", "ambos"):
            total = api.count(
                settings.dataset_procesos,
                socrata_where_datetime("fecha_de_ultima_publicaci", since, until),
            )
            log.info("p6dx-8zbt: %d procesos publicados en la ventana", total)

        if args.dataset in ("contratos", "ambos"):
            total_c = api.count(
                settings.dataset_contratos,
                socrata_where_datetime("fecha_de_firma", since, until),
            )
            log.info("jbjy-vk9h: %d contratos firmados en la ventana", total_c)

        if args.sin_db:
            return 0

        with session_scope() as session:
            if args.dataset in ("procesos", "ambos"):
                res = sync_procesos(session, api, since=since, until=until, max_rows=limit)
                log.info("procesos -> leidas=%d nuevas=%d actualizadas=%d",
                         res.fetched, res.inserted, res.updated)
            if args.dataset in ("contratos", "ambos"):
                resc = sync_contratos(session, api, since=since, until=until, max_rows=limit)
                log.info("contratos -> leidas=%d nuevas=%d actualizadas=%d huerfanas=%d",
                         resc.fetched, resc.inserted, resc.updated, resc.orphans)

    log.info("finalizado %s", datetime.now(timezone.utc).isoformat())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
