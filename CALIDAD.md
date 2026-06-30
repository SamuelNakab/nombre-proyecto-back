# CALIDAD.md — Fleter Backend

## Estrategia general

Para este proyecto priorizamos profundidad sobre cobertura total. En lugar de
intentar testear cada función del backend, identificamos los puntos donde un
bug ya nos había costado tiempo real durante el desarrollo —el matching de
viajes, la validación de elegibilidad de conductores, el cálculo de tarifas—
y concentramos ahí los tests unitarios. La razón es simple: estas son las
funciones que determinan si el negocio funciona o no. Un bug en el cálculo de
hora pico cobra de más o de menos a un cliente real; un bug en la
elegibilidad de conductores (que de hecho encontramos y corregimos durante el
desarrollo, ver más abajo) le mostraba viajes a conductores que no podían
aceptarlos.

Para el flujo completo elegimos un único test E2E que corre contra el
ambiente de staging real (no un mock, no una base de datos en memoria),
porque lo que más nos interesaba validar no era una función aislada sino que
todas las piezas —autenticación con Firebase, validación con Zod, Prisma,
Redis— sigan conectando correctamente entre sí después de cada cambio.

El pipeline de CI/CD se diseñó para que el feedback llegue lo antes posible y
lo más barato posible: lint primero (segundos), tests unitarios después
(milisegundos), y al final el E2E contra staging (varios segundos, porque
incluye una llamada real a Google Maps). Si algo barato de detectar falla, no
tiene sentido gastar tiempo corriendo lo caro.

## Herramientas seleccionadas

**Vitest** para tests unitarios. Lo elegimos sobre Jest porque el backend usa
ES Modules nativos (`import`/`export`, sin `require`) en toda su base de
código, y Vitest los soporta sin configuración adicional. Jest históricamente
requiere transformadores o flags experimentales para ESM puro, lo cual
hubiera agregado complejidad innecesaria a un proyecto que ya está
construido 100% en ESM.

**Tests E2E con `fetch` nativo de Node**, sin un framework como Playwright o
Cypress. La razón es que el backend no tiene interfaz visual propia —es una
API REST más WebSockets— así que un framework pensado para automatizar un
navegador no aporta nada aquí. El flujo crítico real es HTTP y autenticación,
no DOM. Reutilizamos además el mismo patrón de autenticación con Firebase que
ya usábamos en nuestros scripts de verificación manual del backend
(`scripts/test-fase5.js` y similares), así que no inventamos una forma nueva
de testear: formalizamos dentro del pipeline una práctica que ya existía.

**ESLint con flat config** (`eslint.config.js`), el formato moderno y
recomendado actualmente por el proyecto ESLint, sobre el formato legacy
`.eslintrc`. Configuramos manualmente los globals de Node 22 (`Buffer`,
`fetch`, `URL`, los timers) porque el preset por defecto de ESLint no asume
un entorno Node con APIs modernas como `fetch` global.

**GitHub Actions** para CI/CD, en lugar de un servicio externo como
CircleCI o Travis. Al estar el código ya en GitHub, Actions no requiere
ninguna integración adicional ni cuenta en otro servicio, y los secrets se
gestionan en el mismo lugar donde vive el repositorio.

**Railway CLI** para el deploy, en lugar de depender del auto-deploy nativo
de Railway conectado a GitHub. Esto fue una decisión deliberada: el
auto-deploy de Railway se dispara con cualquier push, sin importar si el
código pasó algún tipo de verificación. Lo desactivamos explícitamente en
ambos entornos (staging y production) para que el **único** camino posible
hacia un deploy sea a través del pipeline, después de que lint, tests
unitarios y E2E hayan pasado.

## Tests desarrollados

- **Unitario — `esHoraPico(fecha)`**: valida que las franjas de tarifa pico
  (7–10h y 17–20h) se detecten correctamente. Esta función no existía como
  unidad aislada antes de este TP —el cálculo vivía inline dentro de
  `obtenerTarifas()`— y se extrajo sin modificar la lógica de cálculo,
  específicamente para poder testearla. Cubre: hora pico de mañana, hora pico
  de tarde, y un horario fuera de ambas franjas.

