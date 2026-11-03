"""Captura payloads reales de la API para usarlos como fixtures de los tests del frontend.

    python backend/scripts/capture_fixtures.py

No es parte de la aplicacion: solo deja `frontend/src/test/fixtures.json` con la
forma exacta que devuelve el backend, para que los tests no dependan de que la
API este levantada.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/api"
OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "fixtures.json"


def get(path: str) -> object:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    licitaciones = get("/licitaciones?limit=5&score_min=0")
    ident = licitaciones["items"][0]["id_del_proceso"]

    payload = {
        "id": ident,
        "licitaciones": licitaciones,
        "facetas": get("/licitaciones/facetas?limite=5"),
        "estadisticas": get("/estadisticas"),
        "perfil": get("/perfil"),
        "detalle": get(f"/licitaciones/{ident}"),
        "similares": get(f"/licitaciones/similares/{ident}?limite=3"),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"fixtures -> {OUT} (id={ident}, items={len(licitaciones['items'])})")


if __name__ == "__main__":
    main()
