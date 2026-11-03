"""Tests de la ingesta: troceado, deduplicado y upsert contra Postgres real.

Cada test de aqui existe porque hubo un bug que llego a produccion:

- `_chunks`  -> bug #7, `number of parameters must be between 0 and 65535`
- `_dedup`   -> bug #8, `ON CONFLICT DO UPDATE command cannot affect row a
                 second time` (el dataset publica el mismo proceso varias veces)

Los dos solo se reproducen con la ventana completa. Con el `--limite 100` del
CLI no se ven, que es exactamente como llegaron a la base de datos.
"""

from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import func, select

from app.ingest.upsert import MAX_BIND_PARAMS, _chunks, _dedup, bulk_upsert, existing_keys
from app.models import Contract, Tender


def _fila(i: int, **extra) -> dict:
    base = {
        "id_del_proceso": f"CO1.REQ.{i}",
        "entidad": "ENTIDAD DE PRUEBA",
        "precio_base": 1_000_000.0 + i,
        "modalidad_de_contratacion": "Subasta",
        "fecha_publicacion": dt.datetime(2026, 9, 24, tzinfo=dt.timezone.utc),
        "origen": "test",
    }
    base.update(extra)
    return base


# --- _chunks: el bug #7 --------------------------------------------------
class TestChunks:
    def test_lote_nunca_excede_el_tope_de_bind_params(self):
        columnas = 31
        por_lote = MAX_BIND_PARAMS // columnas
        for total in (1, 100, 2113, 2114, 2115, 2700, 80_000):
            for lote in _chunks(list(range(total)), columnas):
                assert len(lote) * columnas <= MAX_BIND_PARAMS, (
                    f"{total} filas: un lote de {len(lote)} pasa de "
                    f"{MAX_BIND_PARAMS} parametros"
                )

    def test_no_se_pierde_ninguna_fila(self):
        for total in (0, 1, 100, 2113, 2114, 5000):
            trozos = _chunks(list(range(total)), 31)
            assert sum(len(t) for t in trozos) == total
            assert [x for t in trozos for x in t] == list(range(total)), "el orden no debe cambiar"

    def test_una_fila_entera_cabe_en_un_lote(self):
        assert len(_chunks(list(range(10)), 1)) == 1

    def test_columnas_invalidas(self):
        with pytest.raises(ValueError):
            _chunks([1, 2, 3], 0)


# --- _dedup: el bug #8 ---------------------------------------------------
class TestDedup:
    def test_colapsa_claves_repetidas(self):
        payload = [_fila(1), _fila(2), _fila(1), _fila(3), _fila(2)]
        salida = _dedup(payload, "id_del_proceso")
        assert len(salida) == 3
        assert [f["id_del_proceso"] for f in salida] == ["CO1.REQ.1", "CO1.REQ.2", "CO1.REQ.3"]

    def test_gana_la_primera_ocurrencia(self):
        """El extractor ordena por `fecha_de_publicacion_del DESC`, y en orden
        descendente la PRIMERA de una clave es la mas reciente.

        Este test fijo la eleccion: el comentario anterior de `_dedup` decia que
        la ultima era la mas nueva, que es justo lo contrario, y el codigo se
        quedaba con la ultima.
        """
        nueva = _fila(1, precio_base=999.0)
        vieja = _fila(1, precio_base=100.0)
        salida = _dedup([nueva, vieja], "id_del_proceso")
        assert len(salida) == 1
        assert salida[0]["precio_base"] == 999.0

    def test_conserva_el_orden_de_la_primera_aparicion(self):
        """Quedarse con la primera no puede reordenar el lote: el orden de
        Socrata es el que fija el corte de fecha de la ventana."""
        payload = [_fila(1, precio_base=1.0), _fila(2), _fila(1, precio_base=2.0), _fila(3)]
        salida = _dedup(payload, "id_del_proceso")
        assert [f["id_del_proceso"] for f in salida] == ["CO1.REQ.1", "CO1.REQ.2", "CO1.REQ.3"]
        assert salida[0]["precio_base"] == 1.0

    def test_no_toca_payload_sin_duplicados(self):
        payload = [_fila(i) for i in range(50)]
        assert _dedup(payload, "id_del_proceso") == payload

    def test_vacio(self):
        assert _dedup([], "id_del_proceso") == []