- **Unitario — `conductorEsElegible(vehiculosConductor, vehiculosPropios,
  condicionesViaje)`**: valida la regla central de elegibilidad de
  conductores para un viaje. Cubre tres casos: un conductor sin ningún
  vehículo registrado nunca es elegible (incluso si el viaje no exige
  condiciones especiales), un conductor con un vehículo que cumple las
  condiciones requeridas sí es elegible, y un conductor con un vehículo que
  no las cumple no lo es. El primer caso cubre un bug real que existió en
  producción durante el desarrollo del backend: la lógica original devolvía
  "elegible" por defecto cuando un viaje no tenía condiciones requeridas,
  sin verificar si el conductor tenía siquiera un vehículo. Esto hacía que
  conductores sin ningún vehículo registrado vieran viajes disponibles que
  después no podían aceptar.

- **E2E — login y creación de viaje**: simula el flujo crítico completo de
  un cliente real. Autentica contra Firebase con credenciales de un usuario
  de prueba, obtiene el token JWT, y usa ese token para crear un viaje real
  vía `POST /api/viajes` contra el backend de **staging**. Verifica que la
  respuesta sea `201` y que el viaje creado tenga un `id_viaje` válido. Este
  test corre contra infraestructura real (Railway staging, base de datos de
  staging separada de producción, Google Maps real), no contra un mock,
  porque lo que queremos garantizar es que el sistema completo sigue
  funcionando de punta a punta, no solo que una función aislada devuelve el
  valor esperado.

## Casos de uso críticos

Priorizamos el flujo de **creación y matching de un viaje** sobre cualquier
otro, porque es el corazón del producto: si un cliente no puede crear un
viaje, o si la elegibilidad de conductores está mal calculada, ningún otro
feature importa —no hay negocio. Por esa misma razón el test E2E elegido es
exactamente ese flujo (login → crear viaje) y no, por ejemplo, el flujo de
calificación post-viaje, que es valioso pero secundario: un bug en
calificaciones es molesto, un bug en creación de viajes detiene la operación
completa de la plataforma.

La elegibilidad de conductores en particular se priorizó como test unitario
porque ya nos había generado un incidente real (ver sección de IA), y porque
es lógica pura sin dependencias externas (no toca la base de datos ni la
red), lo que la hace ideal para un test rápido y determinístico que puede
correr en cada commit sin fricción.

## Pipeline de CI/CD

El workflow (`.github/workflows/ci.yml`) tiene un job de verificación y dos
jobs de deploy, mutuamente excluyentes:

**`quality`** corre en cada push y en cada Pull Request hacia `main` o
`develop`. Sus pasos, en orden: instalar dependencias (`npm ci`), lint,
generar el cliente de Prisma, tests unitarios, y por último el test E2E
contra staging. El orden no es arbitrario: el lint es la verificación más
barata (no ejecuta código, solo lo analiza estáticamente) y por eso va
primero —si el código tiene un problema de sintaxis o un uso indebido de una
variable, no tiene sentido gastar tiempo corriendo tests sobre él. Los tests
unitarios van después porque son rápidos (milisegundos) pero sí ejecutan
código real. El E2E va al final porque es el más lento —involucra una
llamada de red real a Firebase y a nuestro propio backend, que a su vez llama
a Google Maps— y es el que menos sentido tiene correr si algo más básico ya
falló.

**`deploy-staging`** depende explícitamente de `quality` (`needs: quality`)
y solo se ejecuta cuando el evento es un push directo a `develop` (no en
Pull Requests, para no deployar código que todavía no fue aprobado). Usa un
token de Railway (`RAILWAY_TOKEN_STAGING`) scopeado específicamente al
entorno de staging.

