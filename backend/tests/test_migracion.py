"""Tests de la migracion implicita de `app.db`.

Sin Alembic, `init_schema()` es lo unico que mantiene el esquema al dia con
`models.py`. Estos tests fijan su comportamiento, que ya rompio dos veces:

  - `create_all` no altera tablas existentes, asi que anadir o ensanchar una
    columna no llegaba a la BD (bug: `referencia_del_contrato` se quedo en
    varchar(160) y la ingesta moria con StringDataRightTruncation).
  - quitar una relacion del modelo no quita su restriccion de la BD, y al
    reingestar saltaba `ForeignKeyViolation` con la `contracts_proceso_de_compra_fkey`
    obsoleta. Y al revÃ©s: si el calculo de "que es obsoleto" se equivoca, borra
    FKs legitimas (pasÃ³ con matches.tender_id y tender_actions.tender_id).
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app import db
from app.models import Contract, Match, TenderAction


def _fks(esquema_limpio, tabla: str) -> set[str]:
    """Columnas de `tabla` cubiertas por alguna FK. Se nomenclature de la BD
    (`contrato_proceso_id_fkey`) no importa para estas aserciones."""
    por_restriccion = db._fks_de_la_tabla(esquema_limpio.connection(), tabla)
    return set().union(*por_restriccion.values()) if por_restriccion else set()


def _columnas(esquema_limpio, tabla: str) -> dict[str, int]:
    filas = esquema_limpio.execute(
        text(
            "SELECT column_name, character_maximum_length FROM information_schema.columns "
            "WHERE table_name = :t"
        ),
        {"t": tabla},
    ).fetchall()
    return {n: l for n, l in filas}


def _indices(esquema_limpio) -> set[str]:
    filas = esquema_limpio.execute(
        text(
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname = current_schema()"
        )
    ).fetchall()
    return {f[0] for f in filas}


def test_ensancha_una_columna_estrecha(esquema_limpio):
    esquema_limpio.execute(text("ALTER TABLE contracts ALTER COLUMN ciudad TYPE varchar(10)"))
    assert _columnas(esquema_limpio, "contracts")["ciudad"] == 10

    db._widen_narrow_columns(esquema_limpio.connection())

    assert _columnas(esquema_limpio, "contracts")["ciudad"] == 120


def test_no_estrecha_nunca(esquema_limpio):
    """Estrechar perderia datos ya escritos, asi que no se hace nunca."""
    esquema_limpio.execute(text("ALTER TABLE contracts ALTER COLUMN ciudad TYPE varchar(400)"))
    assert _columnas(esquema_limpio, "contracts")["ciudad"] == 400

    db._widen_narrow_columns(esquema_limpio.connection())

    assert _columnas(esquema_limpio, "contracts")["ciudad"] == 400


def test_ensanchar_es_idempotente(esquema_limpio):
    esquema_limpio.execute(text("ALTER TABLE contracts ALTER COLUMN ciudad TYPE varchar(10)"))
    db._widen_narrow_columns(esquema_limpio.connection())
    db._widen_narrow_columns(esquema_limpio.connection())
    assert _columnas(esquema_limpio, "contracts")["ciudad"] == 120


def test_annade_una_columna_que_falta(esquema_limpio):
    esquema_limpio.execute(text("ALTER TABLE contracts DROP COLUMN notice_uid"))
    assert "notice_uid" not in _columnas(esquema_limpio, "contracts")

    db._add_missing_columns(esquema_limpio.connection())

    assert "notice_uid" in _columnas(esquema_limpio, "contracts")


def test_no_toca_una_tabla_inexistente(esquema_limpio):
    """Una tabla que aun no existe la crea `create_all`, no esta migracion."""
    esquema_limpio.execute(text("DROP TABLE IF EXISTS sync_runs"))
    db._add_missing_columns(esquema_limpio.connection())
    existe = esquema_limpio.execute(
        text("SELECT to_regclass('sync_runs')")
    ).scalar()
    assert existe is None


def test_annade_la_fk_que_falta(esquema_limpio):
    esquema_limpio.execute(text("ALTER TABLE contracts DROP CONSTRAINT contracts_proceso_id_fkey"))
    assert "proceso_id" not in _fks(esquema_limpio, "contracts")

    db._add_missing_foreign_keys(esquema_limpio.connection())

    assert "proceso_id" in _fks(esquema_limpio, "contracts")


def test_no_recrea_una_fk_que_ya_esta(esquema_limpio):
    antes = _fks(esquema_limpio, "contracts")
    db._add_missing_foreign_keys(esquema_limpio.connection())
    assert _fks(esquema_limpio, "contracts") == antes


class TestFksObsoletas:
    def test_quita_la_fk_que_el_modelo_ya_no_declara(self, esquema_limpio):
        """`proceso_de_compra` dejo de ser FK; su restriccion se quedaba puta."""
        esquema_limpio.execute(
            text(
                "ALTER TABLE contracts ADD CONSTRAINT contracts_proceso_de_compra_fkey "
                "FOREIGN KEY (proceso_de_compra) REFERENCES tenders (id_del_proceso) "
                "ON DELETE SET NULL"
            )
        )
        assert "proceso_de_compra" in _fks(esquema_limpio, "contracts")

        db._drop_stale_foreign_keys(esquema_limpio.connection())

        assert "proceso_de_compra" not in _fks(esquema_limpio, "contracts")

    @pytest.mark.parametrize(
        "tabla,columna", [("matches", "tender_id"), ("tender_actions", "tender_id")]
    )
    def test_no_toca_fks_que_el_modelo_si_declara(self, esquema_limpio, tabla, columna):
        """Regresion: comparar por `target_fullname` (que es la columna
        referenciada, no la tabla) daba por obsoletas FKs legitimas y las
        borraba de la BD de verdad."""
        modelo = {"matches": Match, "tender_actions": TenderAction}[tabla]
        declaradas = {fk.parent.name for fk in modelo.__table__.foreign_keys}
        assert columna in declaradas, "el fixture ya no aplica: el modelo cambio"

        db._drop_stale_foreign_keys(esquema_limpio.connection())

        assert columna in _fks(esquema_limpio, tabla)

    def test_conserva_la_de_contracts_actual(self, esquema_limpio):
        antes = _fks(esquema_limpio, "contracts")
        db._drop_stale_foreign_keys(esquema_limpio.connection())
        assert _fks(esquema_limpio, "contracts") == antes
        assert "proceso_id" in antes


class TestIndicesQueFaltan:
    """`create_all` no crea indices en tablas que ya existen.

    Y la migracion implicita, hasta que se le anadio `_add_missing_indices()`,
    solo miraba columnas. Al meter `notice_uid` y `proceso_id` para el enlace
    contrato<->proceso (bug #10) las columnas llegaron a la base de las 135.000
    filas pero sus indices nunca: el enlace se resolvia con un seq scan sobre
    75.434 x 135.600 en cada pasada. No daba error, solo tardaba.
    """

    def test_crea_el_indice_que_falta(self, esquema_limpio):
        esquema_limpio.execute(text("DROP INDEX IF EXISTS ix_contracts_notice_uid"))
        assert "ix_contracts_notice_uid" not in _indices(esquema_limpio)

        db._add_missing_indexes(esquema_limpio.connection())

        assert "ix_contracts_notice_uid" in _indices(esquema_limpio)

    def test_es_idempotente(self, esquema_limpio):
        db._add_missing_indexes(esquema_limpio.connection())
        antes = _indices(esquema_limpio)
        db._add_missing_indexes(esquema_limpio.connection())
        assert _indices(esquema_limpio) == antes

    def test_respeta_el_unico_de_id_del_proceso(self, esquema_limpio):
        """`id_del_proceso` es clave unica: su indice tambien tiene que serlo.

        Crear el indice sin el UNIQUE daria un esquema mas laxo que el del
        modelo, que es justo lo que `alembic check` marca como pendiente.
        """
        unique = esquema_limpio.execute(
            text(
                "SELECT indexdef FROM pg_indexes "
                "WHERE schemaname = current_schema() AND indexname = 'ix_tenders_id_del_proceso'"
            )
        ).scalar()
        assert "UNIQUE" in unique.upper()

    def test_no_toca_una_tabla_inexistente(self, esquema_limpio):
        esquema_limpio.execute(text("DROP TABLE IF EXISTS sync_runs"))
        db._add_missing_indexes(esquema_limpio.connection())
        assert esquema_limpio.execute(text("SELECT to_regclass('sync_runs')")).scalar() is None
