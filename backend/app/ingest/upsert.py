"""Upsert masivo troceado para Postgres.

PostgreSQL admite como maximo 65.535 parametros bind por sentencia. Un
`INSERT ... VALUES (...),(...)` de N filas y C columnas usa N*C parametros, asi
que una ventana de un solo dia (~2.700 procesos x 29 columnas = 78.300) revienta
con `number of parameters must be between 0 and 65535`.

Los limites del CLI (`--limite 100`) escondian el problema: 100 filas dan 2.900
parametros y nunca se acercaban al tope. El ciclo automatico, que descarga la
ventana completa, es lo que lo destapo.

Ademas hay un segundo tope, mas sutil: aunque quepan los parametros, Postgres
tambien rechaza que un mismo lote toque dos veces la misma fila
(`ON CONFLICT DO UPDATE command cannot affect row a second time`), y el dataset
de SECOP II publica el mismo proceso varias veces. Ver `_dedup`.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any, Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.ingest.socrata import fit_to_model

log = logging.getLogger(__name__)

# Maximo de bind params por sentencia en PostgreSQL (protocolo, no configurable).
MAX_BIND_PARAMS = 65_535


def _chunks(rows: Sequence[Any], columns: int) -> list[Sequence[Any]]:
    """Parte `rows` en trozos de N filas que quepan en MAX_BIND_PARAMS."""
    if columns <= 0:
        raise ValueError("columns debe ser > 0")
    por_lote = max(1, MAX_BIND_PARAMS // columns)
    return [rows[i : i + por_lote] for i in range(0, len(rows), por_lote)]


def existing_keys(session: Session, model: type, key: str, claves: list[Any]) -> set[Any]:
    """Que claves ya existen, tambien en lotes.

    Un `WHERE key IN (...)` con las 80.000 claves de una ventana ampliada a 30
    dias excede el tope de bind params igual que el INSERT.
    """
    columna = getattr(model, key)
    vistos: set[Any] = set()
    for lote in _chunks(claves, 1):
        vistos.update(
            ident for (ident,) in session.execute(select(columna).where(columna.in_(lote)))
        )
    return vistos


# Alias interno, por compatibilidad con las llamadas ya escritas.
_existentes = existing_keys


def _dedup(payload: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Deja una sola fila por clave natural.

    El dataset de procesos de SECOP II publica el mismo `id_del_proceso` varias
    veces y con una ventana ancha llegan repetidos al mismo lote, donde
    PostgreSQL rechaza el INSERT:

        ON CONFLICT DO UPDATE command cannot affect row a second time
        (psycopg.errors.CardinalityViolation)

    Medido sobre 8.000 filas reales: 1.085 claves repetidas y **las 1.085 son
    copias exactas**, sin un solo campo distinto. O sea que hoy esto es quitar
    lineas duplicadas, no elegir una version.

    Aun asi se conserva la **primera** aparicion y no la ultima. El extractor
    pide el dataset ordenado por `fecha_de_publicacion_del DESC`, y en orden
    descendente la primera fila de una clave es la mas reciente; quedarse con la
    ultima seria escribir la version mas vieja. Hoy da igual porque las filas son
    identicas, pero si SECOP empieza a publicar revisiones reales de un mismo
    proceso, esta eleccion es la que evita que se pierdan.
    """
    primero: dict[Any, dict[str, Any]] = {}
    for fila in payload:
        primero.setdefault(fila[key], fila)
    if len(primero) != len(payload):
        log.info(
            "upsert: %d filas duplicadas por %s colapsadas (%d -> %d)",
            len(payload) - len(primero), key, len(payload), len(primero),
        )
    return list(primero.values())


def bulk_upsert(
    session: Session,
    model: type,
    payload: list[dict[str, Any]],
    key: str,
    frozen: set[str] | None = None,
) -> tuple[int, int]:
    """Inserta o actualiza por la clave natural `key`. Devuelve (nuevas, actualizadas).

    `frozen` son columnas que no se tocan en el `ON CONFLICT DO UPDATE` (la clave
    y las marcas de creacion).
    """
    if not payload:
        return 0, 0

    payload = _dedup(payload, key)
    # Ultima linea de defensa antes del INSERT: es la BD la que impone el ancho
    # de la columna, asi que aqui (y no solo en el parser) se recorta lo que no
    # cabe, para que una fila rara no aborte las decenas de miles del lote.
    payload = [fit_to_model(model, p) for p in payload]
    congeladas = frozen or {key, "pk", "created_at"}
    columnas = len(model.__table__.columns)
    claves = [p[key] for p in payload]

    actualizadas = len(existing_keys(session, model, key, claves))

    ahora = dt.datetime.now(dt.timezone.utc)
    lotes = _chunks(payload, columnas)
    if len(lotes) > 1:
        log.info(
            "upsert %s: %d filas x %d columnas -> %d lotes (tope %d parametros)",
            model.__tablename__, len(payload), columnas, len(lotes), MAX_BIND_PARAMS,
        )

    for lote in lotes:
        valores = [{**p, "created_at": ahora, "updated_at": ahora} for p in lote]
        stmt = pg_insert(model).values(valores)
        stmt = stmt.on_conflict_do_update(
            index_elements=[key],
            set_={c.name: stmt.excluded[c.name] for c in model.__table__.columns if c.name not in congeladas},
        )
        session.execute(stmt)

    return len(payload) - actualizadas, actualizadas
