<#
.SYNOPSIS
    Levanta el panel de licitaciones.

.DESCRIPTION
    Por defecto levanta SOLO el frontend (Vite) y nada mas. No hay PostgreSQL, no
    hay API, no hay Ollama: los datos viven en el IndexedDB del navegador y la
    puntuacion corre en la pagina (ver src/lib/api.js). Es el modo que no gasta
    nada de CPU, RAM ni VRAM cuando esta parado.

    -ConBackend levanta el stack legado (PostgreSQL embebido + API FastAPI) para
    quien quiera seguir mirando el backend. Aparece como opcional a proposito:
    el panel ya no lo necesita para nada, y levantarlo por defecto seria
    levantar un servidor que no se usa.

    Cada proceso deja su PID en .run\ para que stop.ps1 lo pueda cerrar, y su log
    en .run\ para depurar sin ventana de consola.

    Idempotente en cuanto a PostgreSQL y Ollama (solo los levanta si no estaban
    ya). Si un servicio ya esta escuchando en su puerto, lo reutiliza en vez de
    duplicarlo.

    Ollama NO se levanta salvo que se pida con -ConOllama, y solo tiene sentido
    con -ConBackend. Cuando se levanta se fuerza OLLAMA_LLM_LIBRARY=cpu, o sea
    que ni siquiera detecta la GPU.

.PARAMETER ConBackend
    Levanta tambien PostgreSQL y la API. El panel funciona sin ellos.

.PARAMETER ConOllama
    Ademas, Ollama limitado a CPU (nunca usa la VRAM). Implica -ConBackend.

.PARAMETER SinFrontend
    No levanta Vite: util con -ConBackend para trabajar solo contra la API.

.PARAMETER Build
    Compila el frontend a frontend\dist en vez de levantar el servidor de
    desarrollo. Los datos siguen en el navegador: dist se puede abrir con doble
    clic (base relativa).

.EXAMPLE
    .\start.ps1
    .\start.ps1 -ConBackend
    .\start.ps1 -ConBackend -ConOllama
    .\start.ps1 -Build
#>
[CmdletBinding()]
param(
    [switch]$ConBackend,
    [switch]$ConOllama,
    [switch]$SinFrontend,
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
$Raiz = $PSScriptRoot
$Run = Join-Path $Raiz '.run'
$Venv = Join-Path $Raiz '.venv\Scripts\python.exe'
$Front = Join-Path $Raiz 'frontend'

# Ollama sin backend no tiene a quien servir: la API es la que lo consulta.
if ($ConOllama) { $ConBackend = $true }

New-Item -ItemType Directory -Path $Run -Force | Out-Null

function Info($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Aviso($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }

function Test-Puerto($puerto) {
    $c = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

function Test-Http($url) {
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing
        return $r.StatusCode -lt 500
    } catch {
        # Un 503 de Socrata o del propio servicio tambien cuenta como "vivo".
        return $_.Exception.Response -ne $null
    }
}

function Guarda-Pid($nombre, $proc) {
    $proc.Id | Out-File -FilePath (Join-Path $Run "$nombre.pid") -Encoding ascii
    Info "pid $($proc.Id) -> .run\$nombre.pid"
}

function Get-Npm {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    return $npm
}

Write-Host ''
Write-Host 'Licitaciones' -ForegroundColor Cyan
Write-Host '============' -ForegroundColor Cyan
Write-Host ''

# --- frontend ------------------------------------------------------------------
# Va primero porque es lo unico que se levanta en el modo normal, y porque el
# usuario espera ver una URL cuanto antes.
$pasos = if ($ConBackend) { 4 } else { 1 }

if ($SinFrontend) {
    Write-Host "[1/$pasos] Frontend" -ForegroundColor White
    Aviso 'omitido (-SinFrontend)'
} elseif ($Build) {
    Write-Host "[1/$pasos] Frontend (build)" -ForegroundColor White
    $npm = Get-Npm
    if (-not $npm) {
        throw 'npm no esta disponible: no se puede compilar el frontend'
    }
    Info 'npm run build...'
    & $npm.Source run build --prefix $Front 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) { throw 'El build fallo. Revisa el salida anterior.' }
    Ok "compilado en frontend\dist (abrir dist\index.html con doble clic)"
} elseif (Test-Puerto 5173) {
    Write-Host "[1/$pasos] Frontend" -ForegroundColor White
    Ok 'ya escuchando en 5173'
} else {
    Write-Host "[1/$pasos] Frontend" -ForegroundColor White
    $npm = Get-Npm
    if (-not $npm) {
        Aviso 'npm no esta disponible: el frontend no se levanta'
    } else {
        $p = Start-Process -FilePath $npm.Source -ArgumentList 'run', 'dev' `
            -WorkingDirectory $Front `
            -RedirectStandardOutput (Join-Path $Run 'web.out.log') `
            -RedirectStandardError (Join-Path $Run 'web.err.log') `
            -WindowStyle Hidden -PassThru
        Guarda-Pid 'web' $p
        for ($i = 0; $i -lt 45; $i++) {
            if (Test-Puerto 5173) { break }
            Start-Sleep -Seconds 1
        }
        if (Test-Puerto 5173) { Ok 'listo en 5173' }
        else { Aviso 'Vite no abrio el puerto; revisa .run\web.err.log' }
    }
}

if (-not $ConBackend) {
    Write-Host ''
    Write-Host '  Panel     http://localhost:5173' -ForegroundColor Cyan
    Write-Host '  Datos     en este navegador (IndexedDB); no hay servidor' -ForegroundColor DarkGray
    Write-Host '  Descarga  a mano, con el boton; nada corre solo' -ForegroundColor DarkGray
    Write-Host '  Backend   apagado -> .\start.ps1 -ConBackend' -ForegroundColor DarkGray
    Write-Host '  Logs      .run\*.err.log' -ForegroundColor DarkGray
    Write-Host '  Parar     .\stop.ps1' -ForegroundColor DarkGray
    Write-Host ''
    return
}

# --- 2. PostgreSQL -------------------------------------------------------------
Write-Host "[2/$pasos] PostgreSQL" -ForegroundColor White
if (Test-Puerto 5432) {
    Ok 'ya escuchando en 5432'
} else {
    Info 'arrancando cluster embebido...'
    $out = & $Venv (Join-Path $Raiz 'backend\scripts\pg_manager.py') start 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Info $_ }
        throw 'PostgreSQL no arranco. Revisa .pgdata\logs.'
    }
    $out | ForEach-Object { Info $_ }
    Ok 'listo en 5432'
}