**`deploy-production`** tiene la misma estructura pero condicionado a `main`,
y usa un token separado (`RAILWAY_TOKEN_PRODUCTION`). Tener dos tokens
distintos, en lugar de uno compartido, fue una decisión de seguridad
deliberada: si alguna vez uno de los dos secrets se filtrara, el daño queda
acotado a un solo entorno.

Decisión de diseño clave: si el lint falla, el pipeline se detiene
inmediatamente y ningún paso posterior se ejecuta —ni los tests, ni mucho
menos el deploy. Esto es intencional. El objetivo es que un error barato de
detectar nunca llegue a consumir los recursos (y el tiempo de espera) de
verificaciones más caras, y mucho menos que llegue a producción.

Sobre el paso de "build": el backend es Node.js puro con ES Modules, sin
ningún paso de transpilación o bundling (a diferencia de un frontend con
Next.js o Vite). Por eso no existe un comando `build` tradicional en este
repositorio; el rol que normalmente cumple "build" —confirmar que el código
es válido y ejecutable— ya está cubierto por la combinación de lint y tests,
que de hecho detectaron errores reales durante el desarrollo de este mismo
pipeline (ver siguiente sección).

## Limitaciones y deuda técnica

Somos honestos sobre lo que quedó sin cubrir:

- **Cobertura parcial de servicios.** Servicios como `gps.service.js`,
  `cierre.service.js` y los handlers de Socket.io (`matching.socket.js`,
  `gps.socket.js`) no tienen tests unitarios en este TP. La razón es que
  dependen fuertemente de Prisma y Redis reales —testearlos de forma aislada
  requeriría mockear ambos, lo cual no entraba en el alcance de tiempo de
  esta entrega. Con más tiempo, usaríamos algo como `ioredis-mock` para Redis
  y una base de datos de test dedicada para Prisma, de forma de poder
  testear esta lógica sin depender de infraestructura externa real.

- **El E2E cubre un solo camino feliz.** Solo testeamos login + creación
  exitosa de un viaje. No hay un E2E para, por ejemplo, el flujo completo de
  matching (que requiere simular dos conductores compitiendo por el mismo
  viaje vía WebSocket) ni para el cierre de un viaje con QR. Esos flujos sí
  están cubiertos por scripts de verificación manual más extensos que ya
  existían en el proyecto antes de este TP (`scripts/test-fase5.js`,
  `scripts/stress/`), pero no están integrados al pipeline de CI todavía.
  Es un riesgo consciente que aceptamos por el tiempo disponible.

- **El pipeline en sí tuvo varios fallos reales durante su construcción**,
  que quedaron resueltos a medida que aparecían: un `eslint.config.js` mal
  configurado que no reconocía globals estándar de Node (`Buffer`, `URL`,
  `fetch`) y marcaba quince líneas de código de producción como errores que
  en realidad no lo eran; dos casos reales de `no-useless-assignment`
  detectados por el lint (variables inicializadas con un valor que nunca se
  leía antes de ser reasignado) que sí corregimos porque eran código
  innecesario, aunque no afectaban el comportamiento; la dependencia
  `vitest` instalada localmente pero nunca guardada en `package.json`, lo
  cual hacía que `npm ci` —el comando que usa el pipeline para instalar de
  forma limpia y reproducible— no la instalara y el job fallara; y un
  `package-lock.json` que quedó desincronizado de `package.json` tras una
  reinstalación, que tuvimos que regenerar completamente. Ninguno de estos
  era un bug del negocio, pero todos hubieran impedido un deploy si no
  hubiéramos tenido el pipeline corriendo antes de mergear.

- **Ambos entornos comparten el mismo proyecto de Firebase.** Staging y
  production tienen bases de datos PostgreSQL y Redis completamente
  separadas, pero el proyecto de Firebase (autenticación) es uno solo. Esto
  significa que un mismo email no puede registrarse en los dos entornos a la
  vez. Para evitar esto usamos usuarios de prueba con emails dedicados solo
  para staging. Separar Firebase también en dos proyectos es la mejora
  arquitectónica correcta a largo plazo, pero no era necesaria para este TP.

