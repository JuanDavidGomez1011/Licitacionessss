"""Punto de entrada de la API: Plataforma de Licitaciones SECOP II."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import contracts, profile, sync, tenders
from app.config import settings
from app.db import init_schema
from app.scheduler import start_scheduler, stop_scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("iniciando %s", settings.app_name)
    try:
        init_schema()
    except Exception:
        log.exception("no se pudo inicializar el esquema de base de datos")
    start_scheduler()
    yield
    stop_scheduler()
    log.info("apagando")


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description=(
        "Busqueda, filtrado y puntuacion con IA local de licitaciones publicas "
        "del SECOP II (Colombia Compra Eficiente) sobre Datos Abiertos Socrata."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = settings.api_prefix
app.include_router(sync.router, prefix=api)
app.include_router(tenders.router, prefix=api)
app.include_router(contracts.router, prefix=api)
app.include_router(profile.router, prefix=api)


@app.get("/")
def raiz() -> dict[str, str]:
    return {
        "servicio": settings.app_name,
        "docs": "/docs",
        "salud": f"{api}/salud",
        "oportunidades": f"{api}/licitaciones",
    }
