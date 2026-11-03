"""Tests de las migraciones de Alembic.

Alembic sustituyo a la migracion implicita de `app/db.py` como camino normal, asi
que lo que hay que fijar es:

  - que `models.py` y lo que crea `0001` son **lo mismo**. Si divergen, cada
    despliegue nace con un esquema distinto segun como se haya hecho, y el
    error sale en produccion. Esto no lo detectaba nadie: `create_all` crea lo
    que falta y la migracion implicita avisa de lo que reconcilia, pero ninguna
    de las dos cosas sabe si el conjunto esta completo. Lo destapo `alembic
    check` al adoptionar Alembic, y immediately aparecieron 3 indices que el
    modelo declaraba y la base de las 135.000 filas no tenia.
  - que el camino de una base heredada (sin `alembic_version`) no destroys datos
    ni intenta aplicar `0001` encima de tablas que ya existen.
  - que correr migraciones al arrancar la API no apaga los logs de la app.
"""

from __future__ import annotations

import logging

from sqlalchemy import text

from app import db
from app.config import settings

HEAD = "0001_esquema_inicial"


def _revision() -> str | None:
    with db.engine.connect() as conn:
        return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()


def _tablas(esquema_limpio) -> set[str]:
    filas = esquema_limpio.execute(
        text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
    ).fetchall()
    return {f[0] for f in filas}


# --- la migracion y el modelo no pueden divergir -----------------------------
def test_la_migracion_reproduce_el_esquema_del_modelo(esquema_limpio):
    """Lo central: tras `upgrade head` no queda nada por migrar.

    Si este test falla, `models.py` cambio sin que nadie escribiera la
    migracion (o al reves). Se arregla con
    `alembic revision --autogenerate -m "..."`, revisando el DDL que sale.
    """
    assert db.pendientes_de_migrar() == []


def test_alembic_check_da_limpio(esquema_limpio):
    """El mismo chequeo por la via de la CLI, que es la que se usa a mano."""
    from alembic import command

    # `alembic check` sale con codigo 1 y avisa por stderr si hay pendientes.
    command.check(db._config_alembic())


def test_la_extension_vector_la_crea_la_migracion(esquema_limpio):
    """`init_schema` la creaba en cada arranque; ahora la migracion la trae.

    Sin ella, la busqueda semantica no tiene con que trabajar aunque la base
    venga de una migracion.
    """
    version = esquema_limpio.execute(
        text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
    ).scalar()
    assert version is not None


# --- upgrade / downgrade ----------------------------------------------------
def test_upgrade_es_idempotente(esquema_limpio):
    db.upgrade_head()
    db.upgrade_head()
    assert _revision() == HEAD
    assert db.pendientes_de_migrar() == []


