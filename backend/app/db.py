"""Motor de base de datos y creacion de esquema."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import Column, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import BACKEND_DIR, settings
from app.models import Base

log = logging.getLogger(__name__)

engine = create_engine(
    settings.database_url,
    echo=settings.db_echo,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Sesion transaccional: commit en exito, rollback en excepcion."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Iterator[Session]:
    """Dependencia de FastAPI."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


# --- Migracion implicita: solo para bases heredadas ------------------------
#
# Las cuatro funciones siguientes reconcilian una base que ya existia con el
# modelo, sin passar por Alembic. Son el camino que se usa una unica vez, al
# adoptar Alembic en una base con datos (ver `init_schema`), y siguen siendo la
# red que salva si alguien despliega con una base de la que no se conoce el
# historial. Para cambios de esquema de hoy, lo que corresponde es una migracion
# en `alembic/versions/`.


def _widen_narrow_columns(conn: Any) -> None:
    """Ensancha columnas `varchar` que en la BD son mas estrechas que el modelo.

    `create_all` solo crea tablas que faltan: no altera las que ya existen, asi
    que cambiar un `String(n)` en `models.py` no cambia nada en una BD viva. Sin
    esto, `contracts.referencia_del_contrato` seguia en `varchar(160)` con el
    modelo en 600, y la ingesta moria con
    `value too long for type character varying(160)`.

    Solo ensancha, nunca estrecha: reducir el ancho perderia datos ya escritos.
    """
    for tabla in Base.metadata.sorted_tables:
        if tabla.name not in _tablas_existentes(conn):
            continue
        for columna in tabla.columns:
            ancho = getattr(columna.type, "length", None)
            if not ancho:
                continue
            actual = conn.execute(
                text(
                    "SELECT character_maximum_length FROM information_schema.columns "
                    "WHERE table_name = :t AND column_name = :c"
                ),
                {"t": tabla.name, "c": columna.name},
            ).scalar()
            if actual is None or int(actual) >= ancho:
                continue
            log.info("ensanchando %s.%s: %s -> %s", tabla.name, columna.name, actual, ancho)
            conn.execute(
                text(
                    f'ALTER TABLE {tabla.name} ALTER COLUMN "{columna.name}" '
                    f"TYPE varchar({ancho})"
                )
            )


def _tablas_existentes(conn: Any) -> set[str]:
    filas = conn.execute(
        text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
    ).fetchall()
    return {f[0] for f in filas}


def _indices_existentes(conn: Any, tabla: str) -> set[str]:
    filas = conn.execute(
        text(
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname = current_schema() AND tablename = :t"
        ),
        {"t": tabla},
    ).fetchall()
    return {f[0] for f in filas}


def _add_missing_indexes(conn: Any) -> None:
    """Crea los indices que el modelo declara y la BD no tiene.

    **Este si era un agujero.** `create_all` no crea indices en tablas que ya
    existen, y la migracion implicita solo anadia columnas: al meter
    `notice_uid` y `proceso_id` para el enlace contrato<->proceso (bug #10),
    las columnas llegaron a la base de las 135.000 filas pero sus indices nunca.
    El enlace se resolvia con un seq scan sobre 75.434 x 135.600 en cada pasada.

    Lo destapo `alembic check` al adoptionar Alembic: comparando el modelo con
    la base de verdad salian 3 indices que el modelo declaraba y la base no
    tenia. Para una base creada desde cero `0001` si los crea todos; esta
    funcion es la red de las bases heredadas.
    """
    for tabla in Base.metadata.sorted_tables:
        if tabla.name not in _tablas_existentes(conn):
            continue
        existentes = _indices_existentes(conn, tabla.name)
        for indice in tabla.indexes:
            if indice.name in existentes:
                continue
            # Un indice sobre una expresion (no una columna) no se puede
            # reconstruir con este CREATE. No hay ninguno, pero si se anade uno
            # que avise en vez de escribir un indice que no es el del modelo.
            if not all(isinstance(c, Column) for c in indice.columns):
                log.warning("no se puede crear a mano el índice %s: no es de columnas", indice.name)
                continue
            columnas = ", ".join(f'"{c.name}"' for c in indice.columns)
            unico = "UNIQUE " if indice.unique else ""
            log.info("añadiendo índice %s (%s)", indice.name, columnas)
            conn.execute(
                text(f'CREATE {unico}INDEX "{indice.name}" ON {tabla.name} ({columnas})')
            )


