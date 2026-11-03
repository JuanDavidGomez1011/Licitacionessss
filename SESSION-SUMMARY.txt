# Resumen de sesión — Plataforma de Licitaciones SECOP II

Actualizado el **2026-10-29** (8ª pasada). Documento de referencia completo y con
contexto: **`ESTADO-PROYECTO.md`**. Este archivo es el arranque rápido para
continuar en una sesión nueva.

> ## 8ª pasada (29/10): carga completa medida y bug de score corregido
>
> **Hecho:**
>
> - **Carga completa de 7 días, sin `appToken`:** 24.047 filas de procesos
>   (18.346 distintos tras deduplicar), 14.357 contratos, 80 peticiones, 99 s,
>   0×429/503, 0 caídas, 0 errores de consola, ~101 MB en IndexedDB y los
>   18.346 procesos puntuados y persistidos.
> - **Bug real:** la lista pintaba `—` en todas las tarjetas aunque hubiera
>   matches. `Indice.filaDe` devolvía `score` suelto y `aOportunidad` lee
>   `fila.match`; se añade el `match` completo. También afectaba a "similares".
> - **Tests nuevos:** uno unitario de la fachada y un assert del score numérico
>   en el e2e de humo (antes solo miraba la palabra "score").
> - **Panel `Datos`** con las cifras medidas: ~24.000 procesos y ~14.000
>   contratos, no la estimación de ~31.000/~18.000.
>
> **Verificado:** 74/74 vitest, 5/5 Playwright de humo + 1 skipped (real opt-in),
> carga real acotada 1/1 (4 peticiones, 0 errores, 120 procesos) y build de
> producción de 228,36 kB (71,96 kB gzip).
>
> **Sigue pendiente:** solo el `appToken` (cuenta externa). La carga completa
> funcionó sin él, pero el token reduce el riesgo de 429/503 en repeticiones.
> "Cargué, actualicé y no sale" queda mitigado/cerrado en un navegador limpio.
>
> ---

> ## 7ª pasada (29/10): panel `Datos` y decisión de topes
>
> **Hecho:**
>
> - **Panel `Datos`** en la cabecera: `appToken`, `lookbackDays`,
>   `maxProcesos`, `maxContratos` y `includeContracts`. Se guarda en
>   `localStorage` y manda sobre `app-config.json`; se aplica en la siguiente
>   descarga.
> - **Presets** `Rápida · 5.000 procesos` (5.000/2.000) y `Ventana completa · 7
>   días` (50.000/50.000). Si se elige la completa sin token, avisa de 429/503.
> - **Decisión de producto:** por defecto 5.000 procesos / 2.000 contratos; la
>   ventana completa (~24.000/~14.000, medido en la 8ª pasada) es opt-in y pide
>   `appToken`. Se acabó la contradicción entre el documento y el código.
> - **`scoreLimit` eliminado:** no se usaba; ahora se puntúa todo lo descargado.
> - **Mensaje de Socrata** apunta al panel `Datos`, no a una ficha inexistente.
> - **`app-config.json`** declara ya `lookbackDays` e `includeContracts`.
>
> **Verificado:** 73/73 vitest (71 + 2: panel `Datos` y selector de días), 5/5 Playwright de
> humo + 1 skipped (el real opt-in), y la carga real acotada
> (`SECOP_REAL=1`): 4 peticiones, 0×4xx/5xx, 0 caídas, 0 errores de consola,
> 118 procesos puntuados y persistidos. Build de producción OK.
>
> **Lo único que queda del punto 1:** pegar el `appToken`. Crear la cuenta en
> datos.gov.co necesita correo y verificación; no se puede hacer desde el
> agente. El campo ya está en **Datos** y en `app-config.json`. La carga
> completa real se midió en la 8ª pasada (99 s, 80 peticiones, 0×429/503,
> 18.346 procesos y 14.357 contratos).
>
> ---

