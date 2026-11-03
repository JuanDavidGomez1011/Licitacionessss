"""Entorno de Alembic.

Dos decisiones que importan:

1. **La URL no vive aqui.** Se toma de `ALEMBIC_DATABASE_URL` si esta definida y
   si no de `app.config.settings.database_url`, que a su vez sale de `.env`. Es la
   unica fuente de verdad: si la URL viviera en `alembic.ini`, la migracion y la
   app podrian apuntar a bases distintas sin que nadie se entere.

2. **`include_object` viene de `app.db`.** Filtra `alembic_version` para que
   autogenerate no la proponga como tabla a borrar, y de ahi sale tambien la
   comparacion que usan los tests, para que no puedan dejar de hablar.

`--autogenerate` compara el modelo contra la base. Para una migracion inicial
contra una base vacia da el `CREATE TABLE` de todo el esquema; a partir de ahi se
escribe a mano y se contrasta con `alembic check`.
"""


from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# `prepend_sys_path = .` cubre el caso normal (ejecutado desde `backend/`), pero
# los tests llaman a Alembic con la raiz del proyecto como cwd.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import settings  # noqa: E402
from app.db import include_object  # noqa: E402
from app.models import Base  # noqa: E402

config = context.config

if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    # `configure_logger` lo pone en False quien llama a Alembic desde la propia
    # aplicacion (`app/db.py`). `fileConfig` reconfigura los handlers del logger
    # raiz, y eso tiene dos efectos que rompen cosas:
    #
    #   - con su valor por defecto (`disable_existing_loggers=True`) apaga todos
    #     los loggers de `app.*` la primera vez que se corre una migracion, y
    #     como `init_schema()` se llama en cada arranque de la API, la aplicacion
    #     se queda sin registrar a partir de ahi, sin error.
    #   - aunque se ponga a False, quita y vuelve a poner los handlers de la
    #     raiz, con lo que se lleva por delante la configuracion de logging de
    #     la app y la captura de pytest.
    #
    # Desde la CLI (`alembic upgrade head`) si se configura, que es lo que hace
    # falta para ver el progreso de la migracion.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# Importar `app.models` registra todas las tablas en `Base.metadata`. Sin este
# import, `--autogenerate` no veria ninguna y propondría vaciar el esquema.
import app.models  # noqa: E402,F401

target_metadata = Base.metadata

_environ_url = os.environ.get("ALEMBIC_DATABASE_URL", "").strip()
if not _environ_url:
    _environ_url = config.get_main_option("sqlalchemy.url", "") or ""
if not _environ_url:
    _environ_url = settings.database_url

config.set_main_option("sqlalchemy.url", _environ_url.replace("%", "%%"))


def run_migrations_offline() -> None:
    """Genera el SQL sin conectarse (`alembic upgrade head --sql`)."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