# --- bulk_upsert contra Postgres -----------------------------------------
class TestBulkUpsert:
    def test_inserta_y_cuenta_nuevas(self, session):
        payload = [_fila(i) for i in range(10)]
        nuevas, actualizadas = bulk_upsert(session, Tender, payload, "id_del_proceso")
        assert (nuevas, actualizadas) == (10, 0)
        assert session.scalar(select(func.count()).select_from(Tender)) == 10

    def test_es_idempotente(self, session):
        payload = [_fila(i) for i in range(10)]
        bulk_upsert(session, Tender, payload, "id_del_proceso")
        nuevas, actualizadas = bulk_upsert(session, Tender, payload, "id_del_proceso")
        assert nuevas == 0
        assert actualizadas == 10
        assert session.scalar(select(func.count()).select_from(Tender)) == 10

    def test_payload_vacio(self, session):
        assert bulk_upsert(session, Tender, [], "id_del_proceso") == (0, 0)

    def test_supera_el_tope_de_bind_params(self, session):
        """El bug #7: 2.114 filas x 31 columnas = 65.534 parametros en un lote."""
        total = (MAX_BIND_PARAMS // len(Tender.__table__.columns)) * 2 + 50
        payload = [_fila(i) for i in range(total)]
        params = total * len(Tender.__table__.columns)
        assert params > MAX_BIND_PARAMS, "el test no ejercitaria el troceado"

        nuevas, actualizadas = bulk_upsert(session, Tender, payload, "id_del_proceso")
        assert nuevas == total
        assert actualizadas == 0
        assert session.scalar(select(func.count()).select_from(Tender)) == total

    def test_claves_repetidas_no_revientan_postgres(self, session):
        """El bug #8: mismo id dos veces en el payload."""
        payload = [_fila(i % 5) for i in range(200)]
        assert len(payload) == 200
        assert len({f["id_del_proceso"] for f in payload}) == 5

        nuevas, actualizadas = bulk_upsert(session, Tender, payload, "id_del_proceso")
        assert nuevas == 5
        assert actualizadas == 0
        assert session.scalar(select(func.count()).select_from(Tender)) == 5

    def test_actualiza_el_valor_mas_reciente(self, session):
        bulk_upsert(session, Tender, [_fila(1, precio_base=100.0)], "id_del_proceso")
        bulk_upsert(session, Tender, [_fila(1, precio_base=555.0)], "id_del_proceso")
        precio = session.scalar(select(Tender.precio_base).where(Tender.id_del_proceso == "CO1.REQ.1"))
        assert precio == 555.0

    def test_no_crea_duplicados_en_la_tabla(self, session):
        payload = [_fila(i % 3) for i in range(100)]
        bulk_upsert(session, Tender, payload, "id_del_proceso")
        bulk_upsert(session, Tender, payload, "id_del_proceso")
        ids = session.execute(select(Tender.id_del_proceso)).scalars().all()
        assert len(ids) == len(set(ids)) == 3


# --- existing_keys: el mismo tope, en el SELECT --------------------------
class TestExistingKeys:
    def test_detecta_las_que_ya_existen(self, session):
        bulk_upsert(session, Tender, [_fila(i) for i in range(5)], "id_del_proceso")
        session.flush()
        claves = [f"CO1.REQ.{i}" for i in range(10)]
        assert existing_keys(session, Tender, "id_del_proceso", claves) == {
            f"CO1.REQ.{i}" for i in range(5)
        }

    def test_trocea_una_ventana_enorme(self, session):
        """Con 30 dias son ~137.000 claves: en una sola sentencia reventaria."""
        claves = [f"CO1.REQ.{i}" for i in range(MAX_BIND_PARAMS + 25_000)]
        assert existing_keys(session, Tender, "id_del_proceso", claves) == set()

    def test_sin_claves(self, session):
        assert existing_keys(session, Tender, "id_del_proceso", []) == set()


# --- contratos: la FK con procesos ---------------------------------------
class TestContratos:
    def test_enlaza_por_notice_uid_y_no_por_id(self, session):
        """El enlace tiene que ir por `notice_uid`.

        `proceso_de_compra` trae `CO1.PCCNTR.*` (id de contrato) y
        `tenders.id_del_proceso` trae `CO1.REQ.*`: cruzar por ahi daria siempre
        0% enlazado. Lo unico comun es el `noticeUID` de la URL.
        """
        from app.ingest.secop_contratos import attach_known_tenders

        bulk_upsert(
            session,
            Tender,
            [{"id_del_proceso": "CO1.REQ.1", "notice_uid": "CO1.NTC.555"}],
            "id_del_proceso",
        )
        session.flush()

        payload = [
            {"id_contrato": "C1", "notice_uid": "CO1.NTC.555", "proceso_de_compra": "CO1.PCCNTR.9"},
            {"id_contrato": "C2", "notice_uid": "CO1.NTC.999", "proceso_de_compra": "CO1.PCCNTR.8"},
            {"id_contrato": "C3", "notice_uid": None, "proceso_de_compra": None},
        ]
        huerfanos = attach_known_tenders(session, payload)

        assert huerfanos == 2
        assert payload[0]["proceso_id"] == "CO1.REQ.1"
        assert payload[1]["proceso_id"] is None
        assert payload[2]["proceso_id"] is None
        # El valor crudo de SECOP se conserva intacto: no es la FK.
        assert payload[0]["proceso_de_compra"] == "CO1.PCCNTR.9"

    def test_notice_uid_se_extrae_de_la_url(self):
        from app.ingest.socrata import notice_uid as extraer

        url = (
            "https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index"
            "?noticeUID=CO1.NTC.10951052&isFromPublicArea=True"
        )
        assert extraer(url) == "CO1.NTC.10951052"
        assert extraer("https://community.secop.gov.co/otra/cosa") is None
        assert extraer(None) is None
        assert extraer("") is None

    def test_huerfanos_se_anulan_en_vez_de_romper(self, session):
        from app.ingest.secop_contratos import attach_known_tenders

        bulk_upsert(session, Tender, [_fila(1), _fila(2)], "id_del_proceso")
        session.flush()

        payload = [
            {"id_contrato": "C1", "notice_uid": "CO1.NTC.1", "proceso_de_compra": "CO1.REQ.1"},
            {"id_contrato": "C2", "notice_uid": "CO1.NTC.2", "proceso_de_compra": "NO-EXISTE"},
            {"id_contrato": "C3", "notice_uid": None, "proceso_de_compra": None},
        ]
        huerfanos = attach_known_tenders(session, payload)
        assert huerfanos == 3
        assert all(p["proceso_id"] is None for p in payload)

    def test_upsert_de_contratos_con_manyas_claves(self, session):
        """La ventana de 30 dias son ~19.000 contratos: `IN (...)` sin trocear
        llegaria al tope de bind params."""
        from app.ingest.secop_contratos import upsert_contracts

        total = MAX_BIND_PARAMS + 5_000
        payload = [
            {
                "id_contrato": f"CT-{i}",
                "proceso_de_compra": None,
                "valor_del_contrato": 1000.0 + i,
            }
            for i in range(total)
        ]
        res = upsert_contracts(session, payload)
        assert res.inserted == total
        assert session.scalar(select(func.count()).select_from(Contract)) == total


# --- valores que no caben en la columna -------------------------------------
class TestTextosQueNoCaben:
    """Regresion del bug que tumbaba la ingesta completa de contratos.

    181 filas del dataset oficial meten el objeto entero del contrato en
    `referencia_del_contrato`, que se declaro como `varchar(160)`. Postgres
    abortaba los ~100.000 registros del lote con
    `value too long for type character varying(160)`.
    """

    def test_fit_to_model_recorta_y_avisa(self, caplog):
        from app.ingest.socrata import fit_to_model

        largo = "PRESTAR APOYO TECNICO " * 40
        payload = {"id_contrato": "C1", "referencia_del_contrato": largo}

        with caplog.at_level("WARNING"):
            out = fit_to_model(Contract, payload)

        assert len(largo) > 600
        assert len(out["referencia_del_contrato"]) == 600
        assert "excede 600 caracteres" in caplog.text

    def test_fit_to_model_no_toca_lo_que_cabe(self):
        from app.ingest.socrata import fit_to_model

        payload = {"id_contrato": "C1", "referencia_del_contrato": "REF-123", "ciudad": "Cali"}
        assert fit_to_model(Contract, payload) == payload

    def test_fit_to_model_es_inocuo_con_ceros_y_nulos(self):
        from app.ingest.socrata import fit_to_model

        payload = {"id_contrato": "C1", "valor_del_contrato": 0.0, "fecha_de_firma": None}
        assert fit_to_model(Contract, payload) == payload

    def test_una_fila_larga_no_tumba_el_lote(self, session):
        """La garantia que de verdad importa: el resto del lote se guarda."""
        from app.ingest.secop_contratos import upsert_contracts

        payload = [{"id_contrato": f"CT-{i}", "referencia_del_contrato": "x" * 400} for i in range(50)]
        payload[7]["referencia_del_contrato"] = "y" * 5000

        res = upsert_contracts(session, payload)

        assert res.inserted == 50
        assert session.scalar(select(func.count()).select_from(Contract)) == 50
        larga = session.scalar(
            select(Contract.referencia_del_contrato).where(Contract.id_contrato == "CT-7")
        )
        assert len(larga) == 600

    def test_la_columna_da_de_bajo_al_dato_real(self):
        """Guarda contra volver a estrechar la columna: el ancho declarado tiene
        que aguantar los 200+ caracteres que sí manda Socrata."""
        ancho = Contract.__table__.c.referencia_del_contrato.type.length
        assert ancho >= 300, (
            f"referencia_del_contrato es varchar({ancho}); el dataset trae textos de "
            "200+ caracteres y la ingesta volveria a morir con StringDataRightTruncation"
        )