> ## Lo de la sesión del 2026-10-05: el panel pasa de "creído" a "probado en un navegador"
>
> > ### 1. Los tests corren, y eso destapó 5 bugs
> >
> > Se instaló Playwright + Chromium y se escribieron 4 tests de humo contra el
> > **build de producción** (`vite preview`, puerto 4173), interceptando
> > `datos.gov.co`. Con eso, y con vitest, aparecieron cinco fallos reales:
> >
> > | Bug | Efecto |
> > |---|---|
> > | `indice.js` llamaba `aceite()` en vez de `acepta()` | `ReferenceError` en toda consulta con filtros |
> > | `isoDia()` truncaba en UTC | El primer día de la ventana se quedaba fuera sin avisar |
> > | `stop.ps1` mataba solo el `npm.cmd` | Decía "cerrado" con Vite vivo (104 MB) ocupando el 5173 |
> > | La ingesta emitía `listo` antes de rehacer el índice | La descarga se guardaba bien pero el panel se quedaba en "0 oportunidades" |
> > | `iterRows` comprobaba `maxRows` después de leer la página | El tope no era un tope: `maxProcesos: 120` guardaba hasta 499 procesos de más |
> >
> > El quinto solo apareció al mirar la **URL** que sale en la petición real: ni
> > los unitarios ni el humo con datos falsos la miran.
> >
> > ### 2. Carga real contra datos.gov.co
> >
> > `e2e/secop-real.spec.js` golpea el portal de verdad, **acotado** con topes
> > escritos en `localStorage` antes de que arranque la app (120 procesos de los
> > ~31.000 de la ventana de 7 días). Va **fuera** de `npm run test:e2e` a
> > propósito, porque esa suite tiene que poder correr sin internet:
> >
> > ```powershell
> > $env:SECOP_REAL = '1'
> > npx playwright test e2e/secop-real.spec.js
> > ```
> >
> > Resultado: 4 peticiones, **0 respuestas 4xx/5xx, 0 peticiones caídas, 0
> > errores de consola**, 116-120 procesos guardados y todos puntuados, y todo
> > persistido en IndexedDB tras recargar. Lo que sale por debajo del tope son ids
> > repetidos que devuelve el portal (120 filas → 116 distintos), que `deduplicar`
> > quita bien.
> >
> > ### 3. Aviso visible cuando los datos no se guardan
> >
> > El fallback a memoria avisaba solo por `console.warn` y en el `title` del
> > chip: hay que acertar el ratón para verlo. Ahora hay un **banner ámbar fijo**
> > en `Oportunidades.jsx` + `.banner.aviso` en CSS, sin botón de cerrar (si no se
> > guarda, no es información que se pueda dejar pasar), con 2 tests que lo fijan.
> >
> > ### 4. Estado final
> >
> > **61 tests de vitest + 4 de Playwright en verde** (más 1 real opt-in), build
> > de 220 kB, ciclo `.\start.ps1` / `.\stop.ps1` comprobado de punta a punta, sin
> > procesos residuos ni puertos ocupados. Capturas de la página en
> > `.run\captura-*.png` (vacía, descargando, con la lista, con el modal).
>
> ---
>
> ## ⚠️ OPEN (mitigado): "cargué desde localhost, actualicé y no sale"
>
> **El usuario veía la página vacía después de descargar y recargar. La causa
> raíz sigue sin confirmar, pero desde la 6ª pasada el vacío se explica solo en
> la página y desde la 7ª la descarga por defecto es mucho más corta (5.000
> procesos), así que el 429 es menos probable.**
>
> - Por mi lado **persistencia funciona**: verificado en Chromium que tras
>   recargar quedan `procesos: 30`, `ligeros: 30`, `matches: 30`, `contratos: 10`
>   y `meta` con `progreso_sync`, `ultima_sync` y `ultima_sync_resumen`.
> - Descartado por mí: que el build esté roto, que falten stores (los 6 existen),
>   que `procesos` desaparezca (era artefacto de mi propio harness al imprimir el
>   objeto, no de la app), y que el servidor esté caído (`HTTP 200`, Vite sano).
> - **Se le pidió que pegue en la consola un snippet de diagnóstico** (el que
>   cuenta registros por store y vuelca `meta`). Está probado y funciona; su
>   salida decide el diagnóstico:
>   - `registros` todo 0 y `meta: {}` → la descarga falló o se canceló.
>   - `registros.procesos` > 0 con lista vacía → **bug mío** al leer/índice.
>   - `origen` distinto de `http://localhost:5173` → está mirando otro origen
>     (`localhost` ≠ `127.0.0.1`); los datos están donde se descargó.
> - Candidatos que se-borne desde el principio, sin confirmar:
>   1. **Límite de peticiones de Socrata.** La ventana completa son ~30.000
>      procesos + ~18.000 contratos ≈ 65 peticiones; sin `appToken` eso da 429/503
>      y la descarga muere a medias. La descarga rápida por defecto son 5.000
>      procesos (~15 peticiones), así que el riesgo baja mucho. Arreglo: `appToken`
>      en el panel **Datos** (o en `public\app-config.json`), o bajar `maxProcesos`.
>   2. Pulsó "Actualizar" mientras aún descargaba.
>   3. IndexedDB bloqueado por incógnito / cookies / doble clic en el `index.html`
>      (ahora hay banner que lo dice, pero el que lo tiene es el build viejo).
>
> ---
>
> ## Pregunta abierta: ¿subirlo a Vercel?
>
> Respuesta ya dada, por si hay que retomarla: **el panel sí se sube** (son 3
> ficheros estáticos en `frontend\dist`, `base: './'`, sin servidor ni variables) y
> **el score funciona igual** (TF-IDF en el navegador), y **los links de SECOP
> también** (el botón "Abrir en SECOP" está en `Tarjeta.jsx:104` y
> `Detalle.jsx:120`; las URLs reales responden HTTP 200 con el patrón
> `OpportunityDetail/Index?noticeUID=CO1.NTC.*`).
>
> Lo que **no** puede ir a Vercel: Ollama (proceso largo, sin GPU), PostgreSQL
> (sin disco persistente) y el ciclo automático (Vercel Cron solo llama a
> funciones serverless). Y ojo: **los datos son por navegador**, así que en
> Vercel cada visitante empieza a cero hasta que pulse "Descargar SECOP". No hay
> `vercel.json` en el repo todavía; si se decide, el trabajo es mínimo.
>
> ---
>
> ## Historial (5ª pasada)
>
> El proyecto dejó de tener servidor.
>
> El panel es ahora una **aplicación de navegador**. Los datos viven en IndexedDB,
> la descarga va del navegador a `datos.gov.co` (CORS abierto) y la puntuación es
> TF-IDF + coseno en JS, sin modelo y sin GPU. `.\start.ps1` levanta solo el
> frontend; el backend con FastAPI + PostgreSQL + Ollama sigue ahí, pero es
> **opcional** (`-ConBackend`) y con el ciclo automático **desactivado**
> (`ENABLE_SCHEDULER=false`).
>
> Lo anterior de esa sesión (la IA legacy no toca la VRAM) sigue siendo cierto
> para `-ConBackend`; para el panel es moot: no hay IA. Ver `ESTADO-PROYECTO.md`
> §3.8.3 y el bloque de la 5ª pasada al principio de ese documento.
>
> La página se renderizó y se comprobó por DOM (el agente no puede ver imágenes).
> Antes de descargar: `IndexedDB · 0 procesos · 0 puntuados` y el cuerpo pidiendo
> pulsar el botón. Después: `120 procesos · 120 puntuados`, 24 fichas por página,
> modal con detalle y contratos. Título `Oportunidades · Licitaciones SECOP II`.
>
> Para verla en persona: `.\start.ps1` y abrir http://localhost:5173. **El estado
> es por navegador**: si se abre en otro, o en incógnito, empieza a cero aunque la
> descarga ya esté hecha en el primero. Para llevar datos de uno a otro está el
> NDJSON de `Exportar` / `Importar`.

