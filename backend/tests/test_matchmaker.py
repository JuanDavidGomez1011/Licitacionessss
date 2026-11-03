"""Seleccion de candidatos del matchmaker.

Lo que estos tests fijan es que **contar pendientes no los trae**. No es una
optimizacion menor: `embed_profile` se llama en cada ciclo de 30 minutos y
usaba `len(_pendientes(limit=None))` para un numero que solo va al log. Con los
336.000 procesos cargados, cada ciclo hidrataba 336.000 objetos ORM para
descontarlos, y el barrido completo pasaba de ~100 filas/s a ~19.
"""

from __future__ import annotations

import pytest

from app.ai.matchmaker import _contar_pendientes, _pendientes


def _tender(i: int):
    from app.models import Tender

    return Tender(
        id_del_proceso=f"CO1.REQ.{i}",
        nombre_del_procedimiento=f"proceso {i}",
        descripcion=f"descripcion {i}",
        fecha_publicacion="2026-09-20",
    )


def _match(i: int):
    from app.models import Match

    return Match(tender_id=f"CO1.REQ.{i}", score=50, semantic_similarity=0.5, model="vectorial")


@pytest.fixture
def con_datos(session):
    session.add_all([_tender(i) for i in range(1, 11)])
    session.flush()
    # 1, 2 y 3 ya estan puntuados
    session.add_all([_match(1), _match(2), _match(3)])
    session.flush()
    return session


def test_cuenta_las_que_faltan(con_datos):
    assert _contar_pendientes(con_datos) == 7


def test_las_pendientes_estan_entre_las_no_puntuadas(con_datos):
    ids = {t.id_del_proceso for t in _pendientes(con_datos, limit=None)}
    assert "CO1.REQ.1" not in ids
    assert "CO1.REQ.2" not in ids
    assert "CO1.REQ.3" not in ids
    assert len(ids) == 7


def test_contar_no_hidrata_las_filas(con_datos, monkeypatch):
    """La garantia que importa: contar no puede pasar por `_pendientes`.

    Si alguien "optimiza" `_contar_pendientes` Trayendo las filas otra vez, este
    test falla en vez de volver a costing 19 filas/s.
    """
    import app.ai.matchmaker as mm

    def _explota(*_a, **_k):
        raise AssertionError("_pendientes() no se debe llamar para contar")

    monkeypatch.setattr(mm, "_pendientes", _explota)
    assert _contar_pendientes(con_datos) == 7


def test_el_limite_no_afecta_al_conteo(con_datos):
    assert _contar_pendientes(con_datos) == 7
    assert len(_pendientes(con_datos, limit=2)) == 2
    assert _contar_pendientes(con_datos) == 7


def test_cuando_todo_esta_puntuado_el_conteo_es_cero(con_datos):
    session = con_datos
    session.add_all([_match(i) for i in range(4, 11)])
    session.flush()
    assert _contar_pendientes(session) == 0
    assert _pendientes(session, limit=None) == []


# --- la ruta vectorial tambien tiene que obedecer las reglas ----------------
def _perfil():
    from app.models import CompanyProfile

    return CompanyProfile(
        nombre="Proveedor de software",
        descripcion="desarrollo y soporte de software",
        actividades=["desarrollo de software"],
        palabras_clave=["software"],
        presupuesto_minimo=20_000_000,
        presupuesto_maximo=500_000_000,
        modalidades_preferidas=["Licitacion publica"],
        departamentos_preferidos=["Bogota D.C."],
        exclusiones=["obra publica"],
    )


def _candidato(
    precio: float = 100_000_000,
    modalidad: str = "Licitacion publica",
    departamento: str = "Bogota D.C.",
    titulo: str = "PRESTAR SERVICIOS DE SOFTWARE",
    similitud: float = 0.78,
):
    from app.ai.matchmaker import Candidate
    from app.models import Tender

    t = Tender(
        id_del_proceso="CO1.REQ.1",
        nombre_del_procedimiento=titulo,
        descripcion="desarrollo y soporte de software",
        precio_base=precio,
        modalidad_de_contratacion=modalidad,
        departamento_entidad=departamento,
    )
    return Candidate(tender=t, similarity=similitud)


def _score(cand) -> dict:
    from app.ai.matchmaker import ScoreResult, _score_batch

    out = _score_batch([cand], None, _perfil(), False, ["software"], ScoreResult())
    assert len(out) == 1
    return out[0]


# Con similitud 0.78 el score vectorial es (0.78-0.45)/(0.88-0.45)*100 = 77.
# La mezcla es 35% vectorial + 65% veredicto, pero el tope de las reglas se
# aplica DESPUES de mezclar: sin ese recorte, un presupuesto por debajo del
# minimo puntuaria 0.35*77 + 0.65*20 = 40 en vez de 20.
VEC = 77


def test_la_ruta_vectorial_topea_el_presupuesto():
    """El bug: la tarjeta decia 'presupuesto por debajo del minimo' y aun asi
    puntuaba como la similitud vectorial, sin aplicar el veredicto."""
    payload = _score(_candidato(precio=1_800_000))
    assert payload["score"] == 20
    assert any("minimo" in b for b in payload["bullets"])


def test_el_tope_de_las_reglas_vence_a_la_mezcla():
    """El corte de las reglas tiene que ser el score final, no un descuento.

    Mezclar y luego topar no es topar la mezcla: con el 35% vectorial metido, un
    tope de 20 daba 40. Y una exclusion del perfil (tope 5) daba 27, o sea que
    el vector le hacia caso omiso a una exclusion.
    """
    from app.ai.rules import CAP_BUDGET, CAP_EXCLUSION

    assert CAP_BUDGET < 0.35 * VEC  # por eso la mezcla sola se salta el tope
    # presupuesto por debajo del minimo -> CAP_BUDGET exacto
    assert _score(_candidato(precio=1_800_000))["score"] == CAP_BUDGET
    # exclusion del perfil -> 0, no un 27 derived de la similitud
    assert _score(_candidato(titulo="CONSTRUCCION DE OBRA PUBLICA"))["score"] == 0
    assert CAP_EXCLUSION == 5


def test_la_ruta_vectorial_penaliza_modalidad_y_territorio():
    limpio = _score(_candidato())
    peor = _score(_candidato(modalidad="Minima cuantia", departamento="Sucre"))
    # 25 puntos de penalizacion (15 modalidad + 10 territorio) sobre el 65% que
    # pesa el veredicto: 0.65*25 = 16
    assert limpio["score"] == VEC
    assert peor["score"] == VEC - 16


def test_sin_veredicto_el_vector_no_se_mueve():
    payload = _score(_candidato())
    assert payload["score"] == VEC
    assert payload["model"] == "vectorial"
    assert payload["bullets"] == []
