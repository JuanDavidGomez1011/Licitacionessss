"""Configuracion central de la plataforma (variables de entorno con defaults)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "Plataforma de Licitaciones SECOP II"
    app_env: str = "development"
    api_prefix: str = "/api"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173"

    # --- Base de datos -------------------------------------------------
    pg_host: str = "127.0.0.1"
    pg_port: int = 5432
    pg_user: str = "postgres"
    pg_password: str = ""
    pg_database: str = "licitaciones"
    db_echo: bool = False

    # --- API Socrata / Datos Abiertos Colombia -------------------------
    socrata_base_url: str = "https://www.datos.gov.co"
    dataset_procesos: str = "p6dx-8zbt"   # SECOP II - Procesos de Contratacion
    dataset_contratos: str = "jbjy-vk9h"  # SECOP II - Contratos Electronicos
    socrata_app_token: str = ""            # opcional, sube el limite de requests
    http_timeout: float = 60.0
    page_size: int = 500                   # maximo 50000 permitido por Socrata
    request_delay: float = 0.35            # pausa entre peticiones ( cortesia)
    max_retries: int = 4

    # --- IA local (Ollama) ---------------------------------------------
    # OJO: Ollama no se levanta solo (start.ps1 exige -ConOllama) y cuando se
    # levanta va con OLLAMA_NUM_GPU=0, o sea solo en RAM: este proyecto no toca
    # la VRAM. Ver ESTADO-PROYECTO.md §3.8.2.
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_llm: str = "llama3.2"           # modelo de texto para score + resumen
    ollama_embed_model: str = "nomic-embed-text"
    ollama_timeout: float = 180.0
    ollama_num_ctx: int = 4096
    ollama_keep_alive: str = "15m"
    # Si la IA es obligatoria. Con false, Ollama apagado NO es una averia: la
    # ingesta sigue, /api/salud queda en "ok" y solo no se puntua lo nuevo.
    ollama_required: bool = False
    embedding_dims: int = 768              # nomic-embed-text produce 768
    # Cuantos textos caben en una peticion a /api/embed. Mandar cientos de una
    # vez tumba el tokenizer interno de Ollama (400 hacia su propio sidecar), y
    # el cliente va reduciendo el lote solo si eso pasa.
    embed_chunk_size: int = 128
    score_min_threshold: int = 0           # score minimo para considerar oportunidad
    score_candidate_pool: int = 40         # cuantos pasan al LLM por ciclo

    # --- Sincronizacion -------------------------------------------------
    sync_lookback_days: int = 3            # ventana incremental por fecha de publicacion
    sync_catchup_days: int = 30            # se ensancha si la ventana incremental viene vacia
    sync_cron_hour: int = 3
    sync_cron_minute: int = 15
    # Ciclo autonomo: cada cuantos minutos se reintenta la ingesta aunque el
    # servidor se quede encendido todo el dia. 0 lo desactiva.
    sync_interval_minutes: int = 30
    # El ciclo frecuente usa una ventana mas corta: con 3 dias son ~8.000 filas
    # en cada pasada y no hace falta releerlas todas cada media hora.
    sync_lookback_frequent_days: int = 1
    # Al arrancar, si lo ultimo sincronizado es mas viejo que esto, se sincroniza
    # de inmediato en vez de esperar al primer tick.
    sync_startup_if_stale_minutes: int = 90
    # Cuantas sincronizaciones fallidas seguidas se toleran antes de que /api/salud
    # pase a "degradado". 0 desactiva la alerta.
    sync_alert_failed_streak: int = 3
    score_batch_size: int = 12
    # El ciclo autonomo esta APAGADO por defecto. El panel ahora baja y puntua en
    # el navegador, con el boton y a mano, asi que el backend no tiene nada que
    # programar ni que sincronizar. Dejarlo en True significaba que con solo
    # levantar la API se hacian docenas de peticiones a Socrata y al modelo cada
    # media hora sin pedirlo, que es justo lo que se queria evitar.
    # Para volver al comportamiento antiguo: ENABLE_SCHEDULER=true.
    enable_scheduler: bool = False

    @property
    def database_url(self) -> str:
        auth = f"{self.pg_user}:{self.pg_password}" if self.pg_password else self.pg_user
        return f"postgresql+psycopg://{auth}@{self.pg_host}:{self.pg_port}/{self.pg_database}"

    @property
    def profile_path(self) -> Path:
        return BACKEND_DIR / "app" / "seed" / "profile.yaml"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