---

> **Lo de la sesión anterior, en una línea:** la IA ya no toca la VRAM. Ollama no se
> levanta solo, y cuando se levanta va forzado a CPU. Detalle y verificación en
> §8 y en `ESTADO-PROYECTO.md` §3.8.3.

---

## 1. Proyecto

- **Nombre:** Plataforma de Licitaciones SECOP II (tracker de oportunidades de contratación pública colombiana).
- **Ruta raíz:** `F:\Proyectos\Licitaciones`
- **Stack (lo que corre):** React 18 + Vite 8 + Vitest 5, todo en el navegador.
  IndexedDB para los datos, TF-IDF/coseno en JS para la puntuación. Sin Python, sin
  PostgreSQL, sin Ollama.
- **Stack (opcional, `-ConBackend`):** Python 3.12 + FastAPI + SQLAlchemy 2.0 +
  Alembic + psycopg3 · PostgreSQL 16.2 embebido (`pgserver`, cluster propio en
  `.pgdata/`) con pgvector 0.6.2 · IA local con Ollama (`llama3.2` +
  `nomic-embed-text`, **solo CPU**). Es el que se describe en el resto de este
  documento.
- **Datos:** API Socrata de datos.gov.co, datasets `p6dx-8zbt` (procesos) y
  `jbjy-vk9h` (contratos). Los descarga el navegador directamente.