## Nota sobre el equipo de trabajo

Este TP se realizó individualmente sobre el repositorio del backend de
Fleter. La consigna prevé equipos de dos personas con revisión cruzada de
Pull Requests; al trabajar solo, la revisión de cada PR fue una
autorrevisión — releer el diff completo, verificar que el check de CI
pasara, y confirmar que el cambio respondía exactamente al issue que
referenciaba, antes de aprobar el merge. La branch protection (PR
obligatorio + al menos 1 aprobación) se mantuvo igual de estricta que si
hubiera dos personas: no se mergeó nada directo a `main` ni a `develop` en
ningún momento del desarrollo.

## Uso de IA

Usamos Claude (vía la interfaz de chat y Claude Code) de forma extensiva
durante el desarrollo del backend, incluyendo la construcción de este mismo
pipeline de CI/CD. Documentamos acá ejemplos concretos y verificables, no
genéricos:

**Bug de race condition en el matching de viajes.** Un stress test diseñado
para reproducir el escenario de dos conductores aceptando el mismo viaje casi
simultáneamente reveló que ambos podían recibir la confirmación de
asignación, aunque la base de datos solo guardara un ganador real. La causa
era que la transacción original hacía una lectura (`findUnique`) seguida de
una escritura (`update`) sin que la lectura tomara un lock de fila, así que
dos transacciones concurrentes podían pasar la validación al mismo tiempo. El
fix —reemplazar esa secuencia por un `updateMany` con condición compuesta en
el `WHERE`, atómico a nivel de base de datos— se verificó corriendo el
escenario de competencia 10 veces consecutivas y exigiendo que en las 10
hubiera exactamente un ganador, antes de aceptar el cambio como resuelto.

**Bug de seguridad en el tracking GPS.** Encontramos que cualquier conductor
autenticado podía enviar coordenadas GPS para un viaje que no era el suyo,
porque el backend solo validaba el rol del usuario, no que fuera
específicamente el conductor asignado a ese viaje en particular. Se corrigió
agregando una verificación de propiedad antes de procesar cualquier
coordenada entrante, y se verificó simulando un conductor ajeno intentando
inyectar GPS en el viaje de otro, confirmando que el envío fuera rechazado y
que el conductor legítimo no se viera afectado.

**Leak de memoria con causa raíz distinta a la hipótesis inicial.** Un
reporte de stress testing sugería que el recálculo de ruta por desvío de
trayecto no se disparaba de forma confiable. Antes de tocar ese código,
pedimos diagnóstico con instrumentación (logging detallado) en lugar de
aplicar un fix basado en la sospecha original. El diagnóstico mostró que el
disparo del recálculo en realidad funcionaba correctamente el 100% de las
veces probadas; el problema real era que los emisores periódicos de tiempo
estimado de llegada (ETA) nunca se detenían cuando un viaje de prueba
quedaba inactivo, y esos emisores huérfanos contaminaban con datos de otros
viajes las pruebas siguientes. El fix correcto terminó siendo distinto al
que se había sospechado al principio, y solo se aplicó después de tener
evidencia concreta de la causa real.

**Construcción del propio pipeline de CI/CD.** Cada uno de los problemas
listados en la sección de limitaciones y deuda técnica (el ESLint mal
configurado, el `vitest` faltante, el lockfile desincronizado) fue
diagnosticado y corregido con asistencia de Claude, leyendo el mensaje de
error real que devolvía GitHub Actions o la terminal local, identificando la
causa, aplicando el fix mínimo necesario, y volviendo a correr la
verificación —nunca aplicando un cambio sin antes confirmar el síntoma exacto
y sin volver a correr la verificación después.

En todos los casos, ningún cambio generado o sugerido con asistencia de IA se
aceptó sin verificación automatizada posterior: cada fix se validó corriendo
los scripts de test correspondientes (y, en los casos más delicados, scripts
de stress testing diseñados específicamente para reproducir el bug de forma
repetible) antes de darlo por resuelto.