def _base_heredada() -> bool:
    """True si la base tiene el esquema pero no registro de version de Alembic.

    O sea: creada por el `create_all` de antes de las migraciones. Se distingue
    de una base vacia (tambien sin `alembic_version`, pero sin tablas, y esa la
    construye `0001`) mirando si existe alguna tabla del modelo.
    """
    with engine.connect() as conn:
        if "alembic_version" in _tablas_existentes(conn):
            return False
        declaradas = {t.name for t in Base.metadata.sorted_tables}
        return bool(declaradas & _tablas_existentes(conn))


def _add_missing_columns(conn: Any) -> None:
    """Agrega a las tablas existentes las columnas que el modelo ya declare.

    `create_all` tampoco altera tablas que ya existen, asi que anadir una columna
    a `models.py` no llegaba nunca a una BD viva. Pasó con
    `tenders.notice_uid` y `contracts.proceso_id`, que son la clave del enlace
    entre procesos y contratos.
    """
    for tabla in Base.metadata.sorted_tables:
        if tabla.name not in _tablas_existentes(conn):
            continue
        existentes = {
            f[0] for f in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = :t"
                ),
                {"t": tabla.name},
            )
        }
        for columna in tabla.columns:
            if columna.name in existentes:
                continue
            log.info("añadiendo columna %s.%s", tabla.name, columna.name)
            conn.execute(text(f'ALTER TABLE {tabla.name} ADD COLUMN "{columna.name}" {compila(columna.type)}'))


def compila(tipo: Any) -> str:
    """DDL de un tipo SQLAlchemy (`String(600)`, `TIMESTAMP WITH TIME ZONE`...)."""
    return tipo.compile(dialect=engine.dialect)


def _fks_de_la_tabla(conn: Any, tabla: str) -> dict[str, set[str]]:
    """Mapa nombre_de_restriccion -> columnas que cubre, para una tabla dada."""
    filas = conn.execute(
        text(
            "SELECT con.conname, att.attname "
            "FROM pg_constraint con "
            "JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE "
            "JOIN pg_attribute att "
            "  ON att.attrelid = con.conrelid AND att.attnum = k.attnum "
            "WHERE con.contype = 'f' AND con.conrelid = to_regclass(:t) "
            "ORDER BY k.ord"
        ),
        {"t": tabla},
    ).fetchall()
    # `unnest ... WITH ORDINALITY` devuelve una fila por columna de la FK, y una
    # FK de varias columnas es una sola restriccion: se agrupa por nombre.
    por_restriccion: dict[str, set[str]] = {}
    for nombre, columna in filas:
        por_restriccion.setdefault(nombre, set()).add(columna)
    return por_restriccion


def _drop_stale_foreign_keys(conn: Any) -> None:
    """Quita las FK que la BD tiene pero el modelo ya no declara.

    Sin Alembic, quitar una relacion del modelo no quita su restriccion de la
    BD. Paso con `contracts.proceso_de_compra`: paso de ser FK a `tenders` a ser
    un texto normal (SECOP publica ahi ids `CO1.PCCNTR.*`, no `CO1.REQ.*`), pero
    el `contracts_proceso_de_compra_fkey` se quedo en la base y hacia fallar la
    ingesta con `ForeignKeyViolation`.
    """
    for tabla in Base.metadata.sorted_tables:
        if tabla.name not in _tablas_existentes(conn):
            continue
        # OJO: hay que comparar con la TABLA referenciada (`tenders`), no con la
        # columna referenciada: `fk.target_fullname` es "tenders.id_del_proceso"
        # y comparar contra eso daba por obsoletas FKs que si existen.
        declaradas = {fk.parent.name for fk in tabla.foreign_keys}
        for nombre, columnas in _fks_de_la_tabla(conn, tabla.name).items():
            if columnas & declaradas:
                continue
            log.info("quitando FK obsoleta %s (%s)", nombre, ", ".join(sorted(columnas)))
            conn.execute(text(f'ALTER TABLE {tabla.name} DROP CONSTRAINT "{nombre}"'))


