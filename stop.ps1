<#
.SYNOPSIS
    Para lo que haya levantado start.ps1.

.DESCRIPTION
    Por defecto para SOLO el frontend, que es lo unico que levanta start.ps1 sin
    -ConBackend. Los datos estan en el navegador, asi que no hay base de datos ni
    servidor que parar: parar la pagina no borra nada.

    -ConBackend para ademas la API y Ollama. PostgreSQL se para aparte, porque es
    una base de datos: perder un COMMIT a medias por cerrar a la fuerza es peor
    que dejar el servidor de pie.

    Parar Ollama incluye matar sus `llama-server.exe`, que son los procesos que
    tienen los modelos cargados. Sin eso, apagar el servidor NO libera la memoria
    de los modelos y es como la tarjeta sigue ocupada (ESTADO-PROYECTO 3.8.2).

    Por defecto es conservador: si no encuentra el PID, no hace nada. Con
    -Forzar mata tambien los procesos que escuchan en los puertos aunque no los
    haya lanzado start.ps1 (tras un reinicio del PC, o si se infinitaron a mano).

.PARAMETER ConBackend
    Para tambien la API y los cargadores de Ollama.

.PARAMETER Forzar
    Mata por puerto lo que quede, incluidos los hijos de Vite y uvicorn.

.PARAMETER ConPostgres
    Tambien para PostgreSQL. Requiere confirmacion interactiva.

.EXAMPLE
    .\stop.ps1
    .\stop.ps1 -Forzar
    .\stop.ps1 -ConBackend -ConPostgres
#>
[CmdletBinding()]
param(
    [switch]$ConBackend,
    [switch]$Forzar,
    [switch]$ConPostgres
)

$ErrorActionPreference = 'Continue'
$Raiz = $PSScriptRoot
$Run = Join-Path $Raiz '.run'

function Info($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Aviso($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }

function Detiene-Pid($nombre) {
    $fichero = Join-Path $Run "$nombre.pid"
    if (-not (Test-Path $fichero)) {
        # `${nombre}` y no `$nombre`: seguido de ":" PowerShell lee "nombre:" como
        # un nombre de variable con calificador de unidad y el script no llega a
        # parsear. Asi que esto no era un mensaje feo, era un stop.ps1 entero que
        # no arrancaba, y solo se veia al ejecutarlo.
        Info "${nombre}: sin pid guardado"
        return
    }
    $pidGuardado = [int](Get-Content $fichero -Raw).Trim()
    $proc = Get-Process -Id $pidGuardado -ErrorAction SilentlyContinue
    if (-not $proc) {
        Aviso "$nombre (pid $pidGuardado): ya no corre"
        Remove-Item $fichero -Force
        return
    }
    # `Stop-Process` mata solo el proceso indicado, no su arbol, y lo que se
    # guarda en el .pid es el `npm.cmd` que envuelve a Vite: matando solo ese se
    # quedan el node de npm y el de Vite de pie, con el 5173 ocupado. Medido: este
    # script decia "[ok] web cerrado" con Vite usando 106 MB todavia. `taskkill /T`
    # baja el arbol entero, que es lo que hace falta tambien para uvicorn --reload.
    & taskkill.exe /PID $pidGuardado /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
    if (Get-Process -Id $pidGuardado -ErrorAction SilentlyContinue) {
        Aviso "$nombre (pid $pidGuardado): no se pudo cerrar"
    } else {
        Ok "$nombre (pid $pidGuardado) cerrado"
    }
    Remove-Item $fichero -Force
}

function Detiene-Puerto($puerto, $que) {
    $conexiones = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue
    if (-not $conexiones) {
        Info "${que}: nada escuchando en $puerto"
        return
    }
    $pids = $conexiones | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) {
        if ($p -eq $PID) { continue }
        $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
        $nombre = if ($proc) { $proc.ProcessName } else { "pid $p" }
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        Ok "${que}: $nombre (pid $p) cerrado en $puerto"
    }
}

# Mata los `llama-server.exe`, que son los hijos que cargan los modelos.
#
# No es opcional y no espera a -Forzar: matar `ollama.exe` NO descarga los
# modelos. Cada modelo cargado corre en su propio `llama-server.exe`, y esos se
# quedan de pie como hijos huerfanos, con los pesos todavia en memoria. Medido
# el 28/09: tras `.\stop.ps1` quedaban 4 `llama-server` vivos y la tarjeta
# seguia con 6,7 GB en vez de 4,1 GB, que es justo el sintoma de "ya lo apague y
# me sigue ocupando la GPU".
#
# Se hace antes que el padre, que es el orden que libera memoria. Y siempre,
# porque `llama-server.exe` solo existe bajo Ollama: no hay riesgo de
# carryingarse un proceso ajeno.
function Detiene-CargadoresDeOllama() {
    $hijos = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
    if (-not $hijos) {
        Info 'ollama: ningun modelo cargado (nada que liberar)'
        return
    }
    foreach ($h in $hijos) {
        $h | Stop-Process -Force -ErrorAction SilentlyContinue
        Ok "ollama: modelo liberado (llama-server pid $($h.Id))"
    }
    Start-Sleep -Milliseconds 400
    if (Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue) {
        Aviso 'ollama: quedan procesos llama-server vivos'
    }
}

Write-Host ''
Write-Host 'Parando' -ForegroundColor Cyan
Write-Host ''

# Orden inverso al de arranque: primero lo que consume, luego lo que provee.
Detiene-Pid 'web'

# El 5173 es nuestro por definicion (Vite), asi que se comprueba siempre, sin
# -Forzar: si sigue escuchando es que el arbol no se bajo entero y hay que
# decirlo, porque "cerrado" con el servidor vivo es lo que hacia este script
# creible cuando no lo era.
$escuchas = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($escuchas) {
    foreach ($e in @($escuchas | Select-Object -ExpandProperty OwningProcess -Unique)) {
        Aviso "frontend: el 5173 sigue ocupado (pid $e). Se baja con .\stop.ps1 -Forzar"
    }
} elseif (Test-Path (Join-Path $Run 'web.pid')) {
    Info 'frontend: puerto 5173 libre'
}

if ($ConBackend) {
    Detiene-Pid 'api'
    # Los cargadores de modelos ANTES que el servidor: si se deja al reves, el
    # padre se lleva por delante a los hijos y estos se quedan de pie.
    Detiene-CargadoresDeOllama
    Detiene-Pid 'ollama'
} else {
    Info 'backend no se para: no se levanto (-ConBackend)'
    Info 'los datos siguen en el navegador; parar la pagina no borra nada'
}

if ($Forzar) {
    Detiene-Puerto 5173 'frontend'
    if ($ConBackend) {
        Detiene-Puerto 8000 'api'
        Detiene-Puerto 11434 'ollama'
    }
}

if ($ConPostgres) {
    if ($Forzar -or (Read-Host '  Cerrar tambien PostgreSQL? [s/N]') -match '^[sSyY]') {
        $Venv = Join-Path $Raiz '.venv\Scripts\python.exe'
        Info 'parando cluster...'
        & $Venv (Join-Path $Raiz 'backend\scripts\pg_manager.py') stop 2>&1 |
            ForEach-Object { Info $_ }
        Ok 'PostgreSQL cerrado'
    } else {
        Info 'PostgreSQL se queda arriba'
    }
} elseif (Test-Path (Join-Path $Run 'api.pid')) {
    Info 'PostgreSQL se queda arriba (usa -ConPostgres para pararlo)'
}

Write-Host ''