# --- 3. Ollama (opt-in, y siempre en CPU) -------------------------------------
Write-Host "[3/$pasos] Ollama" -ForegroundColor White
if (-not $ConOllama) {
    Aviso 'apagado: no se levanta y no se toca la VRAM'
    Info 'el panel puntua en el navegador, asi que no lo necesita'
} elseif (Test-Http 'http://127.0.0.1:11434/api/tags') {
    Ok 'ya escuchando en 11434'
} else {
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollama) {
        Aviso 'ollama no esta en el PATH: se omite (el score seguira funcionando con el fallback)'
    } else {
        Info 'arrancando ollama serve (solo CPU: OLLAMA_LLM_LIBRARY=cpu)...'
        # El hijo hereda el entorno de esta sesion, asi que se fuerza aqui y no
        # depende de que la variable de usuario exista en esta maquina. Se
        # restauran porque el script sigue vivo y no quiere arrastrar esto.
        #
        # OJO, no es `OLLAMA_NUM_GPU=0`: en Ollama 0.33.3 esa variable ya no
        # existe y ponerla no evita nada; el modelo se.offloadia a CUDA igual.
        # Lo que funciona es `OLLAMA_LLM_LIBRARY=cpu`, que hace que la
        # autodeteccion no encuentre ninguna GPU.
        $libPrevia = $env:OLLAMA_LLM_LIBRARY
        $cargaPrevia = $env:OLLAMA_MAX_LOADED_MODELS
        $env:OLLAMA_LLM_LIBRARY = 'cpu'
        $env:OLLAMA_MAX_LOADED_MODELS = '1'
        try {
            $p = Start-Process -FilePath $ollama.Source -ArgumentList 'serve' `
                -RedirectStandardOutput (Join-Path $Run 'ollama.out.log') `
                -RedirectStandardError (Join-Path $Run 'ollama.err.log') `
                -WindowStyle Hidden -PassThru
        } finally {
            $env:OLLAMA_LLM_LIBRARY = $libPrevia
            $env:OLLAMA_MAX_LOADED_MODELS = $cargaPrevia
        }
        Guarda-Pid 'ollama' $p
        for ($i = 0; $i -lt 30; $i++) {
            if (Test-Http 'http://127.0.0.1:11434/api/tags') { break }
            Start-Sleep -Seconds 1
        }
        if (Test-Http 'http://127.0.0.1:11434/api/tags') { Ok 'listo en 11434, sin GPU' }
        else { Aviso 'ollama no respondio; revisa .run\ollama.err.log' }
    }
}

# --- 4. API --------------------------------------------------------------------
Write-Host "[4/$pasos] API" -ForegroundColor White
if (Test-Puerto 8000) {
    Ok 'ya escuchando en 8000'
} else {
    if (-not (Test-Path $Venv)) {
        throw "No esta el entorno de Python en $Venv. Usa -ConBackend solo si ya lo creaste."
    }
    $p = Start-Process -FilePath $Venv `
        -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000' `
        -WorkingDirectory (Join-Path $Raiz 'backend') `
        -RedirectStandardOutput (Join-Path $Run 'api.out.log') `
        -RedirectStandardError (Join-Path $Run 'api.err.log') `
        -WindowStyle Hidden -PassThru
    Guarda-Pid 'api' $p
    for ($i = 0; $i -lt 45; $i++) {
        if (Test-Http 'http://127.0.0.1:8000/api/salud') { break }
        Start-Sleep -Seconds 1
    }
    if (Test-Http 'http://127.0.0.1:8000/api/salud') { Ok 'listo en 8000' }
    else { throw 'La API no respondio en /api/salud. Revisa .run\api.err.log' }
}

Write-Host ''
Write-Host '  Panel     http://localhost:5173' -ForegroundColor Cyan
Write-Host '  API       http://127.0.0.1:8000/api/salud' -ForegroundColor Cyan
Write-Host '  El panel sigue sin necesitar la API: todo va en el navegador' -ForegroundColor DarkGray
if ($ConOllama) {
    Write-Host '  IA        encendida, pero solo en CPU (0 VRAM)' -ForegroundColor DarkGray
} else {
    Write-Host '  IA        apagada -> .\start.ps1 -ConBackend -ConOllama' -ForegroundColor DarkGray
}
Write-Host '  Logs      .run\*.err.log' -ForegroundColor DarkGray
Write-Host '  Parar     .\stop.ps1 -ConBackend' -ForegroundColor DarkGray
Write-Host ''