# 🐛 Bug

Juego de cartas estilo UNO, multijugador y **peer-to-peer**: las cartas viajan directas de un
navegador a otro por WebRTC, sin servidor de juego. Hace falta un punto de encuentro para el primer
saludo (señalización); a partir de ahí, quien lo levantó deja de ser necesario para que la partida
siga.

**Imagen Docker:** [`sketox/bug`](https://hub.docker.com/r/sketox/bug) · un solo puerto, todo
incluido (web + señalización). Para jugar **no hace falta clonar nada**:

```bash
docker run --rm -e TUNNEL=1 sketox/bug      # saca un enlace público; el resto solo lo abren
```

### Dónde está cada cosa

| Si quieres… | Lee |
| --- | --- |
| **Jugar** una partida, hoy | **[`JUGAR.md`](JUGAR.md)** — la guía completa, paso a paso |
| Tocar el código | Este README, sección [Desarrollar](#2-desarrollar-node) |
| Ver cómo se prueba el sistema | [Verificación y Validación](#verificación-y-validación), abajo |
| El informe de entrega | [`docs/vv/Informe_Final-Bug_P2P.pdf`](docs/vv/Informe_Final-Bug_P2P.pdf) |
| Entender la arquitectura | [Arquitectura](#arquitectura), abajo |

---

## Cómo correr esto

Hay tres formas, según lo que quieras hacer. **La 1 es la que quieres si solo quieres jugar.**

| | Para qué | Necesitas |
| --- | --- | --- |
| [1. Docker](#1-jugar-docker) | Jugar, en la misma WiFi o entre casas | Docker |
| [2. Desarrollo](#2-desarrollar-node) | Tocar el código, con recarga en caliente | Node 20+ |
| [3. Tests](#3-tests) | Comprobar que nada se rompió | Node 20+ |

---

### 1. Jugar (Docker)

**Uno solo** levanta el contenedor y se convierte en el anfitrión. Los demás no instalan nada: abren
un enlace. No vale que cada uno levante el suyo — seríais dos personas esperando en dos tablones
distintos, sin veros nunca.

#### 1a. Misma WiFi

```bash
docker run --rm -p 7787:7787 sketox/bug
```

Deberías ver en consola:

```
[bug] escuchando en :7787  (web en /, señalización en /ws)
[bug] sin túnel. Misma WiFi: http://<tu-ip-local>:7787  ·  Otras redes: -e TUNNEL=1
```

**Paso a paso:**

1. **El anfitrión** abre `http://localhost:7787`, escribe su nombre y pulsa **Crear sala**.
   Aparece un código de 4 caracteres (`AB12`) y un QR.
2. **Averigua tu IP local** para pasársela a los demás:
   - Windows: `ipconfig` → busca *Dirección IPv4* (algo como `192.168.1.42`).
   - Linux/macOS: `ip -4 addr` o `ifconfig`.
3. **Los demás** abren `http://192.168.1.42:7787` (con TU IP), escriben su nombre, teclean el
   código y pulsan **Unirse**. O escanean el QR, que ya lleva la sala dentro.
4. Cuando haya **2 o más** jugadores, el anfitrión pulsa **¡Empezar!**.

> **Si el 7787 te lo pisa algo**, cambia solo el número de la izquierda: `-p 9000:7787`, y entonces
> la dirección es `http://<tu-ip>:9000`.

> **Los invitados ven "Application error" o no cargan.** Comprueba que abren tu **IP**, no
> `localhost` (que en su máquina apunta a ellos mismos), y que el firewall de Windows deja pasar el
> puerto. La primera vez que arranques, Windows preguntará: hay que decirle **Permitir** en redes
> privadas.

#### 1b. Casas distintas (hace falta un túnel)

Tu casa **no tiene dirección pública**: el router hace NAT y nadie de fuera puede llamar a tu
máquina. El túnel le presta una dirección pública mientras dure la partida, y viene dentro de la
imagen:

```bash
docker run --rm -e TUNNEL=1 sketox/bug
```

Fíjate que **no lleva `-p`**: el túnel habla con la web por dentro del contenedor, así que no
publica ningún puerto en tu máquina y no puede chocar con nada de lo que tengas corriendo.

A los pocos segundos aparece la invitación **en esa misma consola**:

```
┌─────────────────────────────────────────────────┐
│  https://algo-que-rima-random.trycloudflare.com  │
└─────────────────────────────────────────────────┘
  Esa es la invitación: quien abra ese enlace entra a jugar.
  No necesita Docker, ni el código, ni instalar nada.
```

Tarda entre 5 y 20 segundos; hasta entonces la consola parece parada, y es normal.

**Si lo lanzas en segundo plano** (`-d`), el enlace se pide con `docker logs`:

```bash
docker run -d --name bug --rm -e TUNNEL=1 sketox/bug
docker logs bug                             # el enlace sale aquí
docker logs bug | findstr trycloudflare     # solo esa línea (Windows)
docker rm -f bug                            # y así se para
```

**Paso a paso:**

1. **Abre tú esa URL**, pon tu nombre y **Crear sala**.
2. Pulsa **copiar enlace 🔗** y mándaselo a los demás (o enséñales el QR).
   Ese enlace lleva dentro **la sala y el punto de encuentro**:
   `https://…trycloudflare.com/?r=AB12&s=wss%3A%2F%2F…trycloudflare.com%2Fws`
3. Ellos lo abren y les sale *"te invitaron a la sala AB12"*: nombre → **Entrar a la sala**. No
   teclean código ni configuran nada.
4. Cuando estéis todos, **¡Empezar!**.

> **La URL caduca sola.** Los túneles gratuitos de Cloudflare se caen a las pocas horas sin avisar:
> el contenedor sigue sano y el juego funciona en `localhost`, pero la dirección pública deja de
> responder. Si va a haber público, levántalo poco antes. Se arregla parando y volviendo a lanzar
> — la URL nueva será otra.

> **Si sale "Error 1033" al abrir el enlace**, el túnel consiguió URL pero no conectó. El contenedor
> te lo dice por consola a los 30 segundos. Casi siempre es un firewall bloqueando la salida. Por
> aquí solo viajan la web y las presentaciones —las cartas van por WebRTC directo—, así que el túnel
> sale por TCP (`http2`) a propósito, que entra en más sitios que el QUIC de fábrica. Para volver al
> antiguo: `-e TUNNEL_PROTOCOL=quic`.

#### 1c. Compilar la imagen tú mismo

Si has tocado el código, la imagen de Docker Hub no lo tiene. Compila la tuya:

```bash
docker build -t bug:local .
docker run --rm -p 7787:7787 bug:local
```

Tarda unos minutos la primera vez (se descarga `node:20-alpine` y `cloudflared`). El resultado son
unos 198 MB.

---

### 2. Desarrollar (Node)

Monorepo con workspaces (`engine`, `net`, `signaling`, `web`). Requiere **Node 20 o superior**.

```bash
npm install
```

Hacen falta **dos terminales**, porque en desarrollo la web y la señalización viven en puertos
distintos (en el contenedor van juntas, por eso allí basta uno).

**Terminal 1 — la señalización:**

```bash
npm run signaling
```

```
[signaling] escuchando en :8787 (ws + http /health)
```

**Terminal 2 — la web:**

```bash
npm run web
```

```
▲ Next.js 14.2.35
- Local:        http://localhost:3000
✓ Ready in 33s
```

Abre `http://localhost:3000`. **No hace falta configurar nada**: en desarrollo la web ya busca la
señalización en `ws://localhost:8787`.

> La primera carga de una página tarda bastante (Next compila bajo demanda). Es normal; la segunda
> es instantánea.

**Para probar la red de verdad** necesitas al menos dos jugadores. Abre **dos ventanas** del
navegador (o una normal y otra de incógnito): cada pestaña es un jugador distinto, porque la
identidad se guarda en `sessionStorage`. En una, *Crear sala*; en la otra, el código → *Unirse*.

**Para probar desde el móvil** en la misma WiFi, hay que decirle a la web dónde está la señalización,
porque `localhost` en el móvil apunta al móvil:

```bash
cd web && cp .env.example .env.local
```

y en `web/.env.local` pon tu IP: `NEXT_PUBLIC_SIGNAL_URL=ws://192.168.1.42:8787`. Reinicia
`npm run web`. El móvil entra por `http://192.168.1.42:3000`.

**Otros comandos:**

```bash
npm run build     # build de producción de todos los paquetes
npm run art       # regenera el sprite de cartas desde los SVG de `art/`
```

**Modo local sin red:** en el menú hay un botón *practicar local (hot-seat)* que no necesita
señalización ni segundo jugador. Útil para probar reglas.

**Ventana de depuración:** en desarrollo, `window.__bug` expone la semilla, el log de eventos y el
estado. Con eso, una partida rota en el navegador **se reproduce en un test del motor** en vez de
adivinar. En producción no existe.

**Pantalla Maestra:** tecla `M` (o el botón *🖥 malla*) durante la partida. Muestra salud de cada
nodo, líder, testigo de turno y huella de estado — es donde se ve la parte distribuida funcionando.

---

### 3. Tests

```bash
npm test
```

**194 tests unitarios** repartidos así:

| Paquete | Tests | Qué cubre |
| --- | --- | --- |
| `engine` | 74 | reglas, determinismo, casos límite de cada carta |
| `net` | 60 | Lamport, replicación, testigo, Bully, reconexión, **señalización por la malla** |
| `signaling` | 27 | aforo, introductores, guardas y sondeo de salud, contra el servidor de verdad |
| `web` | 33 | resolución de señalización, identidades, sprite, efectos |

Para un paquete suelto: `npm test --workspace @bug/net`.

Pero eso es solo la base de la pirámide. El bloque completo son **234 comprobaciones** y está en la
sección siguiente.

---

## Verificación y Validación

El proyecto integra la cátedra de *Gestión para la V&V*, así que además de las pruebas unitarias hay
análisis estático, integración continua, pruebas en navegador, pruebas de seguridad y un banco de
validación distribuida. **234 comprobaciones automatizadas**, todas en el mismo pipeline.

| Capa | Nº | Con qué | Qué responde |
| --- | --- | --- | --- |
| Unitarias | 194 | Vitest | ¿el motor y los algoritmos hacen lo que dicen? |
| Funcionales | 22 | Cypress | ¿se puede jugar? ¿convergen **tres nodos con WebRTC real**? ¿y **diez**? |
| Seguridad | 11 | Burp Suite + banco propio | ¿aguanta que le mientan? |
| Distribuida | 7 | Banco propio con métricas | ¿siguen todos de acuerdo cuando la red va mal? |
| Estática | — | SonarQube | ¿qué hay mal en el código que nadie ejecuta? |

### Ejecutarlo todo

```bash
npm ci

npm run typecheck          # tipos en los 4 paquetes Y en cypress/
npm run test:coverage      # 194 unitarias + el lcov combinado
npm run vv:security        # 11 ataques contra la señalización real
npm run vv:distributed     # 7 propiedades distribuidas, con métricas
npm run e2e                # levanta el stack y corre las 22 de Cypress
```

Los informes JUnit solo se generan con `CI=true` (`CI=true npm run test:coverage`), que es como los
produce el pipeline.

### El laboratorio de calidad (SonarQube + Jenkins)

```bash
docker compose -f vv/docker-compose.yml up -d      # SonarQube :9000 · Jenkins :8080
node vv/setup.mjs                                  # genera el token y lo deja en vv/.env
docker compose -f vv/docker-compose.yml up -d --build jenkins
```

Jenkins entra con `admin` / `bug-vv`. El job **se dispara con cada commit** de `main` (sondea el
repositorio cada minuto) y corre siete etapas: dependencias → tipos → pruebas y cobertura → build →
SonarQube → seguridad → validación distribuida.

Para apagarlo cuando no se use:

```bash
docker compose -f vv/docker-compose.yml stop       # apaga y conserva todo
```

Usa `stop`, **no `down`**: `down` borra los contenedores y con ellos el historial de construcciones
de Jenkins y los análisis de SonarQube, que son parte de la evidencia.

### Verlo todo de una vez

```bash
npm run vv:ver
```

Abre la presentación, el informe de pruebas, la carpeta de capturas y los paneles de Jenkins y
SonarQube. Lo que no esté generado o no responda, lo dice y explica cómo conseguirlo.

### Los entregables

```bash
npm run vv:entregables     # informe de pruebas + presentación
npm run vv:informe-final   # el documento de entrega (.docx) desde la plantilla de la asignatura
```

| Documento | Qué es |
| --- | --- |
| [`docs/vv/Informe_Final-Bug_P2P.pdf`](docs/vv/Informe_Final-Bug_P2P.pdf) · [`.docx`](docs/vv/informe-final.docx) | **El documento de entrega**: informe, métricas y evidencias en un solo archivo, con el formato de la asignatura |
| [`docs/vv/presentacion.html`](docs/vv/presentacion.html) · [`.pdf`](docs/vv/presentacion.pdf) · [`.md`](docs/vv/presentacion.md) | La presentación de defensa: el juego, cómo está hecho y cómo se prueba |
| [`docs/vv/informe-pruebas.html`](docs/vv/informe-pruebas.html) · [`.pdf`](docs/vv/informe-pruebas.pdf) | Las 234 comprobaciones, **una a una**, con su nombre y su resultado |
| [`docs/vv/guia-de-pruebas.md`](docs/vv/guia-de-pruebas.md) | Cómo se ejecuta todo **y por qué cada herramienta** |
| [`docs/vv/reporte-final.md`](docs/vv/reporte-final.md) | El reporte técnico: métricas, hallazgos y mejoras |
| [`docs/vv/plan-vv.md`](docs/vv/plan-vv.md) | Plan de V&V: alcance, estrategia y criterios de aceptación |
| [`docs/vv/matriz-trazabilidad.md`](docs/vv/matriz-trazabilidad.md) | De cada requisito a la prueba que lo vigila |
| [`docs/vv/seguridad-burp.md`](docs/vv/seguridad-burp.md) | Cómo reproducir los 11 ataques a mano |
| `docs/vv/evidencias/` | Capturas del juego (las genera Cypress) y de los paneles |

Ni el informe ni la presentación se escriben a mano: salen de los artefactos de la última ejecución
—los JUnit, el `lcov` y los JSON de los bancos—, así que **no pueden decir que pasó algo que no
pasó**.

```bash
npm run vv:evidencias      # ¿están las 21 capturas? Si falta alguna, dice cuál y cómo se saca
```

Merece la pena antes de commitear: Cypress **vacía** `docs/vv/evidencias/cypress/` al empezar cada
ejecución, así que correr un solo *spec* deja únicamente las suyas — y un `git add -A` después borra
las demás del repositorio sin que se note.

### Resultados de la última ejecución

| | |
| --- | --- |
| Pruebas | 234 · **0 fallos** |
| SonarQube | *quality gate* **Passed** · 0 bugs · 89 % de cobertura · 1,3 % de duplicación |
| Jenkins | **7/7 etapas** en verde, 7,2 min, disparado por commit |
| Seguridad | **11/11 ataques bloqueados** · 6 vulnerabilidades encontradas y corregidas |
| Distribuida | **7/7 propiedades** verificadas |

Y el dato que más dice del proceso: de los **17 defectos** encontrados, **11 eran invisibles para una
prueba unitaria**. Salieron jugando en un navegador de verdad, atacando el servidor a mano o
montando el propio control de calidad.

---

## Reglas (v1)

- Mazo de **124 cartas**, en 4 palos (Código, Hardware, Internet, Café). Por cada palo: números 0-9,
  dos "Se fue el WiFi", dos "Ctrl+Z", un "Update de Windows +2", un "Update de Windows +4" y una de
  cada **Carta de Caos** (Copiar y Pegar, Apagar y prender, Derrame de Café, Virus Troyano).
- **Sin color solo los 2 comodines** (Reinicio de Router y BSOD): son los únicos que se tiran sobre
  cualquier carta y dejan elegir color. Todo lo demás —el caos incluido— hay que jugarlo igualando
  el pozo.
- Cada jugador empieza con 7 cartas. En tu turno: juega una carta que coincida en color, número o
  símbolo, o roba. Gana quien se queda sin cartas.
- Máximo **10 jugadores** por sala.

---

## Arquitectura

- **`engine/`** — motor de reglas puro (sin red ni UI), testeado de forma aislada.
- **`net/`** — capa P2P: malla WebRTC, protocolo de mensajes, replicación de estado.
- **`signaling/`** — servidor de señalización (WebSocket). Presenta a los peers y se aparta.
- **`web/`** — la interfaz (Next.js).
- **`docker/`** — junta web y señalización en un único puerto.

### Estado replicado, no un anfitrión con la verdad

**No hay un nodo dueño de la partida.** Todos los navegadores tienen el motor completo, parten de la
misma semilla y aplican el mismo log de eventos ordenado por Lamport, así que todos convergen al
mismo estado por su cuenta. Lo que circula por la red son **eventos, no estado**: nadie te manda una
partida que tengas que creerte, te mandan las jugadas y tú las validas con tu propio motor.

El líder es un cargo reemplazable (elección de Bully) con tres tareas de fontanería —atender al que
se reconecta, regenerar el testigo de turno si se pierde, y forzar el fin del turno de quien no
juega— y **ninguna toca las reglas**.

Por eso existen Lamport, el testigo de turno, la elección de líder y la reparación de divergencias:
con un servidor de juego nada de eso haría falta, porque solo habría una verdad. **Que un nodo pueda
divergir es la prueba de que no hay una verdad central.**

### La señalización se encoge al primer contacto

El servidor de señalización no reparte el censo de la sala: presenta **un solo** peer (el
*introductor*) y se aparta. Ese único saludo pasa por él; las presentaciones con el resto de la mesa
viajan **por los DataChannels ya abiertos**, retransmitidas por los propios jugadores.

Medido: con tres jugadores dentro, el cuarto genera **2 mensajes** en el servidor en vez de 6. Y si
el servidor muere justo después del primer contacto, el recién llegado **completa su malla igual**.

El primer contacto sigue necesitándolo, y eso no tiene arreglo: dos máquinas que no se conocen no
pueden encontrarse solas. Es el mismo problema de *bootstrap* que resuelven los trackers de
BitTorrent, las semillas DNS de Bitcoin o los nodos bootstrap de IPFS.

→ Detalle completo en [`docs/senalizacion-por-la-malla.md`](docs/senalizacion-por-la-malla.md).

### Qué hay detrás de un solo puerto

| Ruta | Qué es |
| --- | --- |
| `/` | La web del juego (Next.js) |
| `/ws` | La señalización (WebSocket) |
| `/health` | `bug ok` |

Van juntas **a propósito**: así el navegador deduce la señalización de su propio origen y la imagen
funciona en cualquier URL sin rehacer el build — que es lo que permite que el túnel, cuya dirección
no existe hasta que se abre, funcione sin configurar nada.

---

## Si no conecta

WebRTC atraviesa la mayoría de routers domésticos con STUN (ya viene configurado), pero **no todos**:
NAT simétrico, algunas redes universitarias y algunos datos móviles lo bloquean. Ahí hace falta un
**TURN**, que es un relay de respaldo. Se configura por variables de entorno, sin tocar la imagen:

```bash
docker run --rm -p 7787:7787 \
  -e NEXT_PUBLIC_TURN_URL=turn:tu-servidor:3478 \
  -e NEXT_PUBLIC_TURN_USERNAME=usuario \
  -e NEXT_PUBLIC_TURN_CREDENTIAL=clave \
  sketox/bug
```

Hay capas gratuitas suficientes para una partida (Metered, Cloudflare).