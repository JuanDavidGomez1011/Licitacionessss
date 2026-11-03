"""Dejar la base de desarrollo alineada con `models.py`. Script de una vez.

Se ejecutó el 2026-09-26 al adoptar Alembic, y se queda en el repo como
referencia de los dosDesajustes que tenía la base y que la migracion implicita
de `app/db.py` no podia ver ni arreglar sola:

  1. **Faltaban 3 indices.** `create_all` no crea indices en tablas que ya
     existen, y la migracion implicita solo anadia columnas. Al meter
     `notice_uid` y `proceso_id` para el enlace contrato<->proceso (bug #10),
     las columnas llegaron a la base de 135.000 filas pero sus indices nunca:
     el enlace se resolvia con un seq scan sobre 75.434 x 135.600. Lo destapo
     `alembic check`. `_add_missing_indexes()` los crea solo en bases
     heredadas; aqui hace falta porque esta ya estaba sellada en `head`.

  2. **`contracts.proceso_de_compra` estaba en varchar(80), no en varchar(40).**
     Los 80 son residuo de cuando la columna era FK a `tenders.id_del_proceso`
     (String(80)); `0001` la crea en 40, que es lo que dice el modelo. Antes de
     estrechar se midio: `max(length())` = 17 ('CO1.PCCNTR.*' / 'CO1.BDOS.*'),
     0 nulos.

     Estrechar es lo unico que `_widen_narrow_columns()` **no** automatiza a
     proposito, porque perder datos ya escritos no se perdona. Aqui se mide
     antes y, si algum dia un valor no cabe, el script se niega a truncar y
     avisa en vez de hacerlo.

Es idempotente: se puede volver a ejecutar sin romper nada.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from sqlalchemy import text  # noqa: E402

from app.db import _add_missing_indexes, engine  # noqa: E402

ANCHO_NUEVO = 40
COLUMNA = "proceso_de_compra"
TABLA = "contracts"


def _alinear_indices() -> None:
    with engine.begin() as conn:
        _add_missing_indexes(conn)


def _alinear_ancho() -> bool:
    """Estrecha `proceso_de_compra` si cabe. False si no se pudo decidir."""
    # OJO con el orden: la lectura va en SU PROPIA conexion y se cierra antes de
    # abrir la de escritura. Un `SELECT` deja la transaccion abierta con un
    # bloqueo ACCESS SHARE sobre la tabla, y el `ALTER` de al lado pide
    # ACCESS EXCLUSIVE sobre la misma: si la lectura sigue viva, el ALTER espera
    # a una conexion que no se cierra hasta despues del ALTER. Se queda
    # colgado el mismo script, sin error ni aviso.
    with engine.connect() as conn:
        ancho_actual = conn.execute(
            text(
                "SELECT character_maximum_length FROM information_schema.columns "
                "WHERE table_name = :t AND column_name = :c"
            ),
            {"t": TABLA, "c": COLUMNA},
        ).scalar()
        if ancho_actual is None:
            print(f"  {TABLA}.{COLUMNA} no existe: nada que hacer")
            return True
        if int(ancho_actual) <= ANCHO_NUEVO:
            print(f"  {TABLA}.{COLUMNA} ya es varchar({ancho_actual}): nada que hacer")
            return True
        maximo = conn.execute(
            text(f"SELECT max(length({COLUMNA})) FROM {TABLA} WHERE {COLUMNA} IS NOT NULL")
        ).scalar()

    print(
        f"  {TABLA}.{COLUMNA}: varchar({ancho_actual}) -> varchar({ANCHO_NUEVO}), "
        f"dato mas largo = {maximo}"
    )
    if maximo is not None and int(maximo) > ANCHO_NUEVO:
        print(
            f"  NO se estrecha: hay valores de {maximo} caracteres y solo caben {ANCHO_NUEVO}. "
            "Hay que decidir a mano: truncar, ensanchar el modelo, o dejar la columna como esta."
        )
        return False
    with engine.begin() as w:
        w.execute(text(f'ALTER TABLE {TABLA} ALTER COLUMN "{COLUMNA}" TYPE varchar({ANCHO_NUEVO})'))
    print(f"  {TABLA}.{COLUMNA} ahora es varchar({ANCHO_NUEVO})")
    return True


def main() -> int:
    print("Alineando la base con models.py")
    _alinear_indices()
    return 0 if _alinear_ancho() else 1


if __name__ == "__main__":
    raise SystemExit(main())
