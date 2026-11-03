# Plataforma de Licitaciones SECOP II — Estado del Proyecto

> ## 8ª pasada (29/10): la carga completa real, medida — y el score que no se pintaba
>
> ### 1. Qué se hizo
>
> - **Carga completa de la ventana de 7 días, de punta a punta y sin `appToken`.**
>   24.047 filas de procesos (18.346 distintos tras deduplicar; el dataset publica
>   copias), 14.357 contratos, **80 peticiones**, **99 s**, **0 respuestas
>   429/503**, 0 caídas, 0 errores de consola y **~101 MB** en IndexedDB. Los
>   18.346 procesos quedaron puntuados y persistidos, y la lista pintó 24 fichas
>   por página. Es la prueba de fuego que llevaba pendiente desde la 6ª pasada.
> - **Bug real corregido: la lista no pintaba el score.** `Indice.filaDe`
>   devolvía `score` suelto y `aOportunidad` lee `fila.match`, así que todas las
>   tarjetas salían con `—` aunque la cabecera dijera "18.346 puntuados". Se
>   añade el `match` completo a la fila; afecta también a "similares". El test de
>   humo solo miraba la palabra "score", no el número, y por eso no lo cazó.
> - **Dos tests nuevos para que no vuelva:** uno unitario de la fachada
>   (`api.licitaciones` devuelve `match.score`, no solo el score suelto) y un
>   assert del número en el e2e de humo (`article .score-num` tiene que ser
>   dígitos, no `—`).
> - **El panel `Datos` ya enseña las cifras medidas:** ~24.000 procesos y ~14.000
>   contratos en la ventana completa, en vez de la estimación de ~31.000/~18.000.
>
> ### 2. Verificación de esta pasada
>
> | Comprobación | Resultado |
> |---|---|
> | `npm test` | **74/74** (73 anteriores + 1 de la fachada) |
> | `npm run test:e2e` | **5/5** de humo + 1 skipped (el real opt-in) |
> | Carga real acotada (`SECOP_REAL=1`) | **1/1** — 4 peticiones, 0×4xx/5xx, 0 caídas, 0 errores, 120 procesos puntuados |
> | Carga completa 7 días (manual) | **1/1** — 80 peticiones, 99 s, 0×429/503, 0 errores, 18.346 procesos + 14.357 contratos, ~101 MB |
> | Build de producción | OK — 228,36 kB JS (71,96 kB gzip), 11,29 kB CSS |
> | Capturas | `.run\captura-full-7dias.png` (lista con scores) y `.run\captura-panel-datos.png` |
>
> ### 3. Lo que sigue
>
> - **El `appToken` sigue siendo el único paso externo.** La carga completa
>   funcionó sin él el 29/10, pero eso no está garantizado en horas punta: con
>   token el límite de Socrata es mucho más alto. Se pega en **Datos** o en
>   `frontend/public/app-config.json`.
> - **"Cargué, actualicé y no sale" queda mitigado/cerrado** salvo que se
>   reproduzca en el navegador del usuario: la corrida completa en un Chromium
>   limpio descargó, puntuó, pintó y persistió sin errores.
> - La carga completa **no entra en `npm run test:e2e`**: golpea el portal real y
>   deja ~100 MB en el perfil del navegador. Sigue siendo una medición manual.
>
> ---

> ## 7ª pasada (29/10): la descarga se configura desde el panel y los topes dejan de ser un secreto
>
> ### 1. Qué se hizo
>
> - **Panel `Datos` en la cabecera.** Reúne lo que antes solo se podía cambiar
>   editando `frontend/public/app-config.json` y volviendo a compilar:
>   `appToken`, `lookbackDays`, `maxProcesos`, `maxContratos` y
>   `includeContracts`. Se guarda en `localStorage`, que manda sobre el fichero,
>   y se aplica en la siguiente descarga sin recargar.
> - **Dos presets explícitos.** `Rápida · 5.000 procesos` deja los topes en
>   5.000/2.000; `Ventana completa · 7 días` los sube a 50.000/50.000, que cubre
>   de sobra la ventana (medida en la 8ª pasada: ~24.000 filas de procesos y
>   ~14.000 contratos). Si se elige la ventana completa sin token, el panel avisa
>   de que Socrata puede cortar la descarga con 429/503.
> - **La decisión de producto, escrita:** por defecto se bajan **5.000 procesos
>   y 2.000 contratos**; la ventana completa es opt-in y pide `appToken`. Esto
>   cierra la contradicción que había entre el documento (que hablaba de ~31.000
>   procesos por defecto) y el código (que llevaba desde el 6/10 con topes de
>   5.000/2.000). La medición real de la 8ª pasada dejó la ventana en ~24.000
>   filas de procesos y ~14.000 contratos.
> - **`scoreLimit` eliminado.** Estaba en `config.js` y en los documentos como si
>   recortara la puntuación, pero no se usaba en ningún sitio: al subir
>   `maxProcesos` se puntuaba todo lo descargado. Ahora el código y lo que se
>   cuenta coinciden: todos los procesos descargados se puntúan.
> - **El error de Socrata apunta al panel.** El mensaje de 429/503 ya no dice
>   "baja `maxProcesos` en la misma ficha" (una ficha que no existía): dice
>   "panel Datos (o `app-config.json`)".
> - **`app-config.json` completo:** `appToken`, `lookbackDays`, `maxProcesos`,
>   `maxContratos` e `includeContracts`. Sigue siendo el valor de fábrica de un
>   despliegue; el panel lo pisa con `localStorage`.
>
> ### 2. Lo que sigue sin hacerse (y por qué)
>
> - **El `appToken` sigue vacío.** Crear la cuenta en datos.gov.co exige correo,
>   verificación y aceptar sus términos; no se puede hacer desde el agente. El
>   soporte está terminado: en cuanto se pegue el token en **Datos** (o en
>   `app-config.json`), la descarga lo usa. Es el único paso del punto 1 que
>   depende del usuario.
> - **La carga completa real** de la ventana de 7 días seguía sin medirse en esa
>   pasada; se midió en la 8ª (99 s, 80 peticiones, 0×429/503, 18.346 procesos y
>   14.357 contratos). Hasta entonces lo verificado con datos reales era la carga
>   acotada a 120 procesos.
>
> ### 3. Verificación de esta pasada
>
> | Comprobación | Resultado |
> |---|---|
> | `npm test` | **73/73** (71 anteriores + 2: panel `Datos` y selector de días) |
> | `npm run test:e2e` | **5/5** de humo + 1 skipped (el real opt-in) |
> | Carga real acotada (`SECOP_REAL=1`) | **1/1** — 4 peticiones, 0×4xx/5xx, 0 caídas, 0 errores de consola, 118 procesos puntuados y persistidos |
> | Build de producción | OK (el que genera `npm run test:e2e`) |
>
> ### 4. Cómo se usa ahora
>
> 1. `.\start.ps1` y abrir http://localhost:5173.
> 2. **Datos** → pegar el `appToken` si se tiene; elegir `Rápida` o `Ventana
>    completa`; guardar.
> 3. **Descargar SECOP**. El panel aplica los topes de la configuración.
>
> ---

> ## 6ª pasada: el panel pasa de "creído" a "probado en un navegador"
>
> ### 1. Qué se añadió
>
> - **Playwright + Chromium**, con 5 tests de humo contra el **build de
>   producción** (`vite preview`, puerto 4173) interceptando `datos.gov.co`, y un
>   sexto que golpea el portal de verdad y es **opt-in** (`SECOP_REAL=1`) porque
>   esa suite tiene que poder correr sin internet. Acotado a 120 procesos de los
>   ~31.000 de la ventana de 7 días, salvo para bajar cientos de MB.
> - **Aviso visible cuando los datos no se están guardando.** El fallback a
>   memoria avisaba por `console.warn` y en el `title` del chip, o sea que había
>   que acertar el ratón para verlo. Ahora es un banner ámbar fijo en
>   `Oportunidades.jsx` + `.banner.aviso` en CSS, **sin botón de cerrar**: si no
>   se guarda, no es información que se pueda dejar pasar. Dos tests nuevos lo
>   fijan.
> - Capturas de la página en `.run\captura-*.png`: vacía, descargando, con la
>   lista y con el modal.
>
> ### 2. Lo que encontró la suite al ejecutarse (y estaba documentado como "OK")
>
> Cinco bugs, todos escritos correctamente: los cinco pasaban `node --check`, el
> build y la revisión a ojo, y ninguno se veía leyendo el código. El detalle
> está en el bloque de la 5ª pasada
> (§ "los bugs que la revisión estática no veía"): `aceite()`/`acepta`,
> `isoDia()` en UTC, `stop.ps1` que no mataba el árbol de Vite, la carrera
> `listo`/reindexado, y `iterRows` comprobando el tope **después** de leer la
> página (499 procesos de más con `maxProcesos: 120`).
>
> ### 3. "cargué desde localhost, actualicé y no sale": el vacío ahora se explica solo
>
> El usuario ve la página vacía después de descargar y recargar. **La
> persistencia funciona por mi lado** (30 procesos, 30 ligeros, 30 matches, 10
> contratos y `meta` siguen ahí tras recargar en un Chromium limpio), así que
> el caso real es: en ese origen las stores están a cero. La causa raíz sigue
> sin confirmar porque el usuario no pegó el snippet pedido, pero dejó de
> importar: **el diagnóstico está ahora en la propia página**.
>
> - **El error de la descarga sobrevive a recargar.** `progreso_sync` ya se
>   persistía con `fase: 'error'` en IndexedDB, pero **nadie lo leía al
>   cargar**: tras F5 no quedaba rastro de que algo hubiese fallado y solo se
>   veía una página vacía. Ahora `api.estadoSync()` restaura ese progreso (y
>   `Oportunidades` lo pide en el arranque), y la cabecera muestra el chip de
>   error con lo que ocurrió.
> - **El vacío se explica a sí mismo**: el error real de la última descarga
>   (`HTTP 429…`), si se cortó a mitad cuántos de cuántos llevaba (y que
>   "Descargar SECOP" la retoma), el **origen exacto** con su almacén — la
>   respuesta a "descargué en `localhost` y abrí en `127.0.0.1`/incógnito/otro
>   navegador", que hasta ahora hacía falta pedir por consola — y una línea
>   que distingue "descarga fallida" de "descarga completada aquí y el panel no
>   encuentra procesos" (ese ya sería fallo mío, no de Socrata).
> - **Socrata: `Retry-After` respetado, reintentos de sobra y pista al fallar.**
>   Los reintentos de 429/503 esperan lo que pide el servidor (tope 60 s) en vez
>   de la espera creciente, el 429/503 concede **dos reintentos extra** sobre
>   `maxRetries` (4 → 6) y hace que la paginación **ralentice su ritmo** (x3 por
>   límite, tope 5 s) para el resto de la corrida: el límite se levanta esperando,
>   no con más prisa. Y el error final ya dice el arreglo: registrar `appToken` en
>   datos.gov.co y pegarlo en `frontend/public/app-config.json` (creado, se copia
>   a `dist`), o bajar `maxProcesos`.
> - **Tests 61 → 71** (3 de `estadoSync`, 4 de Socrata —`Retry-After` acorta la
>   espera, dos reintentos extra en un 429 persistente y ritmo x3 tras un
>   límite—, 1 del vacío en `Oportunidades`, 2 de recarga en `Sincronizador`)
>   **y el quinto humo de Playwright**: 429 interceptado → chip con la pista →
>   `reload` → el error sigue visible y el vacío explica el origen. 71 + 5 en
>   verde, build de 223 kB.
> - **Re-verificado contra el SECOP real** (`SECOP_REAL=1`), ya con todos los
>   cambios dentro: `peticiones a datos.gov.co: 4`, `4xx/5xx: 0`, `caídas: 0`,
>   `errores de consola: 0`, `120 procesos · 120 puntuados` y los datos siguen
>   ahí tras recargar. La cadena descarga → puntúa → IndexedDB → F5 funciona
>   contra el portal de verdad **sin appToken**. (Acotada a 120 procesos: la
>   ventana completa son ~65 peticiones, que es donde puede salir el límite.)
> - **Aviso para quien toque el e2e del 429**: el route tiene que mandar
>   `Access-Control-Expose-Headers: Retry-After` además del header. Sin eso CORS
>   no deja que el JS lo lea, el cliente cae en la espera por defecto (5 s por
>   intento) y el caso tarda ~75 s en fallar: el test se cae por timeout sin que
>   nada esté mal en el producto. Descubierto depurando este mismo test.
>
> El candidato más probable a causa raíz, sin confirmar, sigue siendo el
> **límite de peticiones de Socrata**: en aquel momento la descarga pretendía
> bajar la ventana completa (~30.000 procesos + ~18.000 contratos ≈ 65
> peticiones), y sin `appToken` eso da 429/503 y la descarga muere a medias.
> (Desde la 7ª pasada el defecto son 5.000 procesos / ~15 peticiones; la
> ventana completa es opt-in desde el panel `Datos`.) Ni las pruebas de humo
> (interceptadas) ni la real acotada (4 peticiones) llegan a ese volumen, así
> que el límite no se ha podido reproducir; lo que sí está garantizado es que,
> si pasa, ahora se ve escrito en la página en vez de dejar una pestaña vacía.
>
> ### 4. Vercel: qué sí y qué no
>
> **El panel sí se sube** (tres ficheros estáticos en `frontend\dist`, `base:
> './'`, sin servidor ni variables) y **el score funciona igual** (TF-IDF en el
> navegador). Los links de SECOP también: el botón "Abrir en SECOP" está en
> `Tarjeta.jsx:104` y `Detalle.jsx:120`, y las URLs reales responden HTTP 200 con
> el patrón `OpportunityDetail/Index?noticeUID=CO1.NTC.*`.
>
> **Lo que no puede ir:** Ollama (proceso largo, sin GPU), PostgreSQL (sin disco
> persistente) y el ciclo automático (Cron solo llama a serverless). Y **los datos
> son por navegador**, así que en Vercel cada visitante empieza a cero hasta que
> pulse "Descargar SECOP"; para datos compartidos habría que poner un backend +
> Neon/Turso/Supabase. No se ha desplegado nada ni hay `vercel.json`.
>
> ### 5. Lo único grande que sigue sin medirse
>
> La **carga completa** de la ventana de 7 días (~31.000 procesos). Todo lo demás
> está probado: 71 unitarios, 5 de humo, 1 de carga real acotada, build de
> 223 kB y el ciclo `.\start.ps1` / `.\stop.ps1` de punta a punta sin residuos.
>
> ---