## 2. Objetivo

Encontrar las licitaciones de SECOP II que encajan con una empresa y saber por qué.
Ahora se resuelve entero en la página: se descarga con un botón, se guarda en el
navegador y se puntúa en local. Antes era lo mismo pero con cuatro procesos
(ingesta, IA local, API, panel) y una base de datos que había que levantar para ver
nada; esa versión sigue en `-ConBackend`.

## 3. Estado actual — verificado en esta sesión

### El panel, tal como está hoy

| Comprobación | Resultado |
|---|---|
| `npm test` (vitest) | **74/74** |
| `npm run test:e2e` (Playwright, datos falsificados) | **5/5** + 1 skipped (el de datos reales) |
| Carga real acotada (`SECOP_REAL=1`) | **1/1** — 4 peticiones, 0×4xx/5xx, 0 caídas, 0 errores de consola |
| Carga completa 7 días (manual) | **1/1** — 80 peticiones, 99 s, 0×429/503, 18.346 procesos + 14.357 contratos, ~101 MB |
| `npm run build` | OK, 228,36 kB (71,96 kB gzip) |
| `.\start.ps1` → HTTP 200 en 5173 | OK |
| `.\stop.ps1` → puerto libre, sin procesos | OK |
| Persistencia tras recargar | OK: `procesos` y `ligeros` y `matches` y `contratos` siguen ahí |

**Bugs que aparecieron al ejecutar y ya están corregidos:** cinco (los de la
tabla del principio). Todos pasaban `node --check`, el build y la revisión a ojo.

**Medido el 29/10:** la carga completa de la ventana de 7 días. 24.047 filas de
procesos (18.346 distintos tras deduplicar), 14.357 contratos, 80 peticiones,
99 s, 0×429/503, 0 errores y ~101 MB en IndexedDB. Se lanzó desde el preset
`Ventana completa · 7 días` del panel **Datos**, sin `appToken`. Repetirla con
token en hora punta sigue siendo una buena prueba de estrés, pero ya no es un
agujero negro.

### Base de datos de desarrollo (27/09, solo `-ConBackend`)

| Tabla | Filas |
|---|---|
| `tenders` | 339.608 |
| `contracts` | 235.540 |
| contratos enlazados a proceso | 178.673 (75,9 %) |
| **`matches`** | **339.648 — ya no hay que repuntuar** |
| — refinadas con LLM (`qwen3:14b`) | 311 |
| — solo etapa 1 (`vectorial`) | 339.337 |
| `company_profile` | 1 |
| `alembic_version` | `0001_esquema_inicial` |

**El pendiente #1 desde la 3ª pasada está cerrado**: las 339.608 licitaciones
están puntuadas y el panel las enseña con filtros y facetas.

### Servicios

| Puerto | Qué |
|---|---|
| 5173 | frontend (Vite) — **lo único que levanta `.\start.ps1`** |
| 5432 | PostgreSQL — solo con `-ConBackend` |
| 8000 | API — solo con `-ConBackend` |
| 11434 | Ollama — solo con `-ConBackend -ConOllama` |

### Pruebas