def test_downgrade_deja_la_base_sin_tablas_de_la_app(esquema_limpio):
    from alembic import command

    command.downgrade(db._config_alembic(), "base")

    assert not _tablas(esquema_limpio) & {t.name for t in db.Base.metadata.sorted_tables}
    # La extension no se toca: es de la base, no de la migracion.
    assert esquema_limpio.execute(
        text("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
    ).scalar() == 1


def test_downgrade_y_upgrade_de_vuelta(esquema_limpio):
    """Bajar y subir tiene que devolver el mismo esquema, no uno aproximado."""
    from alembic import command

    antes = sorted(_tablas(esquema_limpio))
    command.downgrade(db._config_alembic(), "base")
    command.upgrade(db._config_alembic(), "head")

    assert sorted(_tablas(esquema_limpio)) == antes
    assert _revision() == HEAD
    assert db.pendientes_de_migrar() == []


# --- base heredada: la que creo create_all antes de Alembic -----------------
class TestBaseHeredada:
    """Una base con el esquema pero sin `alembic_version`.

    Es lo que hay en cualquier instalacion anterior a Alembic.
    """

    def test_no_se_confunde_con_una_base_vacia(self, esquema_limpio):
        """Una base recien creada no es "heredada": la construye `0001`."""
        esquema_limpio.execute(text("DROP SCHEMA public CASCADE"))
        esquema_limpio.execute(text("CREATE SCHEMA public"))

        assert db._base_heredada() is False

    def test_se_reconoce_cuando_falta_la_version(self, esquema_limpio):
        esquema_limpio.execute(text("DROP TABLE alembic_version"))
        assert db._base_heredada() is True

    def test_sella_en_head_sin_tocar_los_datos(self, esquema_limpio):
        from app.models import Tender

        esquema_limpio.add(Tender(id_del_proceso="CO1.REQ.1", origen="test"))
        esquema_limpio.commit()
        esquema_limpio.execute(text("DROP TABLE alembic_version"))

        db.init_schema()

        assert _revision() == HEAD
        assert esquema_limpio.get(Tender, 1) is not None

    def test_no_intenta_aplicar_0001_sobre_tablas_existentes(self, esquema_limpio):
        """Si se aplicara, `0001` reventaria con "relation already exists".

        Es el motivo de que este camino exista: no es una comodidad, es lo que
        hace que adoptar Alembic no sea una operacion que tira la base.
        """
        esquema_limpio.execute(text("DROP TABLE alembic_version"))

        db.init_schema()  # no debe lanzar

        assert _revision() == HEAD

    def test_crea_los_indices_que_la_migracion_implicita_no_creaba(self, esquema_limpio):
        """El agujero que dejÃ³ el bug #10: columnas sin indice.

        `create_all` no crea indices en tablas existentes, asi que
        `notice_uid` y `proceso_id` llegaron a la base sin los suyos y el
        enlace contrato<->proceso se resolvia con un seq scan de 75.434 x
        135.600 filas en cada pasada.
        """
        esquema_limpio.execute(text("DROP TABLE alembic_version"))
        esquema_limpio.execute(text("DROP INDEX IF EXISTS ix_contracts_notice_uid"))
        esquema_limpio.execute(text("DROP INDEX IF EXISTS ix_contracts_proceso_id"))
        esquema_limpio.execute(text("DROP INDEX IF EXISTS ix_tenders_notice_uid"))

        db.init_schema()

        with db.engine.connect() as conn:
            indices = {
                f[0]
                for f in conn.execute(
                    text("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")
                )
            }
        assert {
            "ix_contracts_notice_uid",
            "ix_contracts_proceso_id",
            "ix_tenders_notice_uid",
        } <= indices

    def test_es_idempotente(self, esquema_limpio):
        esquema_limpio.execute(text("DROP TABLE alembic_version"))
        db.init_schema()
        db.init_schema()
        assert _revision() == HEAD
        assert db.pendientes_de_migrar() == []


# --- efectos colaterales de correr migraciones en la app ---------------------
def test_correr_migraciones_no_apaga_los_logs(esquema_limpio, caplog):
    """Regresion: `alembic/env.py` llamaba a `fileConfig` con su valor por
    defecto, `disable_existing_loggers=True`, que apaga todos los loggers de
    `app.*` la PRIMERA VEZ que se corre una migracion. Como `init_schema()` se
    llama en cada arranque de la API, la aplicacion se quedaba sin registrar a
    partir de ahi, sin dar ningun error."""
    logger = logging.getLogger("app.ingest.socrata")
    logger.warning("antes de migrar")

    with caplog.at_level(logging.WARNING):
        db.init_schema()
        logger.warning("despues de migrar")

    assert "antes de migrar" in caplog.text
    assert "despues de migrar" in caplog.text, "init_schema() dejo el logger sin propagar"


def test_las_migraciones_van_a_la_misma_base_que_la_app(esquema_limpio):
    """`_config_alembic()` fuerza la URL desde `settings`.

    Si se dejara la del `.ini` o la del entorno, se podria migrar una base y
    servir otra, sin que nada lo dijera.
    """
    cfg = db._config_alembic()
    assert cfg.get_main_option("sqlalchemy.url") == settings.database_url
    assert settings.pg_database in cfg.get_main_option("sqlalchemy.url")


def test_las_rutas_de_alembic_no_son_relativas(esquema_limpio):
    """`init_schema()` se llama desde uvicorn, cuya raiz no es `backend/`.

    Con `script_location = alembic` tal cual, desde ahi no se encuentra el
    directorio de migraciones.
    """
    import os

    cfg = db._config_alembic()
    assert os.path.isabs(cfg.get_main_option("script_location"))
    assert os.path.isdir(cfg.get_main_option("script_location"))


def test_current_revision_no_revienta_si_falta_la_tabla(esquema_limpio):
    """`current_revision()` se llama para diagnostico: tiene que poder decir
    "no hay" sin que sea un error."""
    esquema_limpio.execute(text("DROP TABLE IF EXISTS alembic_version"))
    assert db.current_revision() is None
