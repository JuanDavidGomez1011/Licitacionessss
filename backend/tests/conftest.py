"""Configuracion de pytest para el backend.

Los tests de ingesta necesitan una base de datos real: los bugs que se quieren
cubrir (tope de bind params, claves repetidas en un lote) solo se reproducen
contra Postgres, no en un doble. Para no tocar los datos de produccion se usa
una base aparte, `licitaciones_test`, que se crea y se vacia en cada sesion.

El esquema lo monta `init_schema()`, que corre `alembic upgrade head` de verdad:
una vez por sesion para la base, y otra vez en cada test que necesita el
esquema limpio. Son ~2,5 s por reconstruccion (el DDL de las 6 tablas y sus
indices, mas la carga del directorio de migraciones), asi que se reparte en dos
fixtures en vez de uno para que solo lo paguen los tests que lo necesitan.

Se descarto usar una base plantilla (`CREATE DATABASE ... TEMPLATE`), que en un
disco normal seria lo natural: aqui cada copia obliga a un checkpoint de todo el
cluster, y con 570.000 filas en las bases de trabajo tardaba mas que reconstruir
el esquema (la suite paso de 2 min a 6'30").
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

# La BD de pruebas se declara antes de que `app.config` se importe, porque el
# engine de `app.db` se construye en tiempo de importacion.
os.environ.setdefault("PG_DATABASE", "licitaciones_test")
os.environ.setdefault("ENABLE_SCHEDULER", "false")
# `alembic/env.py` da prioridad a esta variable sobre `settings`. Si el que
# corre los tests la tiene puesta para migrar otra base a mano, los tests
# migrarian esa y no `licitaciones_test`.
os.environ.pop("ALEMBIC_DATABASE_URL", None)

from sqlalchemy import create_engine, text  # noqa: E402

from app.config import settings  # noqa: E402


def _admin_url() -> str:
    auth = (
        f"{settings.pg_user}:{settings.pg_password}"
        if settings.pg_password
        else settings.pg_user
    )
    return f"postgresql+psycopg://{auth}@{settings.pg_host}:{settings.pg_port}/postgres"


def _vacia_las_tablas(forzar: bool = False) -> None:
    """TRUNCATE de todo lo de la app. Barato: no toca el esquema.

    Con `forzar=False` primero mira si hay algo que borrar y, si no hay nada,
    no escribe. No es una optimizacion estetica: un `TRUNCATE` sobre tablas
    vacias no mueve una pagina, pero aun asi es una transaccion de escritura, y
    en este disco el `fsync` del commit cuesta ~2 s. Los tests se encadenan, y
    tras un test que ya dejo las tablas limpias (o tras el `TRUNCATE` de otro
    test) ese `fsync` se paga entero para no hacer nada. Con 46 tests que usan
    este fixture, son dos minutos de suite.

    La lectura previa no cuesta `fsync` (no escribe WAL), asi que salir antes
    sale gratis.

    OJO con las secuencias: `TRUNCATE ... RESTART IDENTITY` tambien las pone a
    cero, y el atajo no lo hace. Solo importa si un test inserta filas, las
    borra a mano y el siguiente espera recibir `id=1`; ningun test mira el valor
    de un id autoincremental (los fixtures traen ids explicitos de Socrata), y
    `forzar=True` queda disponible para el que lo necesite.
    """
    from app.db import engine
    from app.models import Base

    tablas = Base.metadata.sorted_tables
    if not forzar:
        with engine.connect() as conn:
            hay_algo = any(
                conn.execute(text(f"SELECT EXISTS (SELECT 1 FROM {t.name})")).scalar()
                for t in tablas
            )
        if not hay_algo:
            return
    nombres = ", ".join(t.name for t in tablas)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {nombres} RESTART IDENTITY CASCADE"))


def _tira_las_tablas() -> None:
    """Borra las 6 tablas y `alembic_version`, todo en una sola transaccion.

    `Base.metadata.drop_all()` abriria su propia transaccion y el
    `DROP TABLE IF EXISTS alembic_version` otra: dos `COMMIT`, y en este disco
    cada uno paga un `fsync` de ~0,5 s. Como solo hay una cosa que hacer, se
    escribe a mano en un `engine.begin()`.

    El `DROP` es explicito y no `drop_all` por dos razones: `alembic_version` no
    esta en `Base.metadata` (si se queda, Alembic cree que el esquema esta al
    dia y no vuelve a crearlo), y `CASCADE` resuelve las FK entre tablas sin
    tener que respeta el orden de dependencias.
    """
    from app.db import engine
    from app.models import Base

    nombres = [t.name for t in Base.metadata.sorted_tables] + ["alembic_version"]
    with engine.begin() as conn:
        for nombre in reversed(nombres):
            conn.execute(text(f'DROP TABLE IF EXISTS "{nombre}" CASCADE'))


def _recrea_el_esquema() -> None:
    """Tira las tablas y las vuelve a crear desde las migraciones."""
    from app.db import init_schema

    _tira_las_tablas()
    init_schema()
    # Sin `_vacia_las_tablas()`: las 6 tablas acaban de crearse, estan vacias y
    # no hay una fila que borrar. El TRUNCATE no costaria nada de CPU (no toca
    # una pagina), pero si una transaccion de escritura, y en este disco el
    # `fsync` del commit se lleva ~2 s. Puesto el DDL delante, ese fsync es el
    # que acaba pagando el TRUNCATE aunque sea el que cronometre.


@pytest.fixture(scope="session", autouse=True)
def postgres():
    """Base de pruebas con el esquema de las migraciones. Una vez por sesion."""
    from scripts import pg_manager

    from app.db import init_schema

    pg_manager.start()
    admin = create_engine(_admin_url(), isolation_level="AUTOCOMMIT", future=True)
    with admin.connect() as conn:
        # `WITH (FORCE)` (Postgres 13+) cierra conexiones colgadas de una corrida
        # anterior. Sin el FORCE, el DROP falla y el mensaje no dice de donde
        # venia la conexion que lo bloquea.
        conn.execute(text(f'DROP DATABASE IF EXISTS "{settings.pg_database}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{settings.pg_database}"'))
    admin.dispose()

    # Las migraciones se ejecutan de verdad, no `create_all`. Si el esquema que
    # produce `0001` no fuera el que sale de `models.py`, los tests estarian
    # probando un esquema que nadie despliega;
    # `test_la_migracion_reproduce_el_esquema_del_modelo` lo vigila en cada
    # corrida.
    init_schema()
    # Igual que en `_recrea_el_esquema`: la base se acaba de crear de cero, asi
    # que no hay nada que vaciar y el TRUNCATE solo anadiria un `fsync`.
    yield


@pytest.fixture
def session(postgres):
    """Tablas vacias, esquema intacto. Es lo que usa casi todo."""
    from app.db import SessionLocal

    _vacia_las_tablas()
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def esquema_limpio(postgres):
    """Esquema recien creado por las migraciones, y tablas vacias.

    Para los tests que deforman el esquema a proposito (los de
    `test_migracion.py`: ensanchan columnas, las borran, quitan FKs e indices) y
    para los que tocan `alembic_version` o corren migraciones (los de
    `test_alembic.py`).

    **La conexion va en AUTOCOMMIT a proposito.** Estos tests sueltan DDL
    (`ALTER TABLE`, `DROP INDEX`) y luego llaman a `init_schema()`, que abre su
    propia conexion. Con una transaccion abierta, la sesion del test tiene
    bloqueos sobre la tabla que acaba de tocar y Alembic se queda esperando un
    `ACCESS EXCLUSIVE` que no va a llegar nunca: el test no puede terminar
    porque la sesion no se cierra, y la sesion no se cierra porque el test no
    termina. En AUTOCOMMIT cada sentencia cierra su transaccion y suelta los
    bloqueos al salir, y no hay nada que esperar.

    **Recrea tambien al salir.** Es lo que permite que `session` se limite a
    vaciar tablas: si un test deja el esquema roto y el siguiente se limita a un
    TRUNCATE, hereda el desastre. Con el teardown, quien ensucia limpia.
    """
    from app.db import SessionLocal, engine

    _recrea_el_esquema()
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        db = SessionLocal(bind=conn)
        try:
            yield db
        finally:
            db.close()
    _recrea_el_esquema()
