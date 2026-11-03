"""Mapeo de las filas de SECOP II a la estructura de OCDS (Open Contracting Data Standard).

Referencia: OCDS 1.1, release `tender` / `awards` / `contracts`.
El proposito no es producir un release completo y normativo, sino exponer campos con
nombres estables para permitir filtros, busquedas y la comparacion semantica
sin depender de los nombres de columna propios de Socrata.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

OCDS_VERSION = "1.1"
SECOP_DOMAIN = "https://www.datos.gov.co"

# estado SECOP -> status OCDS (planning, active, cancelled, complete, withdrawn)
_OCDS_STATUS: dict[str, str] = {
    "borrador": "planning",
    "planeado": "planning",
    "convocado": "active",
    "publicado": "active",
    "abierto": "active",
    "en curso": "active",
    "adjudicado": "active",
    "presentado": "active",
    "celebrado": "complete",
    "liquidado": "complete",
    "adjudicado fechado": "complete",
    "descartado": "withdrawn",
    "cancelado": "cancelled",
    "anulado": "cancelled",
    "suspendido": "cancelled",
    "terminado sin contrato": "withdrawn",
    "noEvaluable": "withdrawn",
}

# modalidad SECOP -> procurementMethod OCDS
_OCDS_METHOD: dict[str, str] = {
    "licitación pública": "open",
    "licitacion publica": "open",
    "selección directa": "direct",
    "seleccion directa": "direct",
    "subasta": "open",
    "consulta directa": "direct",
    "contratación directa": "direct",
    "contratacion directa": "direct",
    "acuerdo marco": "limited",
    "concurso": "selective",
    "open bidding": "open",
    "competitive dialogue": "selective",
    "direct contracting": "direct",
}

# codigos de duracion de SECOP
_DURATION_UNIT: dict[str, str] = {
    "días": "day",
    "dias": "day",
    "meses": "month",
    "mes": "month",
    "años": "year",
    "anos": "year",
    "a\u00f1o": "year",
    "d\u00eda": "day",
}


def ocds_status(estado: str | None) -> str:
    if not estado:
        return "active"
    return _OCDS_STATUS.get(estado.strip().lower(), "active")


def procurement_method(modalidad: str | None) -> str:
    if not modalidad:
        return "open"
    return _OCDS_METHOD.get(modalidad.strip().lower(), "open")


def duration_unit(unidad: str | None) -> str:
    if not unidad:
        return "day"
    return _DURATION_UNIT.get(unidad.strip().lower(), "day")


def _iso(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _money(amount: float | None) -> dict[str, Any] | None:
    if amount is None:
        return None
    return {"amount": round(float(amount), 2), "currency": "COP"}


def tender_to_ocds(t: Any) -> dict[str, Any]:
    """Serializa un ORM `Tender` como un release OCDS `tender`."""
    address = None
    if t.ciudad_entidad or t.departamento_entidad:
        address = {
            "locality": t.ciudad_entidad,
            "region": t.departamento_entidad,
            "countryName": "Colombia",
        }

    organization = None
    if t.entidad:
        organization = {
            "name": t.entidad,
            "identifier": {"scheme": "NIT", "id": t.nit_entidad} if t.nit_entidad else None,
            "address": address,
        }

    items = None
    if t.nombre_del_procedimiento or t.codigo_principal_categoria:
        items = [
            {
                "description": t.nombre_del_procedimiento or "",
                "classification": (
                    {
                        "scheme": "UNSPSC",
                        "id": t.codigo_principal_categoria,
                        "description": t.nombre_del_procedimiento,
                    }
                    if t.codigo_principal_categoria
                    else None
                ),
                "additionalClassifications": (
                    [{"scheme": "UNSPSC", "id": c.strip()} for c in t.categorias_adicionales.split(",") if c.strip()]
                    if t.categorias_adicionales
                    else None
                ),
            }
        ]

    release: dict[str, Any] = {
        "ocid": f"ocds-colombia-{t.id_del_proceso}",
        "id": t.id_del_proceso,
        "tag": ["tender"],
        "date": _iso(t.fecha_publicacion),
        "title": t.nombre_del_procedimiento,
        "description": t.descripcion or t.objeto_contrato,
        "status": ocds_status(t.estado_del_procedimiento),
        "value": _money(t.precio_base),
        "procurementMethod": procurement_method(t.modalidad_de_contratacion),
        "procurementMethodDetails": t.modalidad_de_contratacion,
        "procurementMethodRationale": t.justificacion_modalidad,
        "items": items,
        "organization": organization,
        "tenderPeriod": {
            "startDate": _iso(t.fecha_publicacion),
            "endDate": _iso(t.fecha_apertura_respuesta),
        },
        "enquiryPeriod": {
            "startDate": _iso(t.fecha_publicacion),
            "endDate": _iso(t.fecha_recepcion),
        },
        "lotDetails": (
            [{"id": str(i + 1)} for i in range(t.numero_de_lotes)] if t.numero_de_lotes else None
        ),
        "legalBasis": t.justificacion_modalidad,
        # campos de extension utiles para la app (no forman parte del esquema OCDS)
        "extensions": {
            "referenciaDelProceso": t.referencia_del_proceso,
            "duracion": t.duracion,
            "unidadDuracion": duration_unit(t.unidad_de_duracion),
            "estadoSecop": t.estado_del_procedimiento,
            "adjudicado": t.adjudicado,
            "tipoContrato": t.tipo_contrato,
            "subtipoContrato": t.subtipo_contrato,
            "urlProceso": t.url_proceso,
            "fuente": f"{SECOP_DOMAIN}/resource/{t.id_del_proceso}",
        },
    }
    return {k: v for k, v in release.items() if v is not None}


def contract_to_ocds(c: Any) -> dict[str, Any]:
    """Serializa un ORM `Contract` como un release OCDS `award` + `contract`."""
    address = None
    if c.ciudad or c.departamento:
        address = {"locality": c.ciudad, "region": c.departamento, "countryName": "Colombia"}

    return {
        "ocid": f"ocds-colombia-contract-{c.id_contrato}",
        "id": c.id_contrato,
        "tag": ["award", "contract"],
        "date": _iso(c.fecha_de_firma),
        "title": c.objeto_del_contrato or c.descripcion_del_proceso,
        "description": c.descripcion_del_proceso,
        "status": "active" if c.estado_contrato else "unknown",
        "value": _money(c.valor_del_contrato),
        "organization": (
            {
                "name": c.nombre_entidad,
                "identifier": {"scheme": "NIT", "id": c.nit_entidad} if c.nit_entidad else None,
                "address": address,
            }
            if c.nombre_entidad
            else None
        ),
        "awardId": c.proceso_de_compra,
        "period": {
            "startDate": _iso(c.fecha_de_inicio),
            "endDate": _iso(c.fecha_de_fin),
        },
        "suppliers": (
            [{"name": c.proveedor_adjudicado, "identifier": None}] if c.proveedor_adjudicado else None
        ),
        "items": (
            [
                {
                    "description": c.descripcion_del_proceso or c.objeto_del_contrato or "",
                    "classification": (
                        {
                            "scheme": "UNSPSC",
                            "id": c.codigo_de_categoria_principal,
                        }
                        if c.codigo_de_categoria_principal
                        else None
                    ),
                }
            ]
            if (c.descripcion_del_proceso or c.objeto_del_contrato)
            else None
        ),
        "extensions": {
            "referenciaDelContrato": c.referencia_del_contrato,
            "estadoContrato": c.estado_contrato,
            "valorPagado": c.valor_pagado,
            "esPyme": c.es_pyme,
            "localizacion": c.localizacion,
            "urlProceso": c.urlproceso,
            "fuente": f"{SECOP_DOMAIN}/resource/{c.id_contrato}",
        },
    }
