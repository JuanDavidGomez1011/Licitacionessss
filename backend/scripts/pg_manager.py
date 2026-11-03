"""
Gestor de un cluster PostgreSQL local en espacio de usuario (sin servicio, sin admin).

El paquete `pgserver` incluye los binarios de PostgreSQL 17 para Windows.
En Windows `pgserver` asigna un puerto aleatorio, por lo que este modulo orquesta
los binarios directamente para fijar un puerto estable y un nombre de rol estable.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

def _bin_dir() -> Path:
    from pgserver import _commands

    return Path(_commands.POSTGRES_BIN_PATH)


def _exe(name: str) -> Path:
    d = _bin_dir()
    for cand in (name, f"{name}.exe"):
        p = d / cand
        if p.exists():
            return p
    raise FileNotFoundError(f"binario '{name}' no encontrado en {d}")


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PGDATA = Path(os.environ.get("LICITACIONES_PGDATA", PROJECT_ROOT / ".pgdata"))
PGPORT = int(os.environ.get("LICITACIONES_PGPORT", "5432"))
PGHOST = "127.0.0.1"
PGUSER = "postgres"
PGDATABASE = os.environ.get("LICITACIONES_PGDATABASE", "licitaciones")
LOGFILE = PGDATA / "server.log"

_CONF_TUNING = """
# --- ajustes plataforma licitaciones (licitaciones.conf) ---
port = {port}
listen_addresses = '{host}'
max_connections = 60
shared_buffers = 256MB
work_mem = 8MB
maintenance_work_mem = 64MB
effective_cache_size = 1GB
datestyle = 'ISO, MDY'
lc_messages = 'C'
default_text_search_config = 'pg_catalog.simple'
""".lstrip()

# El build embebido de pgserver (PostgreSQL 16.2) no incluye
# share/postgresql/timezone, por lo que Postgres rechaza cualquier valor de
# TimeZone/log_timezone y no arranca. No se fija la zona: el servidor usa su
# default y la app convierte a hora de Colombia (America/Bogota) en Python.

_CONF_INCLUDE = "include = 'licitaciones.conf'\n"



def _run(args: list[str], check: bool = True, timeout: int = 180) -> subprocess.CompletedProcess:
    """Ejecuta un binario de Postgres.

    La salida va a archivos temporales y no a tuberias (PIPE): el servidor
    postgres se desliga del proceso y hereda los handles, de modo que con
    capture_output=True subprocess.run se queda esperando EOF indefinidamente.
    """
    cmd = [str(a) for a in args]
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as out_file, tempfile.TemporaryFile(
        "w+", encoding="utf-8", errors="replace"
    ) as err_file:
        try:
            proc = subprocess.run(
                cmd,
                stdout=out_file,
                stderr=err_file,
                stdin=subprocess.DEVNULL,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"timeout ({timeout}s) ejecutando: {' '.join(cmd)}") from None
        out_file.seek(0)
        err_file.seek(0)
        proc = subprocess.CompletedProcess(cmd, proc.returncode, out_file.read(), err_file.read())
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"comando fallo ({proc.returncode}): {' '.join(cmd)}\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return proc


def _initialized() -> bool:
    return (PGDATA / "PG_VERSION").exists()


def is_running() -> bool:
    if not _initialized():
        return False
    proc = _run([_exe("pg_isready"), "-h", PGHOST, "-p", str(PGPORT)], check=False)
    return proc.returncode == 0


def _apply_conf() -> None:
    main_conf = PGDATA / "postgresql.conf"
    text = main_conf.read_text(encoding="utf-8", errors="ignore")
    if _CONF_INCLUDE not in text:
        main_conf.write_text(text.rstrip() + "\n" + _CONF_INCLUDE, encoding="utf-8")
    (PGDATA / "licitaciones.conf").write_text(
        _CONF_TUNING.format(port=PGPORT, host=PGHOST), encoding="utf-8"
    )


def init_cluster(force: bool = False) -> None:
    if _initialized() and not force:
        _apply_conf()
        return
    if force and PGDATA.exists():
        stop()
        shutil.rmtree(PGDATA, ignore_errors=True)
    PGDATA.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            _exe("initdb"),
            "-D",
            str(PGDATA),
            "-U",
            PGUSER,
            "-A",
            "trust",
            "--encoding=UTF8",
            "--locale=C",
        ]
    )
    _apply_conf()



def start(wait_seconds: int = 60) -> bool:
    if is_running():
        return False
    init_cluster()
    LOGFILE.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            _exe("pg_ctl"),
            "-D",
            str(PGDATA),
            "-l",
            str(LOGFILE),
            "-o",
            f'-h "{PGHOST}" -p {PGPORT}',
            "-w",
            "start",
        ]
    )
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if is_running():
            return True
        time.sleep(1)
    tail = LOGFILE.read_text(encoding="utf-8", errors="ignore")[-2000:] if LOGFILE.exists() else ""
    raise RuntimeError(f"PostgreSQL no respondio en {wait_seconds}s.\n{tail}")


def stop() -> None:
    if not _initialized():
        return
    _run([_exe("pg_ctl"), "-D", str(PGDATA), "-m", "fast", "-w", "stop"], check=False)


def ensure_database(name: str = PGDATABASE) -> str:
    probe = _run(
        [_exe("psql"), "-h", PGHOST, "-p", str(PGPORT), "-U", PGUSER, "-d", "postgres", "-tAc",
         f"select 1 from pg_database where datname='{name}'"],
        check=False,
    )
    if probe.returncode != 0 or probe.stdout.strip() != "1":
        _run([_exe("createdb"), "-h", PGHOST, "-p", str(PGPORT), "-U", PGUSER, name])
    return name


def database_url(dbname: str = PGDATABASE) -> str:
    return f"postgresql+psycopg://{PGUSER}@{PGHOST}:{PGPORT}/{dbname}"


def status() -> dict:
    return {
        "pgdata": str(PGDATA),
        "port": PGPORT,
        "initialized": _initialized(),
        "running": is_running(),
        "database": PGDATABASE if is_running() else None,
        "url": database_url() if is_running() else None,
    }


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "start"
    if cmd == "start":
        start()
        ensure_database()
        print(database_url())
    elif cmd == "stop":
        stop()
        print("stopped")
    elif cmd == "status":
        for k, v in status().items():
            print(f"{k}: {v}")
    else:
        print(f"uso: {argv[0]} [start|stop|status]")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
