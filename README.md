# Licitaciones

Alerta de oportunidades de contratación del Estado colombiano (SECOP II y SECOP I):
baja los datasets abiertos de SECOP, puntúa cada proceso de 0 a 100 **en el
navegador** y muestra los que mejor encajan con el perfil de la empresa.

Todo ocurre en la página: no hay servidor, ni base de datos, ni modelo. Los datos
viven en el IndexedDB del navegador y la puntuación es un score compuesto (TF-IDF
con coseno, UNSPSC, presupuesto, palabras clave y plazo) en TypeScript. Parado,
el proyecto no gasta CPU, RAM ni VRAM.

Además del listado puntuado: filtros con inclusión/exclusión de palabras y
búsquedas guardadas, resumen de requisitos de cada pliego, un tablero Kanban de
seguimiento, alertas para lo que pase de 80 puntos y exportación a CSV, Excel y
PDF. Ver [Funcionalidades](#funcionalidades).

## Arranque rápido

```powershell
.\start.ps1
```

Eso levanta **solo el frontend** y abre http://localhost:5173. No hay nada más que
arrancar: no hay PostgreSQL, ni API, ni Ollama, ni descarga automática.

| Qué | Dónde |
| --- | --- |
| Panel | http://localhost:5173 |
| Logs | `.run\*.err.log` |
| Capturas de referencia | `.run\captura-*.png` |

Para parar:

```powershell
.\stop.ps1
```

Parar la página **no borra nada**: los datos están en el navegador.

### Cómo se ve

Con el navegador recién estrenado la cabecera dice `IndexedDB · 0 procesos · 0
puntuados` y el cuerpo explica que no hay datos y que hay que pulsar el botón:
nada baja solo. Después de una descarga acotada (120 procesos) la misma página
enseña `120 procesos · 120 puntuados`, 24 fichas por página, y al abrir una ficha
el modal con su detalle y sus contratos. En la **carga completa** del 29/10
(ventana de 7 días) fueron 24.047 filas de procesos —18.346 distintos, porque el
dataset publica copias— y 14.357 contratos: 99 s, 80 peticiones, 0 errores y
~101 MB en IndexedDB. Las capturas de `.run\` son de esas corridas.

Un detalle que conviene tener claro: **el estado del panel es de cada navegador**.
Si pruebas con otro, o en incógnito, empieza a cero aunque la descarga ya se
haya hecho en el tuyo. Para llevar los datos de uno a otro está el NDJSON de
`Exportar` / `Importar`.

## Cómo se usa

1. **Descargar SECOP.** Botón en la cabecera. Baja los procesos de la ventana
   elegida (últimos 7 días por defecto, o desde la última descarga) y los puntúa.
   Sale el progreso real y se puede **cancelar** a media descarga.
2. **Datos.** Botón en la cabecera. Token de Socrata, días de ventana, topes de
   procesos y contratos, y si se bajan contratos. Se guarda en el navegador y se
   aplica en la siguiente descarga.
3. **Perfil.** Botón en la cabecera. Se edita el perfil de la empresa —palabras
   clave, actividades, exclusiones, departamentos, rango de presupuesto— y se
   guarda en el navegador. `Guardar perfil` no repunta solo: `Repuntuar todo`
   vuelve a puntuar lo ya descargado con el perfil nuevo.
4. **Respaldo.** Exportar / Importar. Los datos son de esta máquina, así que hay
   una salida en NDJSON y una entrada para volver a cargarlos en otro equipo.

Por defecto nada se ejecuta sin que se pulse el botón. La única excepción es
opt-in: en **Datos** se puede activar la sincronización periódica (cada N
minutos, incremental), que solo corre mientras la pestaña esté abierta.

## Funcionalidades

| Qué | Dónde | Cómo funciona |
| --- | --- | --- |
| **Score 0-100 con semáforo** | Cada tarjeta | Alto ≥ 70, Medio 40-69, Bajo < 40. La tarjeta enseña el desglose por componente (ver [Puntuación](#puntuación)). |
| **SECOP I** | Descarga | Procesos *convocados* de `f789-7hwg`, mapeados al mismo registro y marcados `fuente: SECOP I`. Se activa/desactiva y se acota en **Datos**. |
| **Sincronización periódica** | **Datos** | Opt-in. Cada N minutos (mínimo 5) baja en modo incremental mientras la pestaña está abierta. No duplica: el `put` es por id. |
| **Filtros avanzados** | Panel de filtros | Texto libre, *Incluir* (cualquiera de) y *Excluir* (ninguna de) palabras, cuantía mínima/máxima, departamento, municipio, entidad, estado, modalidad, fuente y score mínimo, combinables y en vivo. |
| **Buscador** | Barra encima de la lista | Busca en lo descargado: objeto, entidad, número de proceso (`CO1.REQ…`, `CO1.NTC…`, constancia de SECOP I), referencia, municipio, modalidad o UNSPSC. `"Comillas"` = frase exacta. |
| **Buscar en SECOP** | Botón junto al buscador | Pregunta a datos.gov.co **sin límite de fechas** (texto completo `$q` en objeto y descripción, o el número de proceso exacto), guarda y puntúa lo encontrado y lo enseña. Hasta 100 resultados por fuente, los más recientes. El `CO1.NTC…` no se puede buscar así: va dentro de una URL que el portal no indexa. |
| **Búsquedas guardadas** | Panel de filtros | Se guardan con nombre (el mismo nombre sobrescribe) en este navegador. |
| **Resumir pliego** | Botón en cada tarjeta → pestaña *Requisitos* | Requisitos jurídicos, financieros y técnicos: frases citadas del texto publicado + lo que la ley pide para la modalidad (marcado *habitual*). Sin red ni LLM. |
| **Tablero (CRM)** | Pestaña *Tablero* | Kanban de 5 columnas: En evaluación, En preparación, Oferta presentada, Ganada, Descartada. Arrastrar o selector; nota por tarjeta. Viaja en el respaldo NDJSON. |
| **Alertas** | Botón *Alertas* | Avisa una vez por proceso cuando una descarga trae uno con score **superior a 80** (umbral editable). Notificación del sistema opcional. |
| **Exportar resultados** | *Descargar resultados: CSV · Excel · PDF* | Todo lo que pasa los filtros, en el orden de la lista. CSV con `;` y BOM (Excel es-CO), XLSX real, PDF A4 apaisado. |

Límites honestos:

- **El resumidor no lee el PDF del pliego.** Los documentos están en
  `community.secop.gov.co` / `contratos.gov.co`, que no dejan descargarlos desde
  otra página (CORS), y `datos.gov.co` solo publica metadatos. El resumen lo dice
  y enlaza al proceso.
- **"Por usuario" es "por navegador".** No hay cuentas: búsquedas, tablero y
  alertas viven en el IndexedDB de quien las crea.
- **SECOP I no publica fecha de cierre**: en esos procesos el componente de plazo
  queda sin datos y su peso se reparte entre los demás.

### Configuración de la descarga

El botón **Datos** abre los ajustes que antes solo se podían tocar editando
`public/app-config.json` y volviendo a compilar:

| Ajuste | Por defecto | Para qué |
| --- | --- | --- |
| `appToken` | vacío | Sube el límite de peticiones de Socrata. Se registra en datos.gov.co. |
| `lookbackDays` | 7 | Días hacia atrás que se descargan. |
| `maxProcesos` | 5.000 | Tope de procesos por pasada. |
| `maxContratos` | 2.000 | Tope de contratos por pasada. |
| `includeContracts` | sí | Bajar también contratos electrónicos. |

Se guardan en `localStorage`, que manda sobre `app-config.json` (el fichero sigue
siendo el valor de fábrica para un despliegue). La decisión de producto es:
**por defecto se bajan 5.000 procesos y 2.000 contratos**, que es rápido y no
depende del token; la **ventana completa** (~24.000 procesos y ~14.000 contratos,
medido el 29/10) es el preset explícito *Ventana completa · 7 días* y pide
`appToken`, porque sin él Socrata puede devolver 429/503 y la descarga puede
morir a mitad. Todos los procesos descargados se puntúan: ya no hay un
`scoreLimit` que recorte la puntuación.

El token se pega en **Datos** y queda en este navegador. Para que lo usen todos
los visitantes de una página publicada, se puede dejar en
`frontend/public/app-config.json`; no es una credencial de escritura, identifica
la aplicación ante Socrata.

## Los datos

| Dataset | ID | Qué trae |
| --- | --- | --- |
| Procesos SECOP II | `p6dx-8zbt` | Licitaciones publicadas |
| Contratos SECOP II | `jbjy-vk9h` | Contratos firmados |
| Procesos SECOP I | `f789-7hwg` | Procesos de compra pública; se bajan solo los `Convocado` |

Se leen directo de `datos.gov.co` desde la página (`Access-Control-Allow-Origin:
*`). Las claves **no** se cruzan por su id: en procesos es `CO1.REQ.*` y en
contratos `CO1.PCCNTR.*`. Lo único que comparten es el `noticeUID` (`CO1.NTC.*`)
de la URL `OpportunityDetail`, y por eso se enlazan (`noticeUid()` en
`src/lib/socrata.ts`).

La descarga por defecto está acotada a **5.000 procesos y 2.000 contratos**; la
ventana completa se activa en el panel **Datos** y conviene tener `appToken`.

El almacén son siete stores IndexedDB (`src/lib/db.ts`, versión 3): `procesos`
(con descripción), `ligeros` (sin texto, para el índice de consulta), `matches`,
`contratos`, `acciones`, `crm` (el tablero) y `meta` (perfil, alertas, búsquedas
guardadas, historial). Si el navegador no deja abrir IndexedDB —abrir el
HTML con doble clic lo bloquea, y el incógnito también— cae a un almacén en
memoria y aparece un **banner ámbar** que lo dice: se puede usar, pero no se
guarda, y los datos se pierden al recargar. Para tener guardado de verdad,
ábrelo en `http://localhost:5173` con `.\start.ps1`.

## Puntuación

Sin modelo y sin GPU (`src/lib/score.ts`). El score es una media ponderada de
cinco componentes, cada uno de 0 a 100:

| Componente | Peso por defecto | Cómo se calcula |
| --- | --- | --- |
| Objeto | 30 | Similitud TF-IDF + coseno entre el perfil y el objeto/descripción |
| UNSPSC | 25 | 100 si el código del proceso cae dentro de un código del perfil; si no, 80/60/30 por misma clase/familia/segmento |
| Presupuesto | 20 | 100 dentro del rango del perfil; fuera, la proporción con el límite rebasado |
| Palabras clave | 15 | Coincidencias literales; satura en 4 |
| Plazo | 10 | Días hasta el cierre: cerrado 0, ≤2 días 25, ≤5 días 60, 6-45 días 100, más 80 |

Los pesos se editan en **Perfil** y se normalizan. Un componente sin datos
(perfil sin UNSPSC, proceso sin precio o sin fecha de cierre) **no cuenta como
0**: su peso se reparte entre los demás. Los códigos UNSPSC del perfil van en
**Perfil** (por defecto 4323 software, 8111 servicios informáticos y 8116
entrega de servicios de TI).

El orden de las operaciones es el importante:

1. los cinco componentes;
2. la mezcla ponderada;
3. penalizaciones de modalidad (-15) y territorio (-10), y topes por exclusión
   (5) y por presupuesto (20), **al final**.

El paso 3 va al final a propósito. Un tope aplicado antes de mezclar se reescala
hacia arriba al multiplicar por el peso semántico, y un proceso excluido con
similitud 100 salía con 8 en vez de 5. Ver `ESTADO-PROYECTO.md` §5.7.

Lo que se pierde frente al modelo: no entiende sinónimos ni paráfrasis, y los
`bullets` no son texto redactado sino las razones de las reglas y los términos que
más pesan. Lo que se gana: es determinista, tarda milisegundos, ocupa nada y se
puede cancelar.

## Copias de seguridad

`Exportar` escribe NDJSON: una línea de cabecera (versión del formato, stores y
perfil con el que se puntuó) y una línea por fila. Con la File System Access API
(Chrome, Edge) se escribe a disco línea a línea, así que el tamaño no importa; en
Firefox y Safari se arma un `Blob` en memoria, que es lo que limita el tamaño.

`Importar` acepta texto, `File` o `Blob`, y va leyendo por trozos. Una línea
corrupta se cuenta y se sigue: un fichero a medio escribir es el caso normal, no la
excepción. El perfil de la cabecera **no se aplica solo** —se avisa y se decide—,
porque puntuar contra otra empresa por accidente sería peor que no puntuar.

Para cambiar de máquina: exportar en una, importar en la otra.

## Backend (opcional, y desactivado)

El backend con FastAPI, PostgreSQL y Ollama se conserva tal cual, pero ya no lo
usa nadie: el panel no habla con él. Si se quiere levantar:

```powershell
.\start.ps1 -ConBackend            # + PostgreSQL y la API
.\start.ps1 -ConBackend -ConOllama  # + Ollama, forzado a CPU
.\stop.ps1 -ConBackend             # pararlo
```

El ciclo automático del backend está **desactivado** (`ENABLE_SCHEDULER=false` en
`.env` y `enable_scheduler: bool = False` en `backend/app/config.py`): con solo
levantar la API se lanzaba una sincronización cada media hora por su cuenta.

### La IA legacy no toca la GPU

Solo aplica a `-ConOllama`, y sigue siendo deliberado: Ollama retiene los modelos en
memoria entre llamadas, y con `qwen3:14b` eran casi 10 GB de la tarjeta
(ESTADO-PROYECTO.md §3.8.2). Cuando se levanta va con `OLLAMA_LLM_LIBRARY=cpu`, que
hace que no detecte la GPU; comprobable con `ollama ps` → `100% CPU`.

Dos avisos que ya costaron tiempo:

- **`OLLAMA_NUM_GPU=0` no hace nada** en Ollama 0.33.3: esa variable ya no existe y
  el modelo se sube a CUDA igual, sin avisar.
- **Parar Ollama no descarga los modelos.** Cada modelo cargado corre en su propio
  `llama-server.exe`, que sobrevive al cierre del servidor. `stop.ps1
  -ConBackend` los mata; si mataste `ollama.exe` a mano:
  `Get-Process 'llama-server' | Stop-Process -Force`.

## Requisitos

Para el panel: **Node 18+**. Nada más (TypeScript, ESLint y las librerías de
exportación se instalan con `npm ci`).

Para `-ConBackend`: Python 3.11+ y PostgreSQL embebido en `.pgdata\` (el binario se
descarga solo la primera vez con `backend\scripts\pg_manager.py init`).

## Estructura

```
frontend/
  index.html
  src/
    lib/
      tipos.ts       interfaces de dominio (procesos, filtros, scoring, CRM...)
      api.ts         fachada: la superficie que consume la UI, resuelta en local
      socrata.ts     cliente SODA (fetch con reintentos + respaldo por JSONP)
      mapper.ts      filas de Socrata (SECOP II y SECOP I) -> registros del panel
      db.ts          IndexedDB y su fallback en memoria
      indice.ts      filtros, facetas, orden y paginación en memoria
      score.ts       score compuesto: TF-IDF, UNSPSC, presupuesto, palabras, plazo
      ingesta.ts     descarga, progreso, cancelación, enlazado y alertas
      autosync.ts    sincronización periódica opt-in
      alertas.ts     alertas de score alto y notificaciones
      resumidor.ts   requisitos jurídicos, financieros y técnicos del pliego
      exportar.ts    CSV, XLSX y PDF de la lista filtrada
      snapshot.ts    exportar / importar NDJSON (respaldo)
      ocds.ts        releases OCDS 1.1 de tender y contrato
      perfil.ts      perfil de empresa
      config.ts      configuración editable desde el panel
    components/      React
      PanelDatos.tsx   token, días, topes, SECOP I y sincronización periódica
      Tablero.tsx      CRM Kanban
      PanelAlertas.tsx campana y ajustes de alertas
      ResumenPliego.tsx pestaña de requisitos
  src/test/          vitest (lógica y componentes)
  e2e/               Playwright: humo con datos falsos + carga real opt-in
  playwright.config.ts
  tsconfig.json      TypeScript estricto (strict, noImplicitAny, noUnusedLocals...)
  eslint.config.js   typescript-eslint + react-hooks; `no-explicit-any` es error
backend/             stack legado, opcional (ver arriba)
.run/                PIDs y logs que crea start.ps1
```

## Comandos habituales

```powershell
# Panel en desarrollo (lo normal)
.\start.ps1

# Compilar a frontend\dist; se abre con doble clic (base relativa)
.\start.ps1 -Build

# Tests
cd frontend
npm run typecheck # tsc --noEmit, TypeScript estricto
npm run lint      # ESLint (typescript-eslint, react-hooks)
npm test          # 98 unitarios (vitest): lógica, panel, descarga y funciones nuevas
npm run test:e2e  # 5 de humo (Playwright): la pagina en un navegador de verdad
npm run build     # typecheck + build de producción
```

Los dos verdes. El unitario no necesita nada; el de humo levanta el build con
`vite preview`, intercepta `datos.gov.co` y comprueba en un Chromium que la
descarga entra, se puntúa, se pinta y **sobrevive a recargar** (que es como se
distingue IndexedDB del almacén en memoria). También comprueba que el contrato se
enlaza con su proceso: en la segunda tarjeta tiene que salir "Sin contratos
asociados", y en la primera el contrato.

La sexta, la de datos reales, sale **skipped** en ese `npm run test:e2e` porque
golpea el portal de datos abiertos de verdad y esa suite tiene que poder correr
sin internet. Va acotada con topes bajísimos (120 procesos de los ~24.000 que trae
la ventana de 7 días) y solo se lanza a mano:

```powershell
$env:SECOP_REAL = '1'
npx playwright test e2e/secop-real.spec.ts
```

La **carga completa** no es una suite: se midió a mano el 29/10 con el preset
*Ventana completa · 7 días*, en un Chromium limpio y sin `appToken`. Resultado:
24.047 filas de procesos (18.346 distintos tras deduplicar), 14.357 contratos,
80 peticiones, 99 s, 0 respuestas 429/503, 0 caídas, 0 errores de consola y
~101 MB en IndexedDB. Los 18.346 procesos quedaron puntuados y persistidos.

> Las suites han pagado por sí solas, y siempre con bugs de los que aparecen solo
> al ejecutarlas:
>
> | Suite | Bug que encontró |
> |---|---|
> | vitest | `indice.js` llamaba `aceite()` en vez de `acepta`: `ReferenceError` en **toda** consulta con filtros |
> | vitest | `isoDia()` truncaba en UTC: con hora local de madrugada el **primer día de la ventana se quedaba fuera** sin avisar |
> | vitest | `stop.ps1` decía "[ok] web cerrado" dejando Vite con 104 MB y el 5173 ocupado |
> | playwright | La descarga se guardaba bien pero el panel se quedaba en "0 oportunidades": la ingesta emitía `listo` antes de que la fachada rehíciese el índice |
> | playwright (datos reales) | `iterRows` comprobaba el tope **después** de leer la página: con `maxProcesos: 120` y páginas de 500 se guardaban **499 procesos de más** |
> | carga completa real | La lista pintaba `—` en todas las tarjetas aunque hubiera 18.346 matches: `filaDe` devolvía `score` suelto y `aOportunidad` lee `fila.match` |
>
> Por eso los tests son parte del trabajo, no un extra.

## Publicar en Render

El repo trae `render.yaml`, `package.json` en la raíz y `.node-version`
(Node 22.12, el mínimo de Vite 8). No uses `npm run dev`: es el servidor de
desarrollo y solo escucha en `127.0.0.1`.

**Opción recomendada: Static Site con el Blueprint.** En Render: *New +* →
*Blueprint* → este repositorio. Crea un Static Site con:

| Ajuste | Valor |
| --- | --- |
| Root Directory | `frontend` |
| Build Command | `npm ci && npm run build` |
| Publish Directory | `dist` |

Es gratis y no se duerme por inactividad, porque no hay servidor que dormir.

**Si ya creaste un Web Service como Python** (Render lo detecta así por la
carpeta `backend/`), funciona sin tocar nada, con Build Command `pip install -r
requirements.txt` y Start Command `npm run dev`:

- `requirements.txt` de la raíz está vacío a propósito: el paso de `pip` pasa
  sin instalar nada.
- El entorno Python de Render también trae Node (lee `.node-version`), y
  `npm run dev` **de la raíz** no es el modo desarrollo: instala, construye y
  sirve la versión de producción en el `PORT` de Render. Tarda ~1 minuto en
  arrancar porque construye en cada arranque.

En local, el modo desarrollo sigue siendo `.\start.ps1` o `npm run dev` dentro
de `frontend/`.

**Más limpio: cambiar el servicio a Node.** En *Settings*:

| Ajuste | Valor |
| --- | --- |
| Language | **Node** |
| Root Directory | *(vacío)* |
| Build Command | `npm run build` |
| Start Command | `npm start` |

`npm start` sirve el build con `vite preview` en el `PORT` que da Render y
acepta los dominios `*.onrender.com` (Vite rechaza por seguridad las cabeceras
`Host` que no conoce). En el plan gratuito un Web Service se duerme tras 15
minutos sin visitas; el Static Site no.

## Publicar en Vercel (o en cualquier sitio estático)

Se puede, y es poco trabajo: `npm run build` deja tres ficheros en `frontend\dist`
y no hay servidor, ni variables de entorno, ni backend. La puntuación va en el
navegador, así que **el score funciona exactamente igual** desplegado, y los
botones "Abrir en SECOP" también (enlazan con `community.secop.gov.co`, patrón
`OpportunityDetail/Index?noticeUID=CO1.NTC.*`).

Tres cosas que hay que tener presentes:

- **Cada visitante empieza de cero.** Los datos son del navegador que descargó,
  así que el primer uso de la URL publicada es pulsar "Descargar SECOP". Para
  datos compartidos y actualizados solos habría que añadir un backend
  (Neon/Turso/Supabase) y mover allí la ingesta.
- **No vale el backend tal cual**: Ollama es un proceso largo sin GPU, PostgreSQL
  no tiene disco persistente y Vercel Cron solo llama a funciones serverless.
- Si quieres que todos los visitantes usen el mismo `appToken`, déjalo en
  `frontend/public/app-config.json` antes de compilar; si no, cada uno puede
  pegarlo en **Datos**. El token identifica la aplicación ante Socrata, no es una
  credencial de escritura.
- Configura el **directorio raíz** en `frontend` y el **comando de build** en
  `npm run build`. No hay `vercel.json` en el repo; si se decide añadirlo, es cosa
  de un rato.

## Si te pasa: "he descargado, he pulsado Actualizar y no sale nada"

El vacío se explica solo, dentro del vacío:

- Si la última descarga falló, bajo "todavía no tiene datos" aparece
  **"La última descarga falló: …"** con el error real (p. ej. `HTTP 429`), y el
  chip de la cabecera lo sigue mostrando tras recargar.
- Si se cortó a mitad, dice cuántos de cuántos llevaba. Lo ya descargado está
  guardado y **Descargar SECOP** lo retoma.
- La línea **"Los datos viven en este navegador, en …"** muestra el origen
  exacto: los datos viven **por origen**, y `http://localhost:5173` y
  `http://127.0.0.1:5173` son dos sitios distintos a propósito; incógnito y
  otro navegador también. Para llevar datos de uno a otro está el NDJSON de
  `Exportar` / `Importar`.
- Y si el panel dice que hubo una descarga completada aquí pero no encuentra
  procesos, eso ya no es la descarga: es un fallo del panel y hay que
  reportarlo.

Lo segundo a mirar es la descarga por sí misma: la ventana completa son ~80
peticiones a Socrata, y sin `appToken` el portal puede devolver 429/503 y cortar
la descarga a medias (el 29/10 aguantó las 80 sin un solo 429, pero no está
garantizado). La descarga rápida por defecto (5.000 procesos) son ~15 peticiones,
así que es mucho menos probable que choque con el límite. El mensaje de error ya
lo dice y apunta al arreglo (registrar el token en datos.gov.co y pegarlo en
**Datos**, o bajar `maxProcesos` en ese mismo panel). Si es eso, ver "Socrata se
cae" más abajo.

## Notas de mantenimiento

**No editar `alembic_version` a mano** ni saltarse las migraciones: son del
backend legado, pero `app/db.py` corre `alembic upgrade head` en cada arranque.

**Socrata se cae.** Devuelve 503 y timeouts bajo carga, sin token registrado. El
cliente reintenta con espera creciente, y si el servidor manda `Retry-After`
(429/503) espera lo que pide, con tope de 60 s. Un 429/503 además concede dos
reintentos extra y hace que la paginación ralentice su ritmo (x3, tope 5 s) para
el resto de la corrida: el límite se levanta con el tiempo, no con más prisa. Es
normal ver avisos. Con un `appToken` en **Datos** desaparecen. Fechas: son `calendar_date`, así que los filtros
SoQL van con literales ISO y a granularidad de día; comparar contra epoch en
milisegundos devuelve 400. El día se saca de los diez primeros caracteres de la
cadena, sin pasar por UTC: con hora local de la tarde (`23:00`) el día se avanzaba
y la ventana traía de más el último; con las de la madrugada (`02:00`, UTC-5)
retrocedía y **el primer día se quedaba fuera sin avisar**. Solo lo que no tiene
ambigüedad (epoch, `Date`) se resuelve en UTC.

**El texto de Socrata no respeta los anchos de columna.** Hay entidades que meten
el objeto entero del contrato en `referencia_del_contrato`. `recortar()` en
`mapper.ts` los corta al ancho de la columna antes de guardar.

**Los ids de proceso se repiten.** El dataset publica el mismo `id_del_proceso`
varias veces (144.341 filas eran 118.817 ids distintos), así que `deduplicar()`
resuelve antes de escribir. Sin eso, el `put` en lote revienta.

**El `noticeUID` de la URL es la clave de unión** con los contratos. Si un proceso
no trae URL, no enlaza con su contrato: es un dato que falta arriba, no un bug.

**`ligeros` sin `descripcion`.** El índice de consulta se construye con las filas
ligeras porque los textos son el 95% del peso; puntuar con ellas daría un score
solo por título, sin error ni aviso. Por eso `repuntuarTodo()` recupera los
procesos completos por trozos de 2.000.

**Exportar encadena las escrituras.** El recorrido del cursor de IndexedDB es
síncrono (`cursor.continue()` va detrás de `alFila`), así que no se puede parar a
esperar dentro o la transacción se cierra sola. `descargar()` encadena los
`writable.write()` y espera la cola antes de `close()`: sin eso se lanzarían
unas 340.000 escrituras a la vez —orden del fichero según el scheduler— y el
`close()` podría descartarlas y dejar el `.ndjson` truncado sin avisar.

**Contar pendientes no es traerlos.** `embed_profile` se llamaba en cada ciclo de
30 minutos; hidratar las 340.000 filas para un número que solo va al log es lo que
hacía que el panel tardara segundos en arrancar.

**Las bases que ya existían no se migran, se sellan** (backend legado): si
`init_schema()` halla tablas del modelo pero no `alembic_version`, primero las
reconcilia y luego las marca en `head`, porque aplicar la migración inicial
reventaría con "relation already exists".