- Frontend: **74 tests de vitest + 5 de Playwright de humo**; el de carga real
  es el sexto y sale skipped sin `SECOP_REAL=1`. `npm test` y `npm run test:e2e`.
  - `src/test/lib.test.js` (47: lógica pura, almacén en memoria, índice, score,
    snapshot, las fechas sin zona horaria, el `maxRows` de `iterRows` y la
    fachada devolviendo `match`),
    `Oportunidades.test.jsx` (15, incluye los 2 del banner de "no se está
    guardando" y 1 del panel `Datos`) y `Sincronizador.test.jsx` (12, incluye el
    selector de días). Se borró
    `EstadoSync.test.jsx`, que probaba un componente que ya no existe.
  - `e2e/humo.spec.js` (5, Playwright + Chromium, datos interceptados): la página
    carga sin errores de consola y con IndexedDB; la descarga entra, se puntúa y
    se pinta; los datos sobreviven a recargar; el contrato se enlaza con su
    proceso por `noticeUID` (en la tarjeta que no lo tiene tiene que salir "Sin
    contratos asociados", que es lo que evita que el test pase por casualidad); y
    un 429 deja el error visible tras recargar.
  - `e2e/secop-real.spec.js` (1, **opt-in**: `$env:SECOP_REAL='1'`): golpea
    `datos.gov.co` de verdad, con topes bajos escritos en `localStorage` antes de
    arrancar la app. Va fuera de `npm run test:e2e` a propósito: esa suite tiene
    que poder correr sin internet.
  - Ojo al mockear la fachada: `api` es un objeto, así que hace falta un getter
    (`get api() { return mockApi.actual }`). Con `vi.fn().mockImplementation(obj)` solo
    se define lo que devuelve al *llamar*, y `api.facetas` sale `undefined`: así
    rompieron 11 tests de golpe.
  - `vite.config.js` excluye `e2e/**` de vitest, o vitest intenta correr los tests
    de Playwright y falla con "Playwright Test did not expect test() to be called".
  - **No editar ficheros de código con `Set-Content` de PowerShell.** El
    round-trip metió BOM y doble UTF-8 en dos cadenas de `lib.test.js`
    (`Bogotá` → `BogotÃ¡`), y el test de `norm` empezó a fallar. Para tocar código,
    editar con la herramienta de edición, que escribe UTF-8 sin BOM. Ojo también
    con la consola: imprime `á` como `?`, así que un acento "raro" en la salida no
    es un fichero roto (comprobar los code points, no el `?`).
- Backend: **86 tests**, todos en verde en su última ejecución. Solo aplican a
  `-ConBackend`. Tarda **~3 min con la app parada**; la contención con PostgreSQL
  pesa más que los propios tests.

### OJO: la base entra en recuperación tras un reinicio

Al arrancar el PC, PostgreSQL rehace el WAL y durante ~1 min responde
`rejecting connections`, que hace fallar `pg_manager.start()` con "server did not
start in time" y deja la suite entera en error aunque el código esté bien. Es
esperar y reintirar, no un fallo del proyecto.

## 4. Lo que se hizo en la 5ª pasada (28/09)

1. **La IA ya no toca la VRAM** (§3.8.3). `start.ps1` no arranca Ollama salvo
   `-ConOllama`; cuando arranca va con `OLLAMA_LLM_LIBRARY=cpu`; y se puso la
   misma variable como entorno de usuario de Windows, más se desactivó el
   auto-arranque de la bandeja de Ollama. Verificado con `ollama ps`
   (**100% CPU**) y con el log de carga (**`CPU model buffer size`**).
2. **Bug #16** — con la IA apagada, el ciclo de ingesta se guardaba como
   fallido y `/api/salud` se quedaba en "degradado" para siempre. Ahora la
   ausencia de IA es estado normal (`ok` + `scoring.omitido: true`), con
   `OLLAMA_REQUIRED` para quien prefiera el comportamiento viejo.
3. **`stop.ps1` no descargaba los modelos**: los `llama-server.exe` seguían
   vivos con los pesos en memoria (6,7 GB de VRAM después de parar, 4,1 GB tras
   matarlos). Es la mitad de por qué "ya lo apagué y sigue ocupada".
4. **`OLLAMA_LLM` bajó a `llama3.2`** (4,7-5,8 s en CPU, contra 28,5 s del 14b
   *con* GPU) y **`OLLAMA_NUM_GPU=0` se descartó**: en Ollama 0.33.3 no existe y
   no evita nada.
5. **Tests: 80 → 86** backend (6 nuevos en `test_ia_opcional.py`), 16 frontend
   sin tocar.

## 4bis. Lo que se hizo en la 4ª pasada (27/09)

1. **`matches` llena con un barrido** (§3.8 del estado). `score.py --todo` no
   servía: su modo llama al LLM por cada fila y `qwen3:14b` tardó **28,5 s**
   medidos → 112 días para el dataset. `barrido_scores.py` lo reparte en fases:
   embeddings para todo (45 min), LLM solo para las mejores (28 s cada una).
2. **Bug #13** — `embed()` trocea y reintenta. Mandar cientos de textos de una
   vez tumba el tokenizer interno de Ollama (400 hacia su propio sidecar) y no
   había reintento, así que la pasada entera se caía.
3. **Bug #14** — la ruta vectorial **no aplicaba las reglas**, y el tope se
   diluía con la mezcla 35/65. Una tarjeta decía "presupuesto por debajo del
   mínimo" y puntuaba 77. El tope va ahora **después** de mezclar.
4. **Bug #15** — contar pendientes las traía todas a memoria. Un `COUNT` y el
   barrido pasó de 19/s a 141/s.
5. **Documentación** actualizada en los tres sitios.

## 5. Archivos clave

### Del panel (lo que corre por defecto)

| Ruta | Qué hace |
|---|---|
| `frontend/src/lib/api.js` | Fachada local. Misma superficie que la API de FastAPI: `salud()`, `estadisticas()`, `licitaciones()`, `sincronizar()`, … Rebuild del índice **antes** de emitir `listo` |
| `frontend/src/lib/ingesta.js` | Descarga por páginas, progreso, cancelación, deduplicación, contratos enlazados por `noticeUID`, `alListo` como callback |
| `frontend/src/lib/socrata.js` | `SocrataClient` (`pagina`, `iterRows`, `contar`), fechas sin zona horaria, `noticeUid`, `soqlDate` |
| `frontend/src/lib/db.js` | IndexedDB v2 con 6 stores (`procesos`, `ligeros`, `matches`, `contratos`, `acciones`, `meta`) + `AlmacenMemoria` de reserva |
| `frontend/src/lib/indice.js` | Filtros, facetas, orden y paginación en memoria; `versionDatos` para saber si hay que reconstruir |
| `frontend/src/lib/score.js` | TF-IDF + coseno + reglas del perfil, en la página |
| `frontend/src/lib/config.js` | Config en 3 niveles: `localStorage` > `public/app-config.json` > defaults |
| `frontend/src/Oportunidades.jsx` | Panel principal. Banner de "no se está guardando" cuando `salud.estado === 'degradado'` |
| `frontend/e2e/humo.spec.js` | 4 tests Playwright contra `vite preview`, con Socrata interceptado |
| `frontend/e2e/secop-real.spec.js` | 1 test opt-in contra datos.gov.co de verdad, acotado |
| `frontend/playwright.config.js` | `build && preview` en 4173, Chromium, 1 worker |
| `.run\captura-*.png` | Capturas de la página: vacía, descargando, con lista, con modal |
| `.run\web.pid` / `web.*.log` | PID y logs de Vite que crea `start.ps1` |

### Del backend legado (opcional, `-ConBackend`)

| Ruta | Qué hace |
|---|---|
| `ESTADO-PROYECTO.md` | **El documento maestro.** 15 bugs con causa y solución, trampas, qué falta, números de la base |
| `backend/scripts/barrido_scores.py` | Puntuación masiva por fases: `barrido`, `refinar`, `rehacer`, `--medir` |
| `backend/app/ai/matchmaker.py` | Pipeline de 2 etapas; reglas aplicadas en las dos rutas, tope tras mezclar, `_contar_pendientes()` |
| `backend/app/ai/ollama_client.py` | `embed()` troceado con reintento que reduce el lote y recuerda el que funciona |
| `backend/app/ai/rules.py` | Veredictos deterministas: `CAP_EXCLUSION=5`, `CAP_BUDGET=20`, penalizaciones |
| `backend/app/config.py` | `ollama_required` y `ENABLE_SCHEDULER` (apagado) |
| `backend/app/db.py` | Engine, `init_schema()` (migración + puente de bases heredadas), reconciliación |
| `backend/alembic/` | `env.py` con URL desde `app.config`; `0001_esquema_inicial.py` autogenerada |
| `start.ps1` / `stop.ps1` | Arranque/parada con espera activa. Ollama solo con `-ConOllama` y en CPU; `stop.ps1` mata el árbol de Vite con `taskkill /T` |

## 6. Decisiones y convenciones

- **Estilo de comentarios:** en español, y explican **por qué**, no qué hace el
  código. Cuando un detalle no es obvio, se escribe el símbolo concreto y el
  síntoma que produce.
- **Los tests corren contra PostgreSQL real** (`licitaciones_test`), no SQLite.
- **`PG_DATABASE` se fija antes de importar `app.config`** en `conftest.py`.
- **La URL de Alembic no vive en `alembic.ini`**, la pone `app/db.py`.
- **Scripts que escriben en la base, declaran a cuál escriben.**
  `barrido_scores.py` lo dice en el log al arrancar y se niega a correr contra
  una base `_test`.
- **Los tests del panel corren en el navegador**: vitest con jsdom para lógica y
  componentes, y Playwright + Chromium contra el **build de producción**. La
  carga real contra Socrata es un test aparte y **opt-in**, porque necesita
  internet y pesa.
- **No editar archivos con acentos desde PowerShell.** `Get-Content` +
  `Set-Content` leen UTF-8 como cp1252, destruyen los acentos y además meten BOM.
  Pasó dos veces en esta sesión. Para tocar código o `.md`, usar la herramienta de
  edición. Y ojo: **la consola imprime `á` como `?`**, así que un acento raro en la
  salida no es un fichero roto (comprobar los code points).
- **Comentarios en español, explicando el porqué**, no el qué.

## 7. Pendiente / próximos pasos

Ordenado por lo que bloquea al usuario:

1. **"Cargué, actualicé y no sale" queda mitigado/cerrado** (ver el bloque ⚠️
   OPEN arriba): la corrida completa en un Chromium limpio descargó, puntuó,
   pintó y persistió sin errores. Solo reabrirlo si el usuario lo reproduce.
2. **Pegar el `appToken` de Socrata** en el panel **Datos** (o en
   `public\app-config.json`), registrado en datos.gov.co. El soporte ya está
   hecho; es el único paso que depende de la cuenta del usuario. La ventana
   completa funcionó sin token el 29/10, pero el token reduce el riesgo de
   429/503 en repeticiones.
3. **Repetir la carga completa con `appToken`** en hora punta, si se quiere
   medir el peor caso. La primera medición ya está hecha (99 s, 80 peticiones,
   0×429/503, ~101 MB).
4. **Desplegar en Vercel**, si se decide: solo `frontend/dist` estático, sin
   `vercel.json` todavía. Recordar que los datos son por navegador.
5. **Lo del backend**, si vuelve a hacer falta: `--fase rehacer` de
   `barrido_scores.py` (~338.000 filas con el score viejo), refinado con LLM, y
   `docker-compose.yml`, lo único de la hoja de ruta original sin empezar.

## 8. Bloqueadores / notas — leer antes de tocar nada

### La GPU no da para los dos modelos a la vez

Cargar `qwen3:14b` mientras se embebe tumba el sidecar del tokenizer de Ollama.
Síntoma exacto: `400 {"error":"Post "http://127.0.0.1:57602/tokenize": dial tcp
...: connection refused"}` — `connection refused` hacia **su propio puerto
interno**. Si se ven fallos de embeddings, es esto, no la red.

### Por qué el proyecto se come la VRAM (y qué lo causa) — RESUELTO EL 28/09

Ollama **no descarga** los modelos entre llamadas, y el proyecto pedía dos a la
vez. Tres causas sumables, con `keep_alive=15m` como la principal
(`config.py:48`, lo manda el cliente en cada llamada, `ollama_client.py:143` y
`:201`):

| Qué | Cuánto |
|---|---|
| `qwen3:14b` (era el `OLLAMA_LLM`) | **8,8 GB** |
| `nomic-embed-text` | **274 MB** |
| Caché KV con `OLLAMA_NUM_CTX=4096` | hasta rozar 10 GB |

**Ya está arreglado** (§3.8.3). Tres capas, todas reversibles:

1. `start.ps1` **no** arranca Ollama; hace falta `-ConOllama`.
2. Con `-ConOllama`, arranca con `OLLAMA_LLM_LIBRARY=cpu` → ni detecta la GPU.
3. `Ollama_LLM_LIBRARY=cpu` y `OLLAMA_MAX_LOADED_MODELS=1` como variables de
   entorno de **usuario** de Windows, para que la bandeja de Ollama tampoco.

> **`OLLAMA_NUM_GPU=0` NO funciona en Ollama 0.33.3**: no existe esa variable
> (no sale en `ollama serve --help` ni en el `server config` del arranque) y el
> modelo se sube a CUDA igual. El control real es `OLLAMA_LLM_LIBRARY=cpu`.

Consecuencias del apagado: entra data de SECOP II igual, los 339.648 scores ya
calculados se ven igual, y lo único que no corre es **puntuar lo nuevo**.
`OLLAMA_REQUIRED=false` hace que eso no sea una avería: `/api/salud` sigue en
`ok` con `"apagada (opcional)"` y el ciclo de ingesta sale `ok: true` con
`scoring.omitido: true` (bug #16, `tests/test_ia_opcional.py`).
`OLLAMA_LLM` bajó a **`llama3.2`** (4,7-5,8 s en CPU, contra los 28,5 s del
14b *con* GPU).

**Trampa de parada:** matar `ollama.exe` **no descarga los modelos**. Cada modelo
cargado corre en su propio `llama-server.exe` y sobrevive. `stop.ps1` ya los
mata; a mano: `Get-Process 'llama-server' | Stop-Process -Force`.

Verificación: `ollama ps` → `100% CPU`, log con `CPU model buffer size`, VRAM
estable en ~4,4 GB con los dos modelos cargados. Detalle en `ESTADO-PROYECTO.md`
§3.8.2 y §3.8.3.

### Un tope que se aplica antes de mezclar no es un tope

`blend_scores()` es 35% vectorial + 65% veredicto. Si el tope de las reglas
(`RuleVerdict.max_score`) se aplica **antes** de mezclar, el 35% vectorial lo
desvía: un tope de 20 daba 40, y una exclusión del perfil daba 27 en vez de 0.
Por eso el corte va **después**, dentro de `_payload()`. Las penalizaciones
(modalidad, territorio) sí se aplican antes de mezclar, que es como están
documentadas.

### El `TRUNCATE` de la 3ª pasada ya está superado

La base se había vaciado; se recuperó re-descargando y hoy está **llena y
puntuada**. Lo único que de verdad no se recuperaba eran los scores, y eso ya
está resuelto con el barrido. El resto de la historia está en
`ESTADO-PROYECTO.md` §5.6.

### Trampas del entorno, ya pagadas

- **PowerShell + acentos:** ver §6. Corruptiona los `.md` en silencio.
- **`engine.begin().execute(...)` sin `with` deja la transacción abierta** y
  bloquea la tabla: el siguiente DDL se cuelga para siempre. Pasa.
- **`alembic_version` no está en `Base.metadata`**, así que `drop_all` no la
  borra y el esquema queda como fantasma.
- **Este disco paga ~0,5-2 s de `fsync` por transacción que escriba WAL.** Por
  eso la suite tardaba 5'30" y ahora 4'.

## 9. Prompt sugerido para pegar tras `/new`

```
Continúa el proyecto de F:\Proyectos\Licitaciones. Lee primero SESSION-SUMMARY.md
y luego ESTADO-PROYECTO.md (la 8ª pasada está al principio).

Estado: la app funciona entera en el navegador. El panel Datos ya permite pegar
el appToken de Socrata, elegir días y topes, y guardar la configuración. La
decisión de producto es 5.000 procesos / 2.000 contratos por defecto, con el
preset "Ventana completa · 7 días" (50.000/50.000) como opt-in que pide token.
La carga completa ya se midió sin token: 24.047 filas → 18.346 procesos
distintos, 14.357 contratos, 80 peticiones, 99 s, 0×429/503, ~101 MB.

Lo que queda, por orden:
1. Pegar el appToken real en el panel Datos (o en frontend/public/app-config.json).
   Crear la cuenta en datos.gov.co no se puede hacer desde el agente.
2. Repetir la carga completa con token en hora punta, si se quiere medir el peor
   caso; la primera medición ya está hecha.
3. "Descargué, actualicé y no sale" queda mitigado/cerrado en navegador limpio;
   solo reabrirlo si el usuario lo reproduce.

Antes de dar nada por bueno: npm test (74) y npm run test:e2e (5) en verde, y
$env:SECOP_REAL='1'; npx playwright test e2e/secop-real.spec.js para la carga real
acotada.

Dos avisos: no edites ficheros con acentos desde PowerShell (rompe los UTF-8 y mete
BOM; usa la herramienta de edición), y este disco paga ~0,5-2 s de fsync por
transacción que escriba WAL.
```

### Lo que NO hay que seguir haciendo

- **No tocar el backend** para resolver lo del panel vacío. Ollama, PostgreSQL y
  FastAPI no participan en la descarga ni en el score; todo eso va en el
  navegador.
- **No subir nada a Vercel sin decidirlo antes**: la respuesta ya está escrita
  (el panel sí sube y el score funciona igual, pero los datos siguen siendo por
  navegador, y Ollama/PostgreSQL/CRON no pueden ir).
- **No volver a pasar los datos de verdad** por el shell para "mirarlos": ya hay
  el test opt-in para eso.

---

*Archivos de este resumen: `F:\Proyectos\Licitaciones\SESSION-SUMMARY.md` y
`SESSION-SUMMARY.txt` (mismo contenido).*