> ## 5ª pasada: el panel dejó de depender del servidor
>
> **El sistema ya no tiene servidor, ni base de datos, ni modelo.** Todo lo que
> había en PostgreSQL y en Ollama está ahora en el navegador: los datos en
> IndexedDB, la descarga contra `datos.gov.co` desde la propia página y la
> puntuación con TF-IDF y coseno en JS puro (`frontend/src/lib/`). El backend con
> FastAPI y PostgreSQL se conserva **opcional y apagado**: `.\start.ps1` levanta
> solo el frontend, y `-ConBackend` es quien lo enciende si alguien lo quiere.
>
> Qué cambió y por qué:
>
> | Antes | Ahora |
> |---|---|
> | PostgreSQL embebido siempre levantado | No hace falta; solo con `-ConBackend` |
> | API FastAPI intermediaria | `src/lib/api.js`, una fachada local con la misma superficie |
> | Panel → `fetch('/api/...')` | Panel → `api.*` (mismos métodos, mismas formas de respuesta) |
> | `bge-m3` de 560M en Ollama (~1 GB RAM, ~40 s en cargar) | Índice TF-IDF invertido sobre postings, en memoria |
> | `qwen3:14b` redactando los `bullets` (~28,5 s/licitación) | Las razones de las reglas y los términos de más peso |
> | Sync cada 30 min por cron de la API | Solo al pulsar el botón, y se puede cancelar |
> | Puntuación masiva por fases con `barrido_scores.py` | `puntuarCorpus` por lotes de 400, con cesión de hilo |
> | Exportar desde la API | `Exportar`/`Importar` en NDJSON desde el panel |
> | `ollama ps` → `100% CPU` para no tocar la VRAM | No hay modelo: la VRAM es 0 por definición |
>
> **Los bugs que corregía el diseño nuevo están resueltos y documentados**, y hay
> tests para ellos: el tope de las reglas se aplica después de mezclar (bug #14,
> §5.7), el día se lee de los diez primeros caracteres del ISO (sin pasar por UTC),
> el `noticeUID` es la clave de unión, los ids repetidos se deduplican antes de
> escribir (bug #8) y los campos `url` de Socrata se aplanan (bug #3).
>
> **Y los encontró la propia suite, no la revisión a ojo.** Tres que habrían
> llegado a producción:
>
> | Bug | Qué rompía |
> |---|---|
> | `indice.js` llamaba `aceite()` donde se definía `acepta` | `ReferenceError` en **toda** consulta con filtros: el panel entero, no una esquina |
> | `isoDia()` truncaba en UTC | Con hora local de madrugada el **primer día de la ventana se quedaba fuera** sin avisar; de tarde, entraba un día de más |
> | `stop.ps1` mataba solo el `npm.cmd` que envuelve a Vite | Decía "[ok] web cerrado" con Vite vivo, 104 MB y el 5173 ocupado |
> | La ingesta emitía `listo` antes de rehacer el índice | La descarga se guardaba y se puntuaba bien, pero el panel se quedaba en "0 oportunidades" y no se arreglaba hasta pulsar "Actualizar" |
> | `iterRows` comprobaba `maxRows` **después** de leer la página | El tope no era un tope: con `maxProcesos: 120` y páginas de 500 se pedían y guardaban hasta **499 procesos de más** (y sin puntuar, porque `scoreLimit` los recortaba) |
> 
> Los cinco pasaban `node --check`, el build y la revisión a ojo. Los dos primeros
> los encontró vitest; el cuarto, Playwright, por ser una carrera de tiempo que solo
> se reproduce en un navegador de verdad; y el quinto, la carga contra **datos.gov.co
> de verdad**, porque ni los tests unitarios ni el humo con datos falsos miran el
> `$limit` que sale en la URL. Es exactamente el tipo de fallo que no aparece
> leyendo el código.
> 
> **Verificación en runtime:** 61 tests de vitest + 4 de Playwright en verde, build
> de 220 kB, el ciclo `.\start.ps1` / `.\stop.ps1` comprobado de punta a punta
> (levanta en 5173, HTTP 200, para y deja el puerto libre sin residuos) y una carga
> real acotada a 120 procesos contra `datos.gov.co`: 4 peticiones, **0 respuestas
> 4xx/5xx, 0 peticiones caídas, 0 errores de consola**, 116-120 procesos guardados
> (120 leídos, menos los ids repetidos que devuelve el portal) y todos puntuados,
> todo persistido en IndexedDB tras recargar.
>
> **Comprobación visual:** la página se renderizó en un Chromium de verdad contra
> el servidor de desarrollo, con capturas en `.run\captura-*.png` (estado vacío,
> descargando, con la lista y con el modal de detalle abierto). Antes de descargar,
> la cabecera dice `IndexedDB · 0 procesos · 0 puntuados` y el cuerpo pide pulsar
> el botón; después, `120 procesos · 120 puntuados` con 24 fichas por página y el
> modal abriendo con su detalle y contratos. Título: `Oportunidades ·
> Licitaciones SECOP II`. Con 0 errores de consola en las cuatro capturas.
>
> Ojo con esto: el estado del panel es **por navegador**. Otro navegador, o el
> incógnito, empiezan a cero aunque la descarga ya se haya hecho en el primero.
>
> Y una limitación del método: lo visual se comprobó por DOM y por captura, no a
> ojo, porque el agente no puede mirar imágenes. Los `.png` están para quien quiera
> verlos; el resto de lo que se afirma aquí sale de `innerText`, del conteo de
> elementos y de los errores de consola.
>
> Con datos de verdad, Socrata no dio ni un 503 en 4 peticiones. Con el `appToken`
> de `app-config.json` hay mas margen, pero el proceso funciona igual sin el
> gracias a los reintentos.
>
> **Lo que este documento sigue siendo:** el historial. Las secciones de abajo
> describen el sistema con backend y explica por qué se construyó así; siguen
> siendo la referencia para volver a él (`-ConBackend`), pero ya no describen lo
> que se ejecuta por defecto. Lo que se ejecuta está en `README.md` y en
> `frontend/src/lib/`.
>
> **Pendiente de esta pasada:** nada de la migración del panel. Los 58 tests del
> frontend pasan y `.\start.ps1` levanta y para comprobando el puerto. Lo único que
> no se ha medido es una **carga real** de SECOP desde el navegador (unos cientos
> de MB y varios minutos), porque no se ha pulsado el botón de descarga: eso hay que
> hacerlo con la mano. Con `-ConBackend`, la suite de Python sigue siendo la del
> backend y no se ha tocado.

---

> Documento de estado generado el **2026-09-26**. Describe qué hace el sistema, qué
> está construido, qué está verificado funcionando y qué falta.
>
> **Última actualización (4ª pasada, 27/09):** `matches` estaba a cero desde el
> `TRUNCATE` de la 3ª pasada (§5.6), y era lo único que bloqueaba el uso diario.
> Se **llenó entera**: 339.608 licitaciones puntuadas con un barrido por
> embeddings (§3.8), que es la etapa 1 del matchmaker corrida sobre todo el
> dataset en vez de sobre 40 filas. El panel ya muestra las 340.000
> oportunidades, con sus filtros y sus facetas. De paso salieron **tres bugs
> nuevos** (§5.7): que la ruta vectorial no aplicaba las reglas, que el tope de
> las reglas se diluía con la mezcla, y que contar pendientes las traía todas a
> memoria. Tests: **66 → 80**.
>
> **Lo que el LLM no puede hacer, y por qué importa:** `qwen3:14b` tardó
> **28,5 s** por licitación medidos hoy. Puntuar las 339.608 por esa vía serían
> **278 días**. Por eso el diseño en dos etapas no es una optimización: es lo
> único que hace el proyecto utilizable.
>
> **Pendiente de esta misma pasada:** el arreglo de las reglas está en el
> código, pero solo se ha aplicado a ~1.000 filas (ver §5.7); falta correr
> `barrido_scores.py --fase rehacer` para las ~338.000 restantes.
>
> **Para retomar en una sesión nueva:** `SESSION-SUMMARY.md` tiene el arranque
> rápido, el estado verificado de la base, los pendientes en orden y las
> trampas del entorno. Este documento es el maestro y va más al detalle.

---

## 0. Lo primero que hay que saber

| Si quieres… | Mira |
|---|---|
| Ver qué falta | §6 |
| Entender por qué el esquema es como es | §5.5 (Alembic) |
| Saber qué se rompió y por qué | §5 (bugs #1 a #15) |
| Levantar el sistema | §7 |
| Entender la puntuación masiva | §3.8 y §5.7 |
| Cambiar el esquema a partir de ahora | §5.5, con `alembic revision --autogenerate` |

**El estado de los datos es lo primero que cambia de una sesión a otra.** Al
cerrar la 3ª pasada `matches` estaba a cero y el panel enseñaba tarjetas sin
puntuación. **Ya no: está llena** (§8). Lo que sí queda a medias son los scores
recalculados con el arreglo de reglas, que es un trabajo de minutos (§5.7).

---

## 1. Qué es y qué trata

Plataforma web que **busca, filtra y puntúa automáticamente las licitaciones públicas
del estado colombiano** usando **IA 100% local** (sin enviar datos a servicios externos).

### Flujo completo

```
Datos Abiertos Colombia (Socrata)
   ├── SECOP II - Procesos de Contratación   (p6dx-8zbt)  ~diario
   └── SECOP II - Contratos Electrónicos     (jbjy-vk9h)  ~diario
            │
            ▼
   ┌─────────────────────────┐
   │  INGESTA (ciclo autónomo)│  cada 30 min + diario 03:15
   └────────────┬────────────┘  paginación, reintentos, upsert troceado
                ▼
   ┌─────────────────────────┐
   │  PostgreSQL + pgvector  │  tablas normalizadas estilo OCDS
   └────────────┬────────────┘
                ▼
   ┌─────────────────────────────────────────────┐
   │  MATCHMAKER (IA local / Ollama)            │
   │  1. nomic-embed-text → similitud coseno     │
   │  2. reglas deterministas (cortes duros)    │
   │  3. qwen3:14b → score 0-100 + 3 viñetas    │
   └────────────┬───────────────────────────────┘
                ▼
   ┌─────────────────────────┐
   │  API FastAPI             │  filtros, orden por score, OCDS
   └────────────┬────────────┘
                ▼
   ┌─────────────────────────┐
   │  Panel React             │  tarjetas ordenadas por score
   └─────────────────────────┘
```

### Los 4 componentes pedidos y su estado

| Componente | Pedido | Estado |
|---|---|---|
| Backend / motor de extracción | Python FastAPI + cron | **Funcional** (FastAPI + APScheduler + CLI) |
| Base de datos | PostgreSQL | **Funcional** (PostgreSQL 16.2 + pgvector 0.6.2) |
| Capa IA local (Matchmaker) | Ollama / Transformers | **Funcional** (embeddings + LLM local) |
| Frontend | React / Next.js / Flutter | **Funcional** (Vite + React, 7 tests) |

---

## 2. Arquitectura y estructura de carpetas

```
F:\Proyectos\Licitaciones\
├── .env                          configuración (creado)
├── .venv/                        Python 3.12 + dependencias
├── .pgdata/                      cluster PostgreSQL local
│
├── backend/
│   ├── requirements.txt
│   ├── alembic.ini               sin URL: la toma de app.config (ver §5.5)
│   ├── alembic/
│   │   ├── env.py                comparacion con el modelo, filtro de alembic_version
│   │   ├── script.py.mako
│   │   └── versions/
│   │       └── 0001_esquema_inicial.py   las 6 tablas + la extensión vector
│   ├── app/
│   │   ├── main.py               FastAPI: CORS, lifespan, routers
│   │   ├── config.py             settings (pydantic-settings)
│   │   ├── db.py                 engine, sesión, init_schema (Alembic) y la
│   │   │                         migración implícita para bases heredadas
│   │   ├── models.py             ORM: Tender, Contract, Match,
│   │   │                         TenderAction, CompanyProfile, SyncRun
│   │   ├── schemas.py            Pydantic (entrada/salida)
│   │   ├── ocds.py               mapeo a Open Contracting Data Standard
│   │   ├── scheduler.py          cron diario (APScheduler)
│   │   ├── api/
│   │   │   ├── tenders.py        /licitaciones  (listado, detalle, acciones)
│   │   │   ├── contracts.py      /contratos
│   │   │   ├── profile.py        /perfil
│   │   │   └── sync.py           /salud /sync /score /estadisticas
│   │   ├── ingest/
│   │   │   ├── socrata.py        cliente SODA: paginación, reintentos, SoQL
│   │   │   ├── secop_procesos.py extractor p6dx-8zbt
│   │   │   ├── secop_contratos.py extractor jbjy-vk9h
│   │   │   ├── upsert.py         upsert masivo troceado (nuevo, ver §3.7)
│   │   │   └── runner.py         orquestador sync + lock + scoring + stats
│   │   ├── ai/
│   │   │   ├── ollama_client.py  embeddings (/api/embed) + chat JSON
│   │   │   ├── embedder.py       coseno, mezcla de scores, tokens
│   │   │   ├── prompts.py        prompt del matchmaker + saneado JSON
│   │   │   ├── rules.py          filtro determinista (exclusiones, presupuesto)
│   │   │   └── matchmaker.py     pipeline de 2 etapas
│   │   └── seed/profile.yaml     Perfil de Empresa semilla
│   ├── scripts/
│   │   ├── pg_manager.py         cluster PostgreSQL sin servicio
│   │   ├── bootstrap.py          crea esquema + perfil
│   │   ├── extract.py            CLI de extracción
│   │   ├── score.py              CLI de puntuación
│   │   ├── barrido_scores.py     puntuación masiva por fases (nuevo, §3.8)
│   │   ├── alinear_esquema.py    script de una vez (§5.5)
│   │   └── capture_fixtures.py   captura payloads reales para los tests
│   └── tests/
│       ├── test_ingesta.py       bulk_upsert, troceado, dedup, enlace
│       ├── test_alertas.py       umbral de fallos seguidos
│       ├── test_migracion.py     migración implícita de app/db.py
│       ├── test_alembic.py       migraciones, base heredada, logging
│       ├── test_matchmaker.py    conteo de pendientes y reglas en la ruta
│       │                         vectorial (nuevo, 8 tests)
│       └── test_ollama_client.py troceado y reintentos de embeddings
│                                 (nuevo, 5 tests, sin tocar la red)
│
└── frontend/                     Vite + React (funcional)
    ├── package.json              vite 8, react 18, vitest 5
    ├── vite.config.js            dev server + proxy /api -> :8000
    ├── index.html
    └── src/
        ├── main.jsx              punto de entrada
        ├── Oportunidades.jsx     panel principal: filtros + tarjetas + paginación
        ├── styles.css            tema oscuro
        ├── lib/
        │   ├── api.js            cliente fetch de la API
        │   └── format.js         pesos, fechas, semáforo, cuenta regresiva
        ├── components/
        │   ├── Tarjeta.jsx       tarjeta con score, viñetas y acciones
        │   ├── PanelFiltros.jsx  score, texto, precio, facetas, por vencer
        │   ├── EstadoSync.jsx    botón de sincronizar + estado en vivo
        │   └── Detalle.jsx       modal: resumen, análisis IA, similares, OCDS
        └── test/
            ├── fixtures.json     respuestas reales capturadas de la API
            ├── Oportunidades.test.jsx
            └── EstadoSync.test.jsx
```

---

## 3. Decisiones de arquitectura relevantes

### 3.1 PostgreSQL embebido (por qué, y qué costó)

El entorno **no tiene permisos de administrador** (no se pueden crear servicios de
Windows), por lo que el instalador oficial de PostgreSQL falla con `0x800704C7`.
La solución fue usar el paquete `pgserver`, que trae los binarios de PostgreSQL
**16.2 con pgvector** y ejecutarlos directamente en espacio de usuario.

Se escribieron a mano las llamadas a `initdb` / `pg_ctl` porque `pgserver` en Windows
asigna un **puerto aleatorio** en cada arranque y crea el rol con el nombre del
usuario de Windows. El gestor propio fija puerto `5432` y rol `postgres`.

**Problemas encontrados y resueltos** (documentados por si reaparecen):

| Síntoma | Causa | Solución |
|---|---|---|
| `pg_ctl` se cuelga indefinidamente | El servidor desligado hereda los pipes de `capture_output=True` y `subprocess.run` espera EOF | Redirección a `tempfile.TemporaryFile` en vez de `PIPE` |
| `invalid value for parameter "TimeZone"` | El build embebido **no incluye** `share/postgresql/timezone`; Postgres rechaza incluso `UTC` | No fijar zona horaria; conversión a hora Colombia en Python |
| `unrecognized configuration parameter "maintenance_workmem"` | Typo propio | `maintenance_work_mem` |

Bonus: **pgvector 0.6.2 quedó disponible** sin instalar nada, así que la búsqueda
semántica es nativa de Postgres.

### 3.2 SoQL: las fechas NO son epoch

Los datasets de SECOP II declaran sus fechas como **`calendar_date`**, no como
`floating timestamp`. Consecuencias verificadas contra la API real:

- Comparar contra epoch en milisegundos → **HTTP 400**
- Comparar contra literal ISO-8601 (`'2026-09-24T00:00:00'`) → **HTTP 200**
- El JSON devuelve **cadenas ISO**, no epoch → el parser normaliza ambos formatos

Además, como `calendar_date` tiene granularidad de día (medianoche), una ventana
calculada con hora exacta (`>= 01:53:45`) puede devolver 0 filas aunque haya datos.
Por eso el filtro incremental usa **granularidad de día**.

### 3.3 Recuperación automática de la ventana

Si la ventana incremental diaria viene vacía (fines de semana, días sin publicación,
o máquina apagada varios días), el runner **reintenta ampliando a 30 días**
(`SYNC_CATCHUP_DAYS`). Sin esto, una instalación nueva podría quedarse sin datos
para siempre: el dataset oficial llegó a tener su registro más reciente en
`2026-09-24` cuando la ventana pedía desde `2026-09-24T01:53`.

### 3.4 Matchmaker en 2 etapas (por qué no puntuar todo con el LLM)

Puntuar miles de procesos con un LLM local es inviable (≈15 s/licitación con 14B).
El diseño es:

1. **Embeddings** (`nomic-embed-text`, 768 dims) + similitud coseno → ordena
   candidatos. Una llamada por lote, muy barata.
2. Solo los **40 mejores** pasan al LLM, que aporta juicio contextual y las viñetas.
3. El score guardado (0-100) es la **mezcla**: `35%` vectorial + `65%` LLM.
   La similaridad se guarda aparte para poder auditar el resultado.

### 3.5 Reglas deterministas antes/después del LLM

**Problema real medido:** `llama3.2` (1.9B) es complaciente. Puntuó **66** a
*"SUMINISTRO DE ACCESORIOS MARCA BROWN-FI PARA ECOPETROL"* y **68** a *"PRESTACIÓN
DE SERVICIOS DE APOYO A LA GESTIÓN"* por 9 millones, cuando el mínimo del perfil es 20 M.

**Solución implementada** (`app/ai/rules.py`) — el LLM propone, las reglas disponan:

- exclusión del perfil detectada en el texto → **tope 5**
- presupuesto fuera de `[mín, máx]` → **tope 20**
- modalidad no preferida → **−15**
- territorio no preferido → **−10**
- texto vacío → **0**

Todas las razones quedan guardadas en `rationale`/`bullets`, así que el score es
auditable. Efecto medido: los tops pasaron de 70 a un rango correcto.

### 3.6 Comparación de modelos (medido en esta máquina)

RTX 5060 Ti, 31 GB RAM, 12 CPUs.

| Modelo | Tamaño | Velocidad | Calidad del juicio |
|---|---|---|---|
| `llama3.2` | 1.9 GB | ~2 s/lic | Deficiente: no discrimina, alaba cualquier proceso con la palabra "servicios" |
| `qwen3:14b` | 8.8 GB | ~15 s/lic | **Correcto**: detecta presupuesto fuera de rango, skills no cubiertas, objetos no-tech |

Ejemplo real del mismo proceso con `qwen3:14b`:
> *"El objeto del contrato se enfoca en gestion administrativa y movilidad urbana,
> no en desarrollo de software o ciberseguridad"* — score 26.

**Default en `.env`: `qwen3:14b`.** Alternativa rápida documentada: `llama3.2`.

### 3.7 Ciclo autónomo + el tope de 65.535 parámetros (la parte en construcción)

Al final de la mañana del 26/09 el cron de las 03:15 dejó de ser suficiente: con el
servidor encendido, el panel quedaba viejo hasta el día siguiente. Se reconstruyó
`scheduler.py` con **tres disparadores** que alimentan el mismo `run_sync`:

| Job | Disparador | Ventana | Para qué |
|---|---|---|---|
| `sync_periodico` | cada `SYNC_INTERVAL_MINUTES` (30) | `SYNC_LOOKBACK_FREQUENT_DAYS` (1 d) | mantiene el panel al día con el servidor encendido |
| `sync_diario` | cron `03:15` America/Bogota | `SYNC_LOOKBACK_DAYS` (3 d) | recupera días perdidos |
| `sync_arranque` | 20 s después del `lifespan` | 3 d | catch-up, **solo si** lo último sincronizado es más viejo de `SYNC_STARTUP_IF_STALE_MINUTES` (90) |

El ciclo frecuente usa ventana de 1 día a propósito: con 3 días son ~8.000 filas y
no tiene sentido releerlas cada media hora.

**Lock anti-solapamiento.** `runner.py` tiene un `threading.Lock` de módulo. Con
tres disparadores más el botón manual del panel, el cron y el botón podían hacer
`upsert` sobre las mismas filas y puntuar los mismos pendientes a la vez
(bloqueos + trabajo duplicado). Ahora `run_sync` **no se solapa**: si el lock está
tomado devuelve `en_curso=True` y el llamador sigue al primero. `sync_en_curso()`
lo consulta el planificador y el endpoint de estado.

**El bug que destapó el ciclo autónomo (bug #7).** Con el límite del CLI
(`--limite 100`) el problema no existía: 100 filas × 29 columnas = 2.900
parámetros. El ciclo automático descarga la ventana **completa**, y una ventana de
un solo día (~2.700 procesos) ya da 78.300 parámetros. PostgreSQL acepta como
máximo **65.535 parámetros bind por sentencia** (`protocolo`, no configurable), así
que el `INSERT ... VALUES` reventaba:

```
(psycopg.OperationalError) sending query and params failed:
number of parameters must be between 0 and 65535
```

Falló **2 veces seguidas** en el log de `sync_runs` (13:38 y 14:58 UTC), y la
segunda vez peor: el catch-up de 30 días lleva la ventana a ~80.000 filas.

**Solución** (`app/ingest/upsert.py`, nuevo): `bulk_upsert()` trocea el payload en
lotes de `65535 // n_columnas` filas y hace un `INSERT ... ON CONFLICT DO UPDATE`
por lote. El `WHERE key IN (...)` de "¿cuáles ya existen?" sufre el mismo tope,
así que también va troceado. Con 31 columnas quedan **2.114 filas por lote**: una
ventana de 30 días son 38 lotes.

Verificado a mano después del reinicio del PC (la última sync del log seguía
fallada, así que el fix no se había probado en la BD real):

```
params que se intentarian de una vez: 155000        <- reventaba
1a pasada  -> nuevas=5000 actualizadas=0            <- 3 lotes, OK
2a pasada  -> nuevas=0 actualizadas=5000            <- idempotente
limpieza ok, quedan: 100
```

### 3.8 El barrido: por qué `score.py --todo` no puede existir

Después del incidente de §5.6, `matches` quedó a cero con 336.659 procesos en
la base, y la tarea pendiente #1 era "repuntar los scores". El script que
existía para eso no servía, y no por falta de ganas:

`score.py --todo` llama a `run_scoring(rescore_all=True)`, que entra por
`_score_all()`. Ese modo **no hace embeddings**: pone `similarity=0.0` a todos
los pendientes y llama al LLM uno por uno. Con el tiempo medido hoy en esta
máquina:

| Operación | Tiempo medido | Sobre 339.608 filas |
|---|---|---|
| `qwen3:14b`, una llamada de chat | **28,5 s** | **112 días** |
| `nomic-embed-text`, lote de 128-256 textos | **~125-140/s** | **~45 min** |

La diferencia es de dos órdenes de magnitud, y por eso la arquitectura de §3.4
no es un refinamiento: es lo que separa un proyecto usable de uno que no
termina nunca.

De ahí `backend/scripts/barrido_scores.py`, que reparte el trabajo en fases que
se pueden parar y seguir:

| Fase | Qué hace | Qué usa | Reanudable por |
|---|---|---|---|
| `barrido` | Etapa 1 sobre **todas** las pendientes | solo embeddings | las que no tienen fila en `matches` |
| `refinar` | Etapa 2 sobre las mejor posicionadas | LLM | las que siguen marcadas `vectorial` |
| `rehacer` | Recalcula el score de las `vectorial` | **nada**: el vector ya está en la columna `embedding` | las `vectorial` que aún no ha pasado |

`rehacer` existe por el bug #14 (§5.7): cuando cambia una regla no hace falta
reembeber, porque ni el vector ni la similitud han cambiado. Es CPU y disco, sin
Ollama, y por eso va de ~19/s a ~100/s según el lote.

**La fase `barrido` reutiliza `embed_profile()` tal cual**, con `use_llm=False` y
el pool entero en vez de 40. No se reimplementó la lógica de puntuación: si el
ciclo diario y el barrido guardaran el score de otra manera, la base tendría dos
verdades, que es exactamente el problema que salió en §5.5 con el esquema.

### 3.8.1 La GPU no da para los dos modelos a la vez

`nomic-embed-text` (274 MB) y `qwen3:14b` (8,8 GB) conviven con `keep_alive=15m`,
pero al cargar el LLM mientras se embebe, el sidecar del tokenizer de Ollama
murió y devolvió:

```
400 {"error":"Post \"http://127.0.0.1:57602/tokenize\": dial tcp ...: connection refused"}
```

`connection refused` hacia **su propio puerto interno**, no hacia el nuestro: no
es que Ollama no contestara, es que el proceso que tokeniza se cayó. Y como
`embed()` no reintentaba, el error se llevaba por delante la pasada entera
—el mismo patrón que el bug #7, pero aquí la víctima es la llamada, no la
sentencia SQL. Es el bug #13.

### 3.8.2 Por qué el proyecto se come la VRAM

Diagnóstico hecho el 27/09 a raíz de "el proyecto me está comiendo la tarjeta".
**No es la aplicación: es Ollama reteniendo memoria a propósito, y son tres
causas sumables.** Medido en esta máquina (RTX 5060 Ti, 16 GB):

| Qué ocupa | Cuánto | De dónde sale |
|---|---|---|
| Pesos de `qwen3:14b` | **8,8 GB** | `OLLAMA_LLM` en `.env` |
| Pesos de `nomic-embed-text` | **274 MB** | `OLLAMA_EMBED_MODEL` |
| Caché KV del 14b con `num_ctx=4096` | el resto hasta rozar 10 GB | `OLLAMA_NUM_CTX` |

1. **`keep_alive=15m` viaja en cada petición** (`backend/app/config.py:48`), tanto
   en embeddings (`app/ai/ollama_client.py:143`) como en chat (`:201`). Le dice a
   Ollama que no baje el modelo de la VRAM, y lo mantiene **15 minutos después de
   la última llamada**. Por eso el consumo se ve aunque el proyecto esté parado:
   no es trabajo pendiente, es memoria retenida. Un `ollama serve` que no ha
   recibido nunca una petición no ocupa casi nada; el que ha servido una, sí.
2. **El barrido mantiene la GPU encendida, no reservada.** La fase `barrido`
   mete ~125-140 textos/s por el modelo de embeddings de forma ininterrumpida, y
   la fase `refinar` encadena llamadas de chat de **28,5 s** cada una (§3.8). Con
   los dos modelos cargados a la vez, el pico es la tabla completa.
3. **Los dos modelos no caben.** Con el 14b cargado mientras se embebe, el
   sidecar del tokenizer de Ollama se cae (§3.8.1). No es un problema de red ni
   de código nuestro: es que la VRAM no da para ambos.

Lo que **no** toca la VRAM: PostgreSQL, la API de FastAPI, el frontend de Vite y
el resto del barrido. En concreto `barrido_scores.py --fase rehacer` es CPU y
disco puros (§3.8) y se puede correr con todo lo demás apagado.

Cómo se comprueba sin hacer nada:

```powershell
nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv
# con Ollama parado y el proyecto sin usar -> name: NVIDIA GeForce RTX 5060 Ti,
# memory.used: 4756 MiB, memory.total: 16311 MiB, utilization.gpu: 11 %
```

Y para soltar lo retenido sin reiniciar ni bajar nada:

```powershell
ollama stop qwen3:14b
ollama stop nomic-embed-text
```

Los tres puntos de control, para saber dónde se toca: `keep_alive` (cuánto
tiempo aguanta el modelo cargado), **`OLLAMA_LLM_LIBRARY`** (si Ollama puede usar
la GPU o se queda en RAM) y qué modelos se pide. El primero lo pone el cliente en
cada llamada; el segundo lo lee Ollama **al arrancar el servidor**, no por
petición — por eso cambiarlo en `.env` no sirve y hay que reiniciar `ollama serve`.

> **CUIDADO con `OLLAMA_NUM_GPU=0`, que es el consejo que se encuentra en
> internet y aquí no funciona.** En Ollama 0.33.3 esa variable **ya no existe**:
> no sale en `ollama serve --help` ni aparece en el `server config` que el propio
> servidor imprime al arrancar, y ponerla no evita nada — el modelo se offloadea
> a CUDA igual, confirmado en el log (`offloaded 13/13 layers to GPU`) y en
> `ollama ps` (`PROCESSOR = 100% GPU`). Lo que sí funciona es
> `OLLAMA_LLM_LIBRARY=cpu`, que hace que la autodetección **no encuentre ninguna
> GPU** en vez de limitar cuántas capas van. Es la diferencia entre "apagas la
> GPU" y "le dices a Ollama que no la use".

### 3.8.3 La solución: 0 VRAM, con la IA todavía disponible

Cambio del 28/09, a petición del usuario ("quiero que Ollama no corra dentro de
mi PC"). Tres capas, porque las dos primeras se pueden eludir:

| Capa | Qué hace | Reversible |
|---|---|---|
| **No arrancar** | `start.ps1` ya no lanza `ollama serve`; hace falta `-ConOllama` | siempre |
| **Si arranca, en CPU** | `OLLAMA_LLM_LIBRARY=cpu` en el hijo de `Start-Process`, y también como variable de entorno de usuario de Windows | siempre |
| **No auto-arrancar con Windows** | el acceso directo `Ollama.lnk` de la carpeta Inicio pasó a `Ollama.lnk.desactivado` | renombrando el fichero |

La variable de usuario cubre el caso de que la bandeja de Ollama
(`ollama app.exe`) se abra a mano: al no detectar GPU, ese Ollama tampoco la
usa. Es **la única capa que protege de verdad**, porque las otras dos solo
gobiernan lo que hace este proyecto.

Y un cuarto arreglo, que resultó ser medio del problema: **`stop.ps1` no
descargaba los modelos.** `ollama.exe` es solo el servidor; cada modelo cargado
corre en su propio `llama-server.exe`, y esos hijos se quedan de pie como
huérfanos, con los pesos todavía en memoria. Medido:

```
.\stop.ps1          ->  4 procesos llama-server vivos, 6.744 MiB en la tarjeta
despues de matarlos ->  0 procesos,                     4.106 MiB
```

O sea que "ya lo apagué y me sigue ocupando la GPU" era verdad, y no era
impresión. `stop.ps1` ahora los mata siempre, antes que al padre, y no espera a
`-Forzar`: `llama-server.exe` solo existe bajo Ollama, así que no hay riesgo de
llevarse un proceso ajeno.

**Cómo queda la plataforma con Ollama apagado:** entra data nueva de SECOP II
igual, los **339.648 scores ya calculados se siguen viendo** tal cual, y lo
único que no corre es *puntuar lo nuevo*. Tres cosas hubo que arreglar para que
eso fuera verdad y no un fallo silencioso:

1. `run_sync` marcaba el ciclo entero como **fallido** porque el matchmaker no
   tenía IA. Con la base llena de falsos errores cada 30 minutos, la alerta de
   `sync_runs` deja de significar nada. Ahora, si lo único que falla es la
   ausencia de Ollama, el reporte sale `ok: true` con `scoring.omitido: true`
   (§5.7, bug #16).
2. `/api/salud` se quedaba en **"degradado" para siempre**, que es un aviso
   permanente que nadie lee. Con `OLLAMA_REQUIRED=false` (nuevo) la IA apagada
   sale como `"apagada (opcional)"` y el estado sigue siendo `ok`. Con
   `OLLAMA_REQUIRED=true` se comporta como antes.
3. `OLLAMA_LLM` bajó de `qwen3:14b` a **`llama3.2`**: el 14b son 8,8 GB y, sin
   GPU, son varios minutos por licitación. En CPU el `llama3.2` contesta en
   **4,7-5,8 s** (§3.8 medía 28,5 s para el 14b *con* GPU), así que la IA en
   CPU es perfectamente usable. El 14b se recupera cambiando la variable.

**Verificado de punta a punta el 28/09** (por eso el apartado se puede
comprobar, no solo leer):

| Comprobación | Resultado |
|---|---|
| `.\start.ps1` (sin flag) | Ollama no arranca, puerto 11434 libre, `estado: ok` |
| `POST /api/sync` con IA apagada | `ok: true`, 5 procesos leídos, `scoring.omitido: true` |
| `.\start.ps1 -ConOllama` | `ollama ps` → **`100% CPU`** en los dos modelos |
| Log de Ollama | `inference compute id=cpu library=cpu` y `CPU model buffer size` (nada de `CUDA0`) |
| VRAM con los dos modelos cargados | **4.419 → 4.475 MiB** (ruido del escritorio; sin salto de 2,6 GB) |
| `.\stop.ps1` | 0 `ollama`, 0 `llama-server`, 0 `postgres`, 0 en la GPU |

Como comprobarlo en cualquier momento, sin confiar en este documento:

```powershell
ollama ps                    # la columna PROCESSOR tiene que decir 100% CPU
nvidia-smi --query-gpu=memory.used --format=csv,noheader
Get-Process ollama, 'llama-server' -ErrorAction SilentlyContinue
```

---

## 4. Lo que YA ESTÁ HECHO (verificado)

### 4.1 Infraestructura — funcionando

| Componente | Estado verificado |
|---|---|
| Python 3.12.10 | Instalado (venv en `.venv`) |
| PostgreSQL 16.2 | **Corriendo en 127.0.0.1:5432**, base `licitaciones` |
| pgvector 0.6.2 | Extensión creada, distancia coseno probada |
| Ollama 0.33.3 | Servidor en :11434 |
| Modelos | `qwen3:14b`, `llama3.2`, `nomic-embed-text`, `qwen3-coder`, `devstral-small-2` |

### 4.2 Ingesta — funcionando contra la API real

Descargas verificadas con datos verdaderos de `datos.gov.co`:

```
procesos -> leidas=100  nuevas=100  actualizadas=0
contratos -> leidas=60  nuevas=60  actualizadas=0  huerfanas=60
```

Conteos confirmados por la API oficial: **18 794 procesos** publicados en 7 días,
**4 480 contratos** firmados en 7 días.

> Las 60 "huérfanas" son contratos cuyo `proceso_de_compra` aún no se había
> descargado (los contratos apuntan a procesos más antiguos). La FK los anula a
> `NULL` en vez de romper la carga — comportamiento correcto.

### 4.3 IA local — funcionando

- 100 procesos embebidos con `nomic-embed-text` (768 dims)
- Perfil de empresa embebido y cacheado
- 40 licitaciones puntuadas por `qwen3:14b` con JSON válido
- 3 viñetas en español + rationale + keywords + gaps por oportunidad
- Score final = mezcla vectorial + LLM, acotado 0-100

### 4.4 API — endpoints probados

**Funcionan (verificados con respuesta real):**

| Endpoint | Resultado |
|---|---|
| `GET /api/salud` | `ok` — BD ok, Ollama ok, datasets correctos |
| `GET /api/estadisticas` | 100 tenders, 60 contratos, 40 puntuados, score medio 19.6 |
| `GET /api/licitaciones` | `total=40`, devuelve tarjetas con score y viñetas |
| `GET /api/licitaciones?score_min=25` | filtro por score — OK |
| `GET /api/licitaciones?q=software` | búsqueda texto libre — OK |
| `GET /api/licitaciones?departamentos=Distrito Capital de Bogotá` | filtro territorio — OK |
| `GET /api/licitaciones?precio_min=50000000` | filtro presupuesto — OK |
| `GET /api/licitaciones?order_by=fecha` | orden alternativo — OK |
| `GET /api/licitaciones?solo_por_vencer=true&dias_por_vencer=7` | por vencer — OK |
| `GET /api/licitaciones?solo_guardadas=true` | consulta — OK |
| `GET /api/licitaciones/{id}` | detalle + OCDS — OK |
| `GET /api/licitaciones/similares/{id}` | similares por coseno — OK (ahora es `GET`) |
| `GET /api/licitaciones/facetas` | **nuevo** — valores distintos con conteo — OK |
| `POST /api/licitaciones/{id}/accion` | **corregido** — idempotente, verificado con 3 clics |
| `GET /api/contratos` | listado — OK |
| `GET /api/contratos/estadisticas` | agregaciones — OK |
| `GET /api/perfil` | perfil de empresa — OK |
| `GET /api/scheduler` | estado del cron — OK |
| `POST /api/sync/background` | **nuevo** — lanza el ciclo sin bloquear, `202` — código verificado, **sin probar en vivo** |
| `GET /api/sync/estado` | **nuevo** — `en_curso`, último, próximo, jobs — código verificado, **sin probar en vivo** |
| `GET /api/sync/historial` | trazas — OK |
| `GET /api/top` | ranking — OK |

**Mapeo OCDS verificado** en el detalle:
```
ocds.id      = CO1.REQ.11094154
ocds.status  = active
ocds.method  = direct
ocds.value   = 35909516.0 COP
ocds.org     = FONDO FINANCIERO DISTRITAL DE SALUD..
items.cls    = UNSPSC/UNSPECIFIED
```

### 4.5 Scripts CLI — funcionando

```powershell
# Base de datos + esquema + perfil
python backend\scripts\bootstrap.py --perfil

# Extraer (probado con ventana de 7 días)
python backend\scripts\extract.py --dataset procesos  --dias 7 --limite 100
python backend\scripts\extract.py --dataset contratos --dias 7 --limite 60

# Puntuar con IA local
python backend\scripts\score.py --pool 12 --top 6
python backend\scripts\score.py --todo          # repuntuar todo
python backend\scripts\score.py --sin-llm       # solo embeddings, rápido

# PostgreSQL
python backend\scripts\pg_manager.py start|stop|status

# Refrescar los fixtures de los tests con datos reales
python backend\scripts\capture_fixtures.py
```

### 4.6 Frontend — verificado

```powershell
cd F:\Proyectos\Licitaciones\frontend
npm install
npm run dev      # http://127.0.0.1:5173  (proxy /api -> :8000)
npm run build    # dist/  160 kB js + 8 kB css
npm test         # 7 tests, todos verdes
npm audit        # 0 vulnerabilidades
```

**Tests automatizados (7, todos en verde)** contra payloads reales capturados de
la API en `src/test/fixtures.json`:

| Test | Qué cubre |
|---|---|
| tarjeta por oportunidad | render de score, las 3 viñetas y presupuesto de cada item |
| encabezado | chip de estado BD/IA y score medio |
| query params | el slider de score y el debounce de búsqueda llegan a la API |
| filtro por departamento | marca una faceta y la manda como `departamentos` |
| acción guardar | hace `POST .../accion` contra el id correcto |
| detalle | abre el modal, las 4 pestañas con nombre, JSON OCDS y similares |
| error de API | muestra el `detail` del backend sin romperse |

---

## 5. Bugs conocidos — TODOS CORREGIDOS

Los 4 bugs de la revisión anterior están arreglados y verificados.

| # | Severidad | Endpoint | Causa raíz | Solución |
|---|---|---|---|---|
| 1 | **Media** | `POST /api/licitaciones/{id}/accion` | **No era idempotente.** `tender_actions` tiene `UNIQUE (tender_id, accion)`, así que el segundo clic repetía el `INSERT` y reventaba con `IntegrityError` → HTTP 500 y transacción revertida. Por eso la acción "no se persistía" | `INSERT ... ON CONFLICT (tender_id, accion) DO UPDATE` en vez de `add()` + `commit()`. Verificado: 3 clics seguidos → 1 fila, `solo_guardadas` lo ve |
| 2 | **Baja** | `/api/licitaciones/similares/{id}` | Declarado `@router.post` siendo una lectura | Cambiado a `@router.get`. Verificado con respuesta real |
| 3 | **Baja** | `GET /api/licitaciones/{id}` | En Socrata el campo `urlproceso` es de tipo `url`, no texto: llega como `{"url": "..."}` y `str()` guardaba la **repr del dict** (`"{'url': 'https://...'}"`) en la BD | `socrata_text()` aplana dicts; nuevo `socrata_url()` además repara filas ya corruptas. 160 filas Saneadas con `UPDATE`. Verificado con ingesta real: ahora se guarda `https://community.secop.gov.co/...` |
| 4 | **Baja** | Codificación | Mojibake de la consola PowerShell, no de los datos | Confirmado: es solo la consola. PostgreSQL es UTF-8 y el navegador renderiza bien |

### 5.1 Bugs que aparecieron al construir el frontend

Los tests del frontend los detectaron; no se habrían visto sin ejecutarlos:

| # | Dónde | Problema | Solución |
|---|---|---|---|
| 5 | `Oportunidades.jsx` | El estado `detalle` guardaba el **id** de la ficha, pero el render leía `detalle.licitacion.id_del_proceso` → **crash al pulsar "Ver detalle"** | `detalle` es el id; el modal pide su propio detalle y un contador `detalleVersion` lo refresca al aplicar una acción |
| 6 | `Detalle.jsx` | Las pestañas se armaban con `Object.keys(children)`, que sobre hijos estáticos de JSX devuelve `['0','1','2','3']` → las pestañas se veían numeradas | `Pestanas` recibe un array de `{clave, etiqueta, contenido}` |

### 5.2 Bug #7 — el que rompió el ciclo autónomo (corregido y verificado)

Apareció al encender el ciclo automático, y por eso no lo detectó nadie antes:
los límites del CLI (`--limite 100`) lo escondían.

| # | Severidad | Dónde | Causa raíz | Solución |
|---|---|---|---|---|
| 7 | **Alta** | Ingesta completa (procesos y contratos) | `INSERT ... VALUES (...),(...)` con N filas × C columnas usa **N×C** parámetros bind, y PostgreSQL acepta máximo **65.535 por sentencia**. Con el ciclo automático (que descarga la ventana completa, sin `--limite`) una ventana de 1 día ya son ~2.700 × 29 = **78.300** → `OperationalError`, 0 filas guardadas. Agravado por el catch-up de 30 días (~80.000 filas) | `app/ingest/upsert.py` con `bulk_upsert()`: trocea en lotes de `65535 // columnas` y va haciendo `ON CONFLICT DO UPDATE` lote a lote. El `IN (...)` de "¿ya existe?" también troceado. Verificado en BD real: 5.000 filas (155.000 parámetros) → OK e idempotente |

**Detalle importante para el futuro:** este error **no se pierde en los logs, se
traga la ingesta entera**. `run_sync` capturaba la excepción por dataset y seguía
adelante, así que el ciclo "terminaba bien" desde fuera mientras la BD se quedaba
con 100 filas de siempre. Cualquier fallo de ingesta hay que leerlo en
`sync_runs.status`, no en el log de consola.

### 5.3 Bugs #8 a #10 — los que aparecieron al correr la ingesta de verdad

Con el bug #7 arreglado por fin corrieron las ingesta completas, y las tres
fallaron. Ninguno se habría visto con `--limite 100`: los tres necesitan la
ventana ancha.

| # | Severidad | Síntoma | Causa raíz | Solución |
|---|---|---|---|---|
| 8 | **Alta** | `ON CONFLICT DO UPDATE command cannot affect row a second time` (`psycopg.errors.CardinalityViolation`) | El dataset de procesos publica el **mismo `id_del_proceso` varias veces**: 144.341 filas son solo 118.817 distintas. `ON CONFLICT` no puede tocar dos veces la misma fila en una sentencia | `_dedup()` en `upsert.py` deja una fila por clave natural **antes** de trocear. Medido: las repetidas son copias exactas, así que hoy da igual cuál se elija; se conserva la primera por si SECOP empieza a publicar revisiones reales (ver §9) |
| 9 | **Alta** | `value too long for type character varying(160)` (`StringDataRightTruncation`) | Hay **181 filas** del dataset de contratos que meten el objeto entero del contrato en `referencia_del_contrato` ("PRESTAR APOYO TECNICO PARA LA RECOPILACIÓN, DEPURACIÓN Y ACTUALIZACIÓN DEL APLICATIVO..."), llegando a 200+ caracteres. La columna se había declarado `String(160)` | Tres cosas: (a) la columna pasa a `String(600)`; (b) `socrata.fit_to_model()` **recorta** lo que no cabe y avisa por log, para que un dato raro no tumbe las ~75.000 filas del lote; (c) el recorte se aplica en `bulk_upsert()`, no solo en el parser, que es donde la BD impone el límite |
| 10 | **Alta** | El enlace contrato → proceso funcionaba **0% de las veces**: 75.434 contratos, 75.434 huérfanos, con 121.185 procesos ya cargados | `attach_known_tenders()` cruzaba `contracts.proceso_de_compra` contra `tenders.id_del_proceso`, pero **son espacios de identificadores distintos**: en contratos SECOP publica `CO1.PCCNTR.*` (o incluso `CO1.BDOS.*`) y en procesos `CO1.REQ.*`. Nunca pueden coincidir | La única clave que comparten es el `noticeUID=CO1.NTC.*` que va dentro de la URL de `OpportunityDetail`. Se añadió `notice_uid` a `tenders` y `contracts`, `socrata.notice_uid()` lo extrae, y el enlace se resuelve por ahí. **Verificado: 55.614 de 75.434 contratos enlazados (73,7%)** |

El bug #10 es el más relevante de los tres: no daba ningún error, la ingesta
decía `huerfanas=75434` y nadie miró ese número. La pestaña de contratos llevaba
meses mostrando cero relaciones.

#### Lo que faltaba para cerrar cada bug

`create_all` **no altera tablas que ya existen**: cambiar un `String(n)` a 600 o
añadir una columna no llegaba a una base de datos viva. Por eso el bug #9 seguía
matando la ingesta después de arreglar el modelo, y el bug #10 dejó una
restricción `contracts_proceso_de_compra_fkey` obsoleta que hacía fallar la
reingesta con `ForeignKeyViolation`.

Como en aquel momento no había Alembic, `app/db.py` puso una migración mínima e
idempotente que cubría los tres casos, y `tests/test_migracion.py` la fija:

| Función | Qué hace |
|---|---|
| `_add_missing_columns()` | `ALTER TABLE ... ADD COLUMN` de lo que el modelo declara y la BD no tiene |
| `_add_missing_foreign_keys()` | Crea las FK declaradas que falten |
| `_drop_stale_foreign_keys()` | Quita las FK que el modelo ya no declara |
| `_widen_narrow_columns()` | Ensancha `varchar` estrechas. **Nunca estrecha**: hacerlo perdería datos ya escritos |
| `_add_missing_indexes()` | Crea los índices que falten. **Añadida en la 3ª pasada** (§5.5) |

**Ojo con `_drop_stale_foreign_keys()`:** la comparación tiene que hacerse contra
la **tabla** referenciada, no contra `fk.target_fullname` (que es
`tenders.id_del_proceso`, la columna). Con la comparación equivocada creyó que
`matches.tender_id` y `tender_actions.tender_id` eran obsoletas y **las borró de
la base de verdad**; se recuperaron con `_add_missing_foreign_keys()`. Hay un test
parametrizado que fija exactamente este caso.

Estas cinco funciones **siguen en el código**, pero ya no son el camino normal:
son la red de seguridad para bases que no vienen de las migraciones (§5.5). Para
cambiar el esquema hoy se escribe una migración.

---

### 5.4 Bugs #11 y #12 — los que aparecieron al añadir Alembic

Ninguno de los dos es de la base de datos, y los dos se habrían enviado a
producción sin enterarse.

#### Bug #11 — `stop.ps1` no parseaba: el script de parada nunca funcionó

| # | Severidad | Síntoma | Causa raíz | Solución |
|---|---|---|---|---|
| 11 | **Media** | `.\stop.ps1` moría con `ParserError` en 3 sitios y no paraba nada | En PowerShell, `"$nombre: sin pid guardado"` se lee como el nombre de una variable **con calificador de unidad** (`nombre:`), que no es una referencia válida. El script entero no llegaba a compilar | `${nombre}:` y `${que}:` en los 3 mensajes. Verificado con el parser de PowerShell: `stop.ps1 parsea bien`, y `.\stop.ps1` ya cierra web, api y ollama |

Se escribió el script, se probó `start.ps1` (que sí funciona) y se dio por
bueno. `stop.ps1` no se había ejecutado nunca, así que el error era invisible:
no hay forma de que se note un script que no has ejecutado.

**Lección:** un `.ps1` no está probado hasta que se ejecuta. Ahora hay un
`ParserError` de comprobación en la §7 que lo parsea sin lanzar nada.

#### Bug #12 — correr migraciones apagaba el logging de la aplicación entera

| # | Severidad | Síntoma | Causa raíz | Solución |
|---|---|---|---|---|
| 12 | **Alta** | Tras el primer arranque con `init_schema()`, la API no registraba **nada** en todo el proceso | `alembic/env.py` llama a `fileConfig()`, que **reconfigura los handlers del logger raíz** y, con su valor por defecto (`disable_existing_loggers=True`), además apaga los loggers existentes. Como `init_schema()` corre migraciones en cada arranque, el primer arranque dejaba la app muda | Dos cosas: (a) `disable_existing_loggers=False`; (b) sobre todo, `alembic/env.py` solo configura logs si `config.attributes["configure_logger"]` es True, y `app/db.py` lo pone a False porque la app ya tiene su logging. Desde la CLI (`alembic upgrade head`) sí se configura. Cubierto por `test_correr_migraciones_no_apaga_los_logs` |

Sin el punto (b) el arreglo era incompleto: `fileConfig` quita y vuelve a poner
los handlers de la raíz, así que aunque no apagara los loggers, se llevaba por
delante la configuración de la app y la captura de pytest. Lo detectó el test, no
la ejecución: `caplog` se quedó sin ver un `WARNING` que el test acababa de
emitir.

---

### 5.5 Alembic conectado (3ª pasada) — y lo que destapó

Era el punto 1 de la hoja de ruta desde la revisión anterior. Está hecho.

### Qué hay ahora

```
backend/alembic.ini              sin `sqlalchemy.url`: la URL sale de app.config
backend/alembic/env.py           target_metadata = Base.metadata, filtro, URL
backend/alembic/versions/
    0001_esquema_inicial.py      las 6 tablas + 27 índices + CREATE EXTENSION vector
```

| Pieza | Decisión |
|---|---|
| La URL de las migraciones | La pone `app/db.py` desde `settings.database_url`. **No** vive en `alembic.ini`, para que la migración y la app no puedan apuntar a bases distintas. `alembic/env.py` acepta `ALEMBIC_DATABASE_URL` solo desde la CLI |
| La migración inicial | **Autogenerada contra una base vacía**, no escrita a mano: el DDL sale de `models.py` y no puede desviarse. A mano solo se le añadió el `CREATE EXTENSION IF NOT EXISTS vector`, que autogenerate no sabe emitir |
| `sqlalchemy.url` vacía en el `.ini` | A propósito. Si estuviera puesta, la CLI migraría una base y la app serviría otra |
| `include_object` | Vive en `app/db.py`, no en `env.py`, para que los tests usen **el mismo** filtro que la comparación real |
| Rutas de `script_location` | Absolutas: `init_schema()` se llama desde uvicorn, cuya raíz no es `backend/` |

### `init_schema()` cambió de significado

Antes era "crea lo que falte y reconcilia con el modelo". Ahora:

```python
if _base_heredada():          # hay tablas del modelo pero no hay alembic_version
    reconciliar(); stamp("head")   # la base ya existía: se sella, no se migra
else:
    upgrade_head()            # base vacía o ya versionada
```

El camino de la base heredada es **imprescindible**, no una comodidad: la base de
desarrollo tenía 135.000 filas y sus tablas, pero no `alembic_version`. Aplicar
`0001` encima revienta con `relation "company_profile" already exists`. Se
sella en `head` (que es la verdad: las tablas ya estaban como el modelo pedía) y
se verificó que los datos no se mueven.

### Lo que destapó `alembic check`: 3 índices que no existían

La razón de peso de este trabajo no fue tener Alembic, fue lo que encontró en la
base de verdad. `alembic check` compara el modelo con la base real y devolvió:

```
Detected added index 'ix_contracts_notice_uid' on '(notice_uid,)'
Detected added index 'ix_contracts_proceso_id' on '(proceso_id,)'
Detected added index 'ix_tenders_notice_uid' on '(notice_uid,)'
Detected type change from VARCHAR(length=80) to String(length=40) on 'contracts.proceso_de_compra'
```

**Esos tres índices son la clave del bug #10.** Al arreglar el enlace
contrato ↔ proceso se añadieron las columnas `notice_uid` y `proceso_id` al
modelo, pero `create_all` no crea índices en tablas que ya existen y la
migración implícita **solo miraba columnas**. Así que las columnas llegaron a la
base de 135.000 filas y sus índices nunca: el enlace se estaba resolviendo con
un **seq scan sobre 75.434 × 135.600 en cada pasada**, desde el día que se
arregló. No daba error, no salía en ningún log, y `huerfanas=75434` no lo
decía porque el enlace **sí** funcionaba: funcionaba a fuerza de CPU.

Lo mismo pasó con `contracts.proceso_de_compra` en `varchar(80)` cuando el
modelo dice 40: los 80 eran residuo de cuando la columna era FK a
`tenders.id_del_proceso` (que es `String(80)`), y la migración implícita **nunca
estrecha** a propósito. Antes de tocarlo se midió: `max(length())` = 17
(`CO1.PCCNTR.*` / `CO1.BDOS.*`), 0 nulos.

| Qué | Cómo se corrigió |
|---|---|
| Los 3 índices | `_add_missing_indexes()` en la ruta de base heredada (una base nueva los tiene todos desde `0001`), más `backend/scripts/alinear_esquema.py` para la base ya sellada |
| El `varchar(80)` | A mano y con medición previa, en `alinear_esquema.py`, que **se niega a estrechar** si algún valor no cabe. Estrechar es justo lo que `_widen_narrow_columns()` no automatiza, porque perder datos escritos no se perdona |

`alembic check` sobre la base de desarrollo **ahora sale limpio**, y
`test_la_migracion_reproduce_el_esquema_del_modelo` lo vigila en cada corrida de
la suite: si `models.py` cambia sin migración, ese test falla.

### Tests de Alembic (16 nuevos)

`tests/test_alembic.py` fija lo que no puede volver a romperse en silencio:

- la migración inicial produce **exactamente** el esquema de `models.py`
- `upgrade` es idempotente; `downgrade base` borra las 6 tablas y **no** la
  extensión `vector`; bajar y subir devuelve el mismo esquema
- la base heredada se reconoce, se sella en `head`, **no** intenta aplicar `0001`
  sobre tablas existentes y no toca los datos
- correr migraciones no apaga los logs (el bug #12)
- las rutas de Alembic no son relativas y la URL sale de `settings`

### El harness de tests que dejó esto detrás

`conftest.py` quedó con **dos fixtures** y nada más:

| Fixture | Ámbito | Qué hace | Cuánto |
|---|---|---|---|
| `postgres` | sesión, autouse | Arranca el cluster, tira y crea `licitaciones_test` con `DROP ... WITH (FORCE)`, corre `init_schema()` una vez | ~5 s, una vez |
| `session` | función | `TRUNCATE` de las 6 tablas, **solo si hay algo que borrar**. Es lo que usa casi todo el proyecto | ~0,1 s si no hay nada |
| `esquema_limpio` | función | Tira las 7 tablas en una transacción y las vuelve a crear con `init_schema()`, **al entrar y al salir** | ~1,9 s por uso |

Cuatro detalles de `esquema_limpio` que no son obvios y que están comentados en el
propio archivo:

- **La conexión va en AUTOCOMMIT.** Los tests que sueltan DDL y luego llaman a
  `init_schema()` (que abre su propia conexión) se colgaban **para siempre**: la
  sesión del test retiene un `ACCESS SHARE` sobre la tabla que acaba de tocar,
  Alembic espera un `ACCESS EXCLUSIVE`, y cada uno espera al otro. El síntoma es
  un cuelgue sin error ni traza, no un fallo.
- **Borra las tablas a mano, no con `Base.metadata.drop_all()`.** Por dos cosas:
  `alembic_version` no está en `Base.metadata` (si se queda, Alembic cree que el
  esquema está al día y no vuelve a crearlo, con lo que el test pasa contra un
  esquema fantasma), y `drop_all` abriría su propia transacción mientras el
  `DROP` de `alembic_version` abriría otra.
- **Recrea también al salir**, para que el fixture barato (`session`) nunca
  herede un esquema deformado. De ahí que la suite pague ~60 reconstrucciones.
- **No hay `TRUNCATE` al final.** Las tablas acaban de crearse: están vacías y no
  hay nada que borrar (ver abajo).

#### La suite iba a 5'30" y ahora va a 2'40" — y no era culpa de Alembic

La primera explicación que parece plausible es la correcta a medias, y por eso
vale la pena escribirla. Se probó la base plantilla con `CREATE DATABASE ...
TEMPLATE`, que es lo que se hace en un disco normal, y aquí fue **peor** (6'30",
porque cada copia fuerza un checkpoint de todo el cluster), así que se descartó.
Pero la suite seguía en 5'30", y la culpa se le endosó a `alembic upgrade head`
(6 tablas + 27 índices), que parece razonable.

**El perfilado dijo otra cosa.** Repartiendo el cronómetro paso a paso:

| Paso | Coste medido |
|---|---|
| `drop_all` de las 6 tablas | 21-33 ms |
| `DROP alembic_version` | 2-3 ms |
| `CREATE EXTENSION IF NOT EXISTS vector` | 1-29 ms |
| `init_schema()` (las migraciones) | 37 ms - 3,4 s |
| `TRUNCATE` de las 6 tablas | **0 ms - 2,8 s** |

Un `TRUNCATE` de tablas **vacías** no puede costar 2,8 s de CPU: no toca ni una
página. Lo que cuesta es el **`COMMIT`**, y en este disco cada transacción que
escribe WAL paga un `fsync` de ~0,5-2 s (`synchronous_commit=on`, `fsync=on`);
una transacción de solo lectura cuesta 1 ms. Ese `fsync` no se sabe a qué
sentencia se atribuye, así que se acababa cronometrando al culpable equivocado:
el DDL de las 6 tablas lo acababa pagando el `TRUNCATE` de detrás, porque el
fsync del WAL ocurre al commit.

Ahí salen las tres cosas que de verdad abrevian la suite, y las tres son **quitar
escrituras que no cambian nada**:

1. **El `TRUNCATE` que seguía a cada `init_schema()` sobra.** Las 6 tablas
   acaban de crearse y están vacías. Eran ~2 s por reconstrucción, 60 veces.
2. **`session` solo escribe si hay algo que borrar.** Con un `SELECT EXISTS` por
   tabla (lectura, gratis) y salir si las 6 están vacías. Los tests se encadenan y
   cada `TRUNCATE` sobre tablas ya limpias pagaba un `fsync` entero para no hacer
   nada: ~46 veces.
3. **Un solo `COMMIT` para tirar las 7 tablas**, en vez de dos.

Ojo con el punto 2: `TRUNCATE ... RESTART IDENTITY` también pone las secuencias a
cero, y el atajo no lo hace. Solo importa si un test inserta filas, las borra a
mano y el siguiente espera recibir `id=1`; ningún test mira el valor de un id
autoincremental (los fixtures traen ids explícitos de Socrata), y queda
`forzar=True` para el que lo necesite.

**Resultado: 5'30" → 2'40"** (155 s, 183 s y 161 s en tres corridas; el disco da
ruido de ±15%). Los 66 tests en verde.

Queda una palanca sin tirar, y es la que falta para bajar de 2'40" a menos de
2': **quitar el teardown de `esquema_limpio`**, que es la mitad de las
reconstrucciones. Sería seguro si el fixture barato verificara el esquema en vez
de asumirlo, pero la verificación barata (contar columnas) tiene un agujero: un
test que renombre una columna deja el recuento igual y el atajo no lo vería. La
verificación de verdad es una reflexión completa del esquema, que es
justamente lo lenta. Con la relación riesgo/beneficio actual no compensa; si
algún día molesta, el sitio es `_vacia_las_tablas()`, que ya lee la base antes
de escribir.



### 5.6 El `TRUNCATE` que vació la base de desarrollo

Hay que contarlo aunque no sea un bug del proyecto: lo fue mío, y cambió el
estado de los datos de §8.

**Qué pasó.** Al medir por qué la suite tardaba, escribí un script de
cronometraje que importaba `app.db` y hacía `TRUNCATE` de las 6 tablas. Ese
engine se construye desde `settings`, y `settings` sale de `.env` → base
`licitaciones`, la de desarrollo. Los tests sí aíslan la base, pero solo porque
`conftest.py` hace `os.environ.setdefault("PG_DATABASE", "licitaciones_test")`
**antes de importar `app.config`**: mi script no importaba `conftest`, así que
truncó la base de verdad. 135.600 procesos y 75.434 contratos a cero. Lo vi en
la siguiente comprobación, cuando la medición devolvió 2 s por
`TRUNCATE` sobre tablas que "estaban vacías".

**Cómo se recupera** (no hay backup: `TRUNCATE` no se deshace con el WAL):

```powershell
cd backend
..\.venv\Scripts\python.exe scripts\bootstrap.py --perfil
..\.venv\Scripts\python.exe scripts\extract.py --dataset procesos --dias 30 --limite 0
..\.venv\Scripts\python.exe scripts\extract.py --dataset contratos --dias 30 --limite 0
```

**Ojo con `--limite 0`:** el valor por defecto de `extract.py --limite` es **100**,
no "sin límite". El primer intento de recuperación cargó 100 filas de cada
dataset y salió "RECUPERACION LISTA" sin haber recuperado nada. Para la ventana
entiera hay que pasar `--limite 0` explícitamente, y el ejemplo del `README.md`
no lo lleva: se corrigio al final de esta misma sesion.

**Resultado.** Recuperado, y de paso ampliado a una ventana de 75 días:

| Tabla | Antes del incidente | Ahora |
|---|---|---|
| `tenders` | 135.600 | **336.659** |
| `contracts` | 75.434 | **235.540** |
| Contratos con proceso enlazado | 55.614 (73,7%) | **178.673 (75,9%)** |
| `company_profile` | 1 | 1 (recreado por `bootstrap --perfil`) |
| `matches` | los que hubiera | **0 — hay que repuntuar** |
| `tender_actions` | los que hubiera | **0** |
| `sync_runs` | historial | **0** |

Lo único que **no** se recupera solo son los **scores de IA**: `matches` está a
cero y hasta que se repuntúe el panel enseña tarjetas sin puntuación y los
filtros por score no filtran nada. Se repunta con el ciclo (`POST
/api/sync/background`, que puntúa los 40 mejores de cada pasada) o con
`score.py`; con `qwen3:14b` son ~15 s por licitación.

**Lo que no habría que repetir.** Cualquier script que escriba en la base tiene
que declarar a cuál escribe, y un `TRUNCATE` no debería ser una línea suelta en
un script de medición. Si algún día esto se repite, el `dry-run` va antes que el
`DELETE`.

---

---

### 5.7 Bugs #13 a #15 — los que aparecieron al llenar `matches` de verdad

Aparecieron al hacer el barrido de §3.8, y ninguno se habría visto con los 40
candidatos del ciclo diario: los tres necesitan una base llena para manifestarse.

| # | Severidad | Síntoma | Causa raíz | Solución |
|---|---|---|---|---|
| 13 | **Alta** | El barrido se paraba en seco con `400 ... connection refused` al tokenizer, y sin dejar rastro útil | `/api/embed` con cientos de textos tumba el tokenizer interno de Ollama (§3.8.1). `embed()` no reintentaba, así que un 400 tiraba la pasada entera | `OllamaClient.embed()` trocea por `EMBED_CHUNK_SIZE` (128) y, si falla, **reduce el lote a la mitad hasta 1**, memorizando el tamaño que sí funcionó para no reintentar el malo en cada lote. 5 tests en `tests/test_ollama_client.py` |
| 14 | **Alta** | Una tarjeta decía *"Presupuesto 1.800.000 COP por debajo del mínimo 20.000.000"* y **puntuaba 77** | Dos cosas juntas. (a) La rama sin LLM de `_score_batch()` usaba `int(sem)` sin llamar a `verdict.aplicar()`: las reglas se aplicaban en la ruta del LLM y **no** en la vectorial. (b) Cuando sí se aplican, `_payload()` mezclaba primero (35% vectorial + 65% veredicto) y topaba después, así que el corte se diluía: presupuesto → 40 en vez de 20, exclusión del perfil → 27 en vez de 0 | (a) La rama vectorial ahora usa `verdict.aplicar(sem)`. (b) `RuleVerdict.max_score` se aplica **después** de mezclar, dentro de `_payload()`. Las penalizaciones (modalidad, territorio) se siguen aplicando antes de mezclar, que es como estaban documentadas. 4 tests en `tests/test_matchmaker.py` |
| 15 | **Media** | El barrido iba a 8,6 filas/s y luego a 19/s | `embed_profile()` usaba `len(_pendientes(session, limit=None))` para el total de pendientes, que solo va al log. Eso **trae las 340.000 filas como objetos ORM** en cada llamada, y `embed_profile` se llama en cada ciclo de 30 minutos | `_contar_pendientes()`: un `COUNT` con el mismo anti-join, sin traer filas. El ritmo del barrido pasó de 19/s a **141/s** |
| 16 | **Media** | Con la IA apagada, cada ciclo de ingesta se guardaba como **fallido** y `/api/salud` se quedaba en "degradado" para siempre | `run_sync` hacía `report.ok = False` con cualquier scoring no-ok, y no distinguía "el matchmaker se cayó" de "no hay IA" (que desde §3.8.3 es el estado por defecto). La alerta de racha de `sync_runs` se llenaba de falsos errores y su propio `estado` se volvía ruido | Si lo único que falla es la ausencia de Ollama, el reporte sale `ok: true` con `scoring.omitido: true`. `/api/salud` con `OLLAMA_REQUIRED=false` dice `"apagada (opcional)"` y sigue en `ok`; con `true` se comporta como antes. 6 tests en `tests/test_ia_opcional.py` |

**El bug #14 es el que más importaba, y no por el score.** Rompe lo que §3.5
prometía —"el LLM propone, las reglas disponan"-. Con el corte diluido, las
reglas dejaban de ser un corte y pasaban a ser un descuento: el 35% vectorial le
hacía caso omiso a una exclusión del perfil. Y hacía que **el score de un
barrido y el de un ciclo con LLM no fueran comparables**, que es justo lo que da
por supuesto la mezcla 35/65. Por eso el tope va al final, y no como
insumo de la mezcla.

Medido sobre la base real, antes de arreglarlo:

| | filas | score medio | máximo |
|---|---|---|---|
| `vectorial` (etapa 1) | 339.337 | **44,3** | 77 |
| `qwen3:14b` (etapa 2) | 311 | **26,6** | 75 |

La etapa 1 es sistemáticamente más generosa. Con el bug #14, buena parte de esa
diferencia no era "el LLM discrimina más", era "las reglas no se estaban
aplicando".

#### Cómo se detectó

Sospechando que el orden por score del panel enterraba las 72 filas refinadas con
LLM, se preguntó a la base en vez de suponerlo, y la respuesta fue que de las
311 filas refinadas, **cero** estaban en el top 10 y solo 1 en el top 50. De
ahí se bajó a `_score_batch()` y se encontró que el veredicto no se aplicaba en
la rama vectorial. Sin esa consulta, el bug se habría descrito como "el LLM
puntúa más bajo" y se habría arreglado bajando el score del LLM, que es lo
contrario de lo que pasaba.

#### El `rehacer` que falta

El arreglo está escrito y verificado, pero solo se ha aplicado a las ~1.000
filas que una primera versión del script —que tenía un bucle infinito (§3.8)—
alcanzó a tocar. Las ~338.000 restantes siguen con el score viejo. Se arregla
con:

```powershell
cd F:\Proyectos\Licitaciones\backend
..\.venv\Scripts\python.exe scripts\barrido_scores.py --fase rehacer --lote 1000
```

Son ~20-30 min y **no llama a Ollama**. Va de mejor a peor similitud, o sea
que las primeras que se corrigen son las que el panel enseña arriba, y la lista
nunca se queda vacía mientras corrige.

---


## 6. Lo que FALTA

### 6.1 Frontend React — CONSTRUIDO ✅

`frontend/` tiene el panel completo, funcionando contra la API real.

**`Oportunidades.jsx`** — tarjetas ordenadas de mayor a menor score con:

- Semáforo de score (verde ≥70, amarillo 40-69, rojo <40)
- Las **3 viñetas** del Matchmaker visibles sin hacer clic, más el `rationale`
- Precio, entidad, modalidad, departamento y fecha de publicación
- Cuenta regresiva para la fecha de apertura (cambia de color a <4 días)
- Botones **guardar** / **ocultar** / **descartar** / **restaurar**
- Paginación de 24 en 24
- Filtros: score mínimo (slider), texto libre, precio máximo, por vencer,
  solo guardadas, y **departamento / modalidad / entidad desde las facetas**
- Modal de detalle con 4 pestañas: Resumen, Análisis IA, Similares y **OCDS**
- Etiquetas de palabras clave coincidentes y brechas detectadas

Detalles de implementación que importan:

- El dev server hace **proxy de `/api` a `127.0.0.1:8000`**, así que no hay CORS
  y el build usa los mismos paths que la API.
- Las respuestas fuera de orden se descartan con un `requestId`, para que una
  petición lenta no pise a una más reciente.
- La búsqueda tiene debounce de 350 ms.
- Vite 8 exige `host: '127.0.0.1'` explícito: por defecto escucha solo en `::1` y en
  Windows `127.0.0.1` no alcanza.

### 6.2 Lo que sigue pendiente en la API

- Paginación por cursor en vez de `offset` (con miles de filas el `offset` se degrada)
- Endpoint de perfil editable desde la UI (el backend ya tiene `PUT /api/perfil`,
  pero la pantalla de perfil no se construyó)

### 6.3 Ciclo autónomo — CORREGIDO Y VERIFICADO ✅

Lo que estaba a medias en la revisión anterior, cerrado:

| Estaba pendiente | Estado |
|---|---|
| Prueba end-to-end del ciclo | **Hecha.** Ingesta real de 30 días de los dos datasets: 144.341 procesos leídos → 118.817 guardados, y 75.434 contratos leídos → 75.434 guardados. 59 y 33 lotes respectivamente. Después se cargó una ventana de 75 días (§5.6) |
| El panel no los usaba | **Hecho.** `EstadoSync.jsx` con botón "Sincronizar ahora", polling a `/api/sync/estado` y recarga de la lista al terminar |
| `.env` desactualizado | **Hecho.** Las 4 variables `SYNC_*` están en `.env` y en `config.py` |
| Volumen real de ingesta | **Medido.** ~4 min por dataset con `request_delay=0.35` y `page_size=500` |
| Alertas | **Hechas.** `failed_streak()` en `runner.py`; `/api/salud` y `/api/sync/estado` devuelven `alerta`; el panel pinta un chip rojo a partir de 3 fallos seguidos y `/api/salud` pasa a `degraded` |

**Una carrera en el polling, encontrada al escribir los tests:** el
`POST /api/sync/background` responde antes de que la tarea en segundo plano
cogue el lock, así que el primer `GET /api/sync/estado` puede devolver
`en_curso: false`. Con el polling condicionado solo a `en_curso`, la interfaz se
quedaba en "Sincronización lanzada" sin enterarse nunca de que el ciclo acababa.
Resuelto con una ventana de gracia de 8 intentos tras cada lanzamiento
(`GRACE_ATTEMPTS`), con su test.

### 6.4 Operación y entrega

| Falta | Detalle |
|---|---|
| `docker-compose.yml` | Lo único de la hoja de ruta original que sigue entero. Para desplegar con Docker real (aquella no se pudo usar: daemon apagado) |
| Recortar la suite | **~4'** por 80 tests, desde 5'30": se quitaron las escrituras que no cambiaban nada y se unieron transacciones (§5.5). Queda el teardown de `esquema_limpio`, la mitad de las reconstrucciones; quitarlo necesita una verificación del esquema que tiene un agujero documentado. Con la app corriendo se va a **~10'** (medido: 230 s vs 589 s), por contención con PostgreSQL |
| Límite de peticiones Socrata | Registrar app en datos.gov.co para `SOCRATA_APP_TOKEN` y elevar el rate limit |

Ya están:

| Entregable | Dónde |
|---|---|
| `README.md` | Instrucciones, comandos, datasets y las trampas conocidas |
| `start.ps1` | Levanta Postgres + Ollama + API + frontend esperando que cada uno responda. PID y logs en `.run\` |
| `stop.ps1` | Apagado limpio; `-Forzar` mata por puerto, `-ConPostgres` para la BD. **Corregido en la 3ª pasada (bug #11)**: hasta entonces no parseaba |
| Tests del backend | **80 tests** (`test_ingesta.py`, `test_alertas.py`, `test_migracion.py`, `test_alembic.py`, `test_matchmaker.py`, `test_ollama_client.py`), contra una BD `licitaciones_test` aislada |
| Migraciones | `alembic/versions/0001_esquema_inicial.py`, con la base de desarrollo sellada en `head` y `alembic check` limpio |

### 6.5 Escalado (cuando el dataset crezca)

El dataset de procesos tiene **más de 1.7M de filas**. Hoy están cargadas
**339.608** (ventana de 75 días); con la de 30 días eran 118.817. Para un
tracker real hace falta:

- Extraer por **bloques de fecha** en vez de una ventana fija
- Backfill progresivo (cada noche, N días más hacia atrás)
- Índice GIN sobre `tsvector` para búsqueda de texto libre a escala
- Usar pgvector en serio (índice HNSW + consulta SQL) en lugar de calcular coseno en Python

Lo último ya tiene un precedente medido: con las 339.608 filas puntuadas, la
búsqueda de candidatos hace un anti-join sobre esa tabla y un orden por
`fecha_publicacion`, y **aún así la etapa 1 completa se hace en 45 minutos**.
A 1,7M serían unas 4 horas por pasada, que es asumible una vez nightly pero no
cada 30 minutos: por eso el ciclo frecuente se queda en 40 candidatos y el
barrido es una operación aparte, no un ciclo del planificador.

---

## 7. Cómo levantar el sistema hoy

```powershell
.\start.ps1
```

Y para parar, `.\stop.ps1`. Son los scripts de la raíz; los comandos largos
siguen funcionando si hace falta levantarlos a mano:

```powershell
# 1. PostgreSQL (si no está corriendo)
F:\Proyectos\Licitaciones\.venv\Scripts\python.exe `
  F:\Proyectos\Licitaciones\backend\scripts\pg_manager.py start

# 2. Ollama (si no está corriendo)
Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" -ArgumentList "serve" -WindowStyle Hidden

# 3. Esquema + perfil (solo la primera vez)
cd F:\Proyectos\Licitaciones\backend
..\.venv\Scripts\python.exe scripts\bootstrap.py --perfil

# 4. API
$env:ENABLE_SCHEDULER="false"   # para pruebas manuales
..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000

# 5. Frontend (en otra terminal)
cd F:\Proyectos\Licitaciones\frontend
npm install
npm run dev
```

| URL | Qué es |
|---|---|
| http://127.0.0.1:5173 | **Panel de oportunidades** |
| http://127.0.0.1:8000/docs | Documentación interactiva de la API |

### Cambiar el esquema (Alembic)

Lo normal es que la app lo haga sola: `init_schema()` corre `alembic upgrade head`
en cada arranque, así que `.\start.ps1` ya migra. Para trabajar sobre el esquema
a mano:

```powershell
cd F:\Proyectos\Licitaciones\backend

# Ver qué falta entre el modelo y la base. Salida limpia = todo en orden.
..\.venv\Scripts\python.exe -m alembic check

# Autogenerar la migración tras editar models.py, y aplicarla
..\.venv\Scripts\python.exe -m alembic revision --autogenerate -m "lo que sea"
..\.venv\Scripts\python.exe -m alembic upgrade head

# Estado
..\.venv\Scripts\python.exe -m alembic current
..\.venv\Scripts\python.exe -m alembic history
```

Dos avisos que ya se Pagaron una vez:

- **Nunca hay que editar `alembic_version` a mano.** Es la tabla que Alembic usa
  para saber hasta dónde va. Borrarla a dedo y volver a correr `upgrade head`
  aplica la migración inicial sobre tablas que ya existen.
- **`alembic revision --autogenerate` compara el modelo con la base conectada.**
  Si apuntas a otra base por error, la migración sale vacía o peor, describe
  cambios que no existen. Pásale la base a propósito con
  `$env:ALEMBIC_DATABASE_URL`.

### El planificador al arrancar

Sin `ENABLE_SCHEDULER=false` el servidor levanta **tres** jobs (ver §3.7):

| Job | Cuándo |
|---|---|
| `sync_arranque` | 20 s después del arranque, **solo si** lo último sincronizado es más viejo de 90 min |
| `sync_periodico` | cada 30 min, ventana de 1 día |
| `sync_diario` | 03:15 America/Bogota, ventana de 3 días |

Para ver qué hay programado sin sincronizar:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/sync/estado | ConvertTo-Json -Depth 5
```

Ojo: el catch-up de arranque **solo mira la última fila de `sync_runs`**. Como
los dos datasets se registran con el mismo `started_at`, un fallo de procesos
cuenta como "recién sincronizado" y puede saltarse el catch-up de contratos.

---

## 8. Resumen

| Área | Progreso |
|---|---|
| Infraestructura (Postgres + pgvector + Ollama) | **100%** |
| Ingesta Socrata con paginación y reintentos | **100%**, validada a escala: 144.341 procesos y 75.434 contratos leídos de verdad en la prueba de 30 días, y 336.659 / 235.540 tras la carga de 75 días (§5.6) |
| Modelos de datos + mapeo OCDS | **100%** |
| Matchmaker con IA local (embeddings + reglas + LLM) | **100%** — y con la base entera puntuada (§3.8) |
| Ciclo autónomo (3 jobs + lock anti-solapamiento) | **100%** — corrido de principio a fin, con botón en el panel y alertas |
| Enlace contratos ↔ procesos | **100%** — corregido el bug #10, 75,9% enlazado |
| Esquema versionado | **100%** — Alembic con migración inicial autogenerada, `alembic check` limpio y base de desarrollo sellada (§5.5) |
| API FastAPI | **~95%** (18 endpoints; falta paginación por cursor) |
| Frontend React | **~95%** (panel, filtros, detalle OCDS, sincronizador, 16 tests — falta la pantalla de perfil) |
| Tests automatizados | **~85%** — 80 backend (PostgreSQL real aislado) + 16 frontend |
| Documentación de operación | **~90%** — `README.md`, `start.ps1`, `stop.ps1`; falta `docker-compose.yml` |

**Los cuatro componentes pedidos están funcionando y probados contra la API real
del estado.** El motor de datos, la IA local, la API y el panel React están
listos, la ingesta corre sola cada 30 minutos con alertas, y **las 339.608
licitaciones están puntuadas** (§3.8).

**Estado real de la base de datos** (27/09, después del barrido de §3.8):

| Tabla | Filas |
|---|---|
| `tenders` (procesos) | **339.608** |
| `contracts` (contratos) | **235.540** |
| Contratos con proceso enlazado | **178.673 (75,9%)** |
| `matches` (scores de IA) | **339.648** — ya no hay que repuntuar |
| — de ellas, refinadas con LLM (`qwen3:14b`) | 311 |
| — de ellas, solo etapa 1 (`vectorial`) | 339.337 |
| `alembic_version` | `0001_esquema_inicial` |

`tenders` subió de 336.659 a 339.608 porque la ingesta siguió corriendo sola
(último proceso publicado: 2026-09-25). Los **scores ya están regenerados**, que
era lo único que faltaba desde §5.6.

**Lo único a medias:** de las 339.337 filas `vectorial`, ~1.000 tienen el score
ya recalculado con el arreglo del bug #14 y ~338.000 siguen con el score viejo.
Es `barrido_scores.py --fase rehacer`, ~20-30 min, sin llamar a Ollama (§5.7).

**Queda pendiente:** ese `rehacer`, `docker-compose.yml`, paginación por cursor,
la pantalla de perfil editable en el frontend, y el escalado de §6.5. Ninguno
bloquea el uso diario salvo el `rehacer`, que es el único que cambia lo que se ve
en pantalla.

---

## 9. Dónde quedamos

### Lo hecho en la 5ª pasada (28/09): la IA sin GPU

1. **Ollama ya no se come la VRAM** (§3.8.3). Tres capas: `start.ps1` no lo
   levanta salvo `-ConOllama`, cuando lo levanta va con
   `OLLAMA_LLM_LIBRARY=cpu`, y su acceso directo del Inicio de Windows quedó
   desactivado. Verificado con `ollama ps` (**100% CPU**) y con el log de carga
   (**`CPU model buffer size`**, nada de `CUDA0`).
2. **Bug #16**: con la IA apagada, la ingesta se marcaba fallida y `/api/salud`
   quedaba en "degradado" permanentemente. Ahora la ausencia de IA es un estado
   legítimo (`ok` + `scoring.omitido: true`), gobernado por `OLLAMA_REQUIRED`.
3. **`stop.ps1` no descargaba los modelos.** Los `llama-server.exe` quedaban
   vivos con los pesos en memoria: 6.744 MiB en la tarjeta después de parar, y
   4.106 tras matarlos. Ahora los mata, siempre y antes que al padre.
4. **`OLLAMA_LLM` bajó a `llama3.2`** (de `qwen3:14b`): en CPU son 4,7-5,8 s
   por consulta, contra los varios minutos que habría dado el 14b.
5. **`OLLAMA_NUM_GPU=0` no hace nada en Ollama 0.33.3** — no existe esa
   variable. Es el consejo que se encuentra en internet y falla en silencio:
   el modelo se sube a CUDA igual. El control real es `OLLAMA_LLM_LIBRARY=cpu`.
6. **Tests: 80 → 86** (6 nuevos en `test_ia_opcional.py`), los 16 del frontend
   intactos.

### Lo hecho en la 4ª pasada (27/09)

1. **`matches` llena: 339.608 licitaciones puntuadas** (§3.8). Era el pendiente
   #1 desde §5.6 y lo único que bloqueaba el uso diario. Se hizo con un barrido
   por etapas (`barrido_scores.py`), no con `score.py --todo`, porque ese modo
   llama al LLM por fila: **28,5 s** medidos, o sea 112 días para el dataset.
2. **El panel ya es usable de punta a punta**: 990 oportunidades con score ≥ 70,
   filtros por score/texto/precio/territorio y facetas con recuentos reales. Los
   primeros resultados son tecnológicos de verdad (software, licencias,
   soporte), o sea que el ranking semántico funciona sobre la base entera.
3. **Bug #13**: `embed()` no reintentaba y mandaba cientos de textos de una vez,
   lo que tumba el tokenizer interno de Ollama. Ahora trocea y reduce el lote
   hasta que responde (§5.7).
4. **Bug #14**: la ruta vectorial **no aplicaba las reglas**, y el tope de las
   reglas se diluía con la mezcla 35/65. Una tarjeta podía decir "presupuesto
   por debajo del mínimo" y puntuar 77. Es el más importante de los tres, porque
   rompía lo que §3.5 promete y hacía que el score de un barrido y el de un ciclo
   con LLM no fueran comparables (§5.7).
5. **Bug #15**: contar pendientes las traía todas a memoria (340.000 objetos ORM
   por llamada, en cada ciclo de 30 minutos). Un `COUNT` y el barrido pasó de
   19/s a 141/s.
6. **Tests: 66 → 80.** 5 de troceado y reintentos de embeddings, 9 de
   selección de candidatos y aplicación de reglas.
7. **Documentación**: `README.md` con la sección de puntuación masiva y las tres
   trampas nuevas; este documento con §3.8, §3.8.1 y §5.7.

### Lo hecho en la 3ª pasada (26/09, tarde)

1. **Alembic conectado** (§5.5). Migración inicial autogenerada, `init_schema()`
   migra en cada arranque y reconoce las bases heredadas sin versionar. Era el
   punto 1 de la hoja de ruta.
2. **`alembic check` encontró 3 índices que el modelo declaraba y la base no
   tenía** desde el bug #10, más un `varchar(80)` donde el modelo dice 40. Los
   índices son la pieza que hacía que el enlace de contratos funcionara a fuerza
   de CPU, sin un solo error visible. Corregidos y medidos (§5.5).
3. **Bug #11**: `stop.ps1` no parseaba, así que el script de parada nunca
   funcionó. Y **bug #12**: correr migraciones apagaba el logging de la app
   entera. Los dos con test.
4. **Vacié la base de desarrollo** con un script de medición mal apuntado
   (§5.6). Recuperada y ampliada a 75 días; los scores hay que repuntuar.
5. **Tests: 45 → 66.** 16 nuevos de Alembic, 4 de índices. Todos en verde
   (2'40", desde 5'30"). El harness se quedó en dos fixtures, y la base
   plantilla se descartó tras medirla peor que reconstruir el esquema (§5.5).
6. **Cerrados los dos huecos de documentación** que el propio estado declaraba:
   - `alembic` añadido a `requirements.txt`. Faltaba la dependencia y
     `app/db.py` la importa en cada arranque, así que una instalación limpia no
     levantaba. Verificado con `pip install -r requirements.txt`.
   - El README **decía una cosa falsa**: que sin `--limite` se cargaba la ventana
     entera, cuando el valor por defecto es 100. Sus dos ejemplos de ingesta
     cargaban 100 filas y parecían una carga completa — es la trampa que se
     llevó la primera recuperación de datos (§5.6). Ahora llevan `--limite 0`,
     hay sección de Alembic, y las notas de mantenimiento dicen que las bases
     heredadas se sellan en vez de migrarse.


### Lo siguiente, en orden

El producto principal es el panel del navegador; el backend es opcional
(`.\start.ps1 -ConBackend`). Lo que queda, por orden de importancia:

1. **Registrar el `appToken` de Socrata** (solo el usuario puede: cuenta con su
   correo en `datos.gov.co/login`). Ya no hay que tocar ficheros: se pega en el
   panel **Datos** de la cabecera (o se deja en `frontend/public/app-config.json`
   para todos los visitantes de un despliegue). Es lo único que evita el límite
   de peticiones en la descarga completa; sin él el panel funciona igual con la
   descarga rápida de 5.000 procesos, pero la ventana completa acumula más
   429/503 — ya con diagnóstico visible y reintentos duros (§3).
2. **Repetir la carga completa con `appToken`** en hora punta. Ya se midió una
   vez sin token el 29/10 (24.047 filas → 18.346 procesos distintos, 14.357
   contratos, 80 peticiones, 99 s, 0×429/503, ~101 MB). El token no es
   obligatorio para que funcione, pero reduce el riesgo de que Socrata corte una
   repetición con 429/503.
3. **Desplegar a Vercel**, si se quiere usar fuera de esta máquina. Verificado
   que compila y que el score va en el navegador; los datos siguen siendo por
   navegador (§4).
4. **`docker-compose.yml`** — lo único de la hoja de ruta original sin empezar;
   solo tiene sentido con el backend y el ciclo automático, que el panel no
   necesita.
5. **Repuntar los scores del backend** (~338.000 siguen con el score anterior al
   arreglo del bug #14, §5.7). Solo afecta a la ruta del backend.
6. Recortar la suite del backend de 2'40" a menos de 2' (§6.4), si se sigue
   manteniendo el backend.
7. Paginación por cursor en los listados del backend.

### Dos cosas que conviene mirar con calma

- **El enlace de contratos sube a 75,9%, no a 100%.** Los ~57.000 que quedan
  apuntan a procesos fuera de la ventana de 75 días cargada (publicados antes).
  Al ampliar la ventana deberían entrar solos; si no, habría que buscar el
  proceso por otro campo.
- **La suite se paga por el `fsync`, no por las pruebas.** Bajó de 5'30" a
  2'40" quitando escrituras que no cambiaban nada (§5.5), pero sigue pagando el
  precio de 60 reconstrucciones de esquema. El siguiente paso es quitar el
  teardown de `esquema_limpio`, que es la mitad de esas 60.