def _add_missing_foreign_keys(conn: Any) -> None:
    """Crea las FK que el modelo declara y la BD no tiene.

    Contrapartida de `_drop_stale_foreign_keys`, y lo que hace que añadir una
    relacion al modelo llegue a una BD ya viva (`create_all` solo crea tablas).
    """
    for tabla in Base.metadata.sorted_tables:
        if tabla.name not in _tablas_existentes(conn):
            continue
        existentes = _fks_de_la_tabla(conn, tabla.name)
        cubiertas = set().union(*existentes.values()) if existentes else set()
        for fk in tabla.foreign_keys:
            if fk.parent.name in cubiertas:
                continue
            nombre = f"{tabla.name}_{fk.parent.name}_fkey"
            log.info("añadiendo FK %s -> %s", nombre, fk.target_fullname)
            conn.execute(
                text(
                    f'ALTER TABLE {tabla.name} ADD CONSTRAINT "{nombre}" '
                    f'FOREIGN KEY ("{fk.parent.name}") '
                    f'REFERENCES "{fk.column.table.name}" ("{fk.column.name}") '
                    f"ON DELETE {fk.ondelete or 'NO ACTION'}"
                )
            )


def init_schema() -> None:
    """Pone el esquema al dia. Idempotente: se puede llamar en cada arranque.

    El camino normal es `alembic upgrade head`. El atajo es para una base
    **heredada**, creada por el `create_all` de antes de que existiera Alembic
    (la de desarrollo, con 135.000 filas): ahi las tablas ya estan pero no hay
    `alembic_version`, y aplicar `0001` reventaria con "relation already
    exists". En ese caso se reconcilia con la migracion implicita de mas abajo y
    se sella en `head`, que es la verdad: las tablas ya estan como el modelo
    dice y lo unico que faltaba era el registro de la version.
    """
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))

    if _base_heredada():
        log.info("base sin alembic_version: reconciliando con el modelo y sellando en head")
        with engine.begin() as conn:
            _add_missing_columns(conn)
            _add_missing_foreign_keys(conn)
            _drop_stale_foreign_keys(conn)
            _widen_narrow_columns(conn)
            _add_missing_indexes(conn)
        stamp("head")
        log.info("esquema listo")
        return

    upgrade_head()
    log.info("esquema listo")


def include_object(obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any) -> bool:
    """Filtro de `--autogenerate` / `alembic check`: fuera lo de Alembic.

    Sin esto, la comparacion ve `alembic_version` en la base, no la ve en el
    modelo, y la propone como algo a borrar. Vive aqui y no en `alembic/env.py`
    para que los tests puedan usar el MISMO filtro que la comparacion de verdad.
    """
    if type_ == "table" and name == "alembic_version":
        return False
    return True


def pendientes_de_migrar() -> list[Any]:
    """Operaciones que autogenerate detectaria entre el modelo y la base.

    Vacio significa que `models.py` y la base coinciden. Es la unica forma
    fiable de saber si las migraciones estan al dia: `create_all` y la
    migracion implicita no avisan de nada, y asi fue como la base de desarrollo
    estuvo meses sin 3 indices del enlace contrato<->proceso.
    """
    from alembic.autogenerate import compare_metadata
    from alembic.runtime.migration import MigrationContext

    with engine.connect() as conn:
        ctx = MigrationContext.configure(
            conn,
            opts={"compare_type": True, "include_object": include_object},
        )
        return compare_metadata(ctx, Base.metadata)


def _config_alembic() -> "Config":
    """`alembic.ini` con rutas absolutas.

    Las de `alembic.ini` son relativas (al ejecutar `alembic` desde `backend/`
    funcionan), pero `init_schema()` se llama desde uvicorn, cuya raiz puede ser
    otra, y entonces `script_location = alembic` no encontro nada.
    """
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("prepend_sys_path", str(BACKEND_DIR))
    # La URL se pasa desde aqui y no desde el `.ini` a proposito: `engine` ya
    # esta construido con `settings`, y las migraciones tienen que ir a la misma
    # base que la app o el esquema se aplica donde no sirve.
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    # La app ya tiene su logging montado. Que Alembic reconfigurara la raiz
    # desde dentro se lo llevaria por delante (ver `alembic/env.py`).
    cfg.attributes["configure_logger"] = False
    return cfg


def upgrade_head() -> None:
    """Aplica las migraciones pendientes. No hace nada si ya estan al dia."""
    command.upgrade(_config_alembic(), "head")


def stamp(revision: str) -> None:
    """Marca la version aplicada sin ejecutar su DDL.

    Para adoptar Alembic en una base que ya tiene el esquema. Decir "esto ya
    esta" es una decision de una persona, no algo que se pueda deducir.
    """
    command.stamp(_config_alembic(), revision)


def current_revision() -> str | None:
    """Revision aplicada segun `alembic_version`, o None si no hay tabla."""
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def raw_query(sql: str, **params: Any) -> list[tuple]:
    with engine.connect() as conn:
        return conn.execute(text(sql), params).fetchall()
