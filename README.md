# Silunet

**Juego de adivinanza en tiempo real sobre un clúster distribuido de tres backends replicados.**

Proyecto integrador de **Sistemas Distribuidos** y **Gestión para la Verificación y
Validación de Software** — PUCE Sede Manabí, Ingeniería de Software.

Diseñado para la feria "Casa Abierta": el público escanea un QR con su celular, se une
sin instalar nada, y una pantalla proyectada muestra el estado de la partida en vivo.

> Este README documenta **el sistema tal como está construido**.
>
> Para estudiarlo desde cero y preparar la defensa de la caída del host, seguir la
> **[ruta progresiva de conceptos](docs/conceptos/README.md)**.

---

## Tabla de contenidos

1. [Funcionamiento general](#1-funcionamiento-general)
2. [Arquitectura técnica](#2-arquitectura-técnica)
3. [Diagramas](#3-diagramas)
4. [Base de datos](#4-base-de-datos)
5. [Metodología de desarrollo](#5-metodología-de-desarrollo)
6. [Guía detallada de despliegue](#6-guía-detallada-de-despliegue)
7. [Verificación y Validación](#7-verificación-y-validación)
8. [Estructura del repositorio](#8-estructura-del-repositorio)

---

## 1. Funcionamiento general

### Ciclo de una partida

1. El operador pulsa **"Iniciar partida"** en la pantalla proyectada (`/master`).
2. Se abre una **votación de 8 segundos**: cada celular elige una **temática**
   (Computadores, Redes, Animales, Comida…) y una **dificultad** (Fácil / Intermedio /
   Difícil). Gana lo más votado; los empates y la ausencia de votos se resuelven al azar,
   de modo que la partida nunca se traba esperando.
3. **Cuenta regresiva "3, 2, 1, ¡YA!"** emitida por el servidor, sincronizada para todos.
4. Aparece la silueta + la palabra oculta con guiones (`_ E _ A _ T E`). Cada **4 s** sin
   acierto se revela una letra adicional. En modo Clásico, la primera ronda
   dura **25 s** y cada palabra superada resta 3 s, hasta un mínimo de **5 s**.
5. A los **5 s** se desbloquea una **pista** opcional: usarla reduce la recompensa de esa
   ronda al **80 %**.
6. Al cerrar todas las rondas: ranking con medallas (oro/plata/bronce) y actualización del
   **salón de la fama** histórico.

### Puntaje: por posición lógica, no por tiempo

Es el detalle que ancla el juego a la teoría de la materia. El puntaje **no** depende de
los milisegundos que tardaste ni de la latencia de tu Wi-Fi, sino de tu **posición en el
orden lógico de Lamport** resuelto por el coordinador:

```
puntos = 100 + 900 × (1 − (posición − 1) / N)
```

con `N` = total de aciertos de la ronda. El primero en orden lógico obtiene 1000; el
último tiende a 100. Así un celular con mala señal no queda castigado por la red, solo
por el orden causal real de los eventos.

### Banco de palabras

**8 temáticas × 20 palabras = 160**, en `src/wordBank.ts`:

`Computadores` · `Redes` · `Dispositivos` · `Almacenamiento` · `Animales` · `Comida` ·
`Transporte` · `Instrumentos`

La **dificultad se deriva del largo** de la palabra (no se anota a mano, así no puede
desincronizarse): ≤5 letras = fácil, 6-8 = intermedio, 9+ = difícil. Cada temática tiene
~6 fáciles, ~8 intermedias y ~6 difíciles, para que cualquier combinación votada tenga
suficientes rondas disponibles.

Las siluetas son SVG dibujados con formas geométricas simples y `fill="currentColor"`
(sin imágenes externas ni CDN). Para ilustrar una palabra nueva basta agregar su constante
SVG y sumarla al mapa `ART`.

### Otras funcionalidades

| Función | Descripción |
|---|---|
| **Reconexión automática** | Si el nodo de un celular (o de la pantalla proyectada) cae, rota solo al siguiente nodo vivo conservando el puntaje de la partida en curso. |
| **Panel didáctico** | En `/master`: reloj de Lamport en vivo, cola del candado y estado de la elección Bully, para que los ejes se **vean** funcionando durante la defensa. |
| **Salón de la fama** | Ranking histórico acumulado de todas las partidas jugadas. |
| **Identidad persistente** | Token guardado en el celular: reconoce al jugador que vuelve sin pedirle registro. |
| **Sonidos** | Sintetizados con Web Audio API — sin archivos ni CDN, porque la LAN de la feria no tiene internet. |
| **Avatares** | Formas predeterminadas o foto personal desde cámara/galería; visibles en perfil y rankings. La foto se reduce a 256×256 antes de guardarse. |

---

## 2. Arquitectura técnica

### Stack

- **Backends simétricos:** el mismo Node.js + TypeScript se ejecuta en tres dispositivos.
  Un líder procesa acciones y dos seguidores mantienen réplicas durables.
- **Clientes:** los navegadores son clientes WebSocket; nunca se convierten en servidor
  ni ejecutan el motor autoritativo durante una caída.
- **Frontend:** HTML + CSS + JavaScript plano, sin proceso de build.
- **Estado vivo durable:** snapshot atómico por nodo, término e índice de commit.
- **Persistencia histórica:** PostgreSQL mediante `pg`, o SQLite local. La historia no
  participa en el camino crítico del failover del juego.

### Decisión de diseño clave: la base histórica no reemplaza el estado distribuido

El líder serializa la acción, escribe el snapshot en su disco y lo envía a los seguidores.
Solo después de recibir ACK durable de al menos 2 de 3 nodos empuja el evento a los
navegadores. Si el líder cae, los dos supervivientes conservan mayoría, eligen sucesor,
comparan sus réplicas y reanudan el motor desde disco. PostgreSQL guarda identidad e
historia, pero no decide la continuidad de la partida.

### Los 4 ejes: dónde vive cada uno

| Eje | Mecanismo | Implementación |
|---|---|---|
| **1 · Comunicación bidireccional y concurrencia** | WebSocket persistente cliente-backend y backend-backend; sin polling HTTP. | `src/server.ts`, `src/cluster.ts` |
| **2 · Sincronización y ordenamiento lógico** | Relojes de Lamport (`tick` / `update` / `merge`) ordenan los aciertos entre nodos. | `src/lamport.ts` |
| **3 · Exclusión mutua y consistencia** | Candado lógico con cola FIFO que serializa el acceso al marcador compartido. | `src/mutex.ts` |
| **4 · Tolerancia a fallos y reconfiguración** | Réplicas durables 2/3 + heartbeats + términos + elección Bully + recuperación desde disco. | `src/cluster.ts`, `src/replicaStore.ts` |

### Protocolo de mensajes

Todo el protocolo está tipado en `src/types.ts`, separado en tres familias:

- **`S2C`** — servidor → cliente (`ROUND_START`, `TICK`, `CORRECT_ANSWER`, `VOTE_TALLY`,
  `CLUSTER_STATE`, `ENGINE_STATE`…)
- **`C2S`** — cliente → servidor (`JOIN`, `GUESS`, `CAST_VOTE`, `PING`…)
- **`N2N`** — nodo ↔ nodo (`N_HEARTBEAT`, `N_REPLICATE`, `N_ELECTION`, `N_ALIVE`,
  `N_COORDINATOR`, `N_FORWARD_*`…)
- **Telemetría P2P opcional** — los DataChannels observan conectividad, pero no procesan
  acciones ni reemplazan al backend.

Un jugador conectado a un **seguidor** no nota diferencia: el seguidor reenvía su acción
al coordinador (`N_FORWARD_GUESS`) y la respuesta vuelve enrutada a su conexión exacta
(`N_SEND_TO`).

### Roles durante la prueba de fuego

Uno de los tres procesos Node es coordinador. Los otros dos son réplicas elegibles y los
navegadores no lo son. Cuando cae el coordinador, los backends con quorum ejecutan Bully,
recuperan la mayor réplica durable y cercan al líder anterior mediante un término nuevo.

---

## 3. Diagramas

### Arquitectura de despliegue en el stand

```mermaid
flowchart TB
    C[Celulares /play] <-->|WebSocket persistente| N1
    M[Pantalla /master] <-->|WebSocket persistente| N2
    subgraph CL[Clúster de tres backends]
      N1[Node 1 · líder o seguidor]
      N2[Node 2 · líder o seguidor]
      N3[Node 3 · líder o seguidor]
      N1 <-->|N2N + heartbeat| N2
      N2 <-->|N2N + heartbeat| N3
      N1 <-->|N2N + heartbeat| N3
    end
    N1 --> D1[(réplica durable 1)]
    N2 --> D2[(réplica durable 2)]
    N3 --> D3[(réplica durable 3)]
```

<!-- Diagrama histórico P2P sustituido:
```mermaid
flowchart TB
    subgraph LAN["LAN cerrada del stand · router/AP propio"]
        H["💻 Laptop host<br/>Node.js + HTTP/WebSocket<br/>juego inicial y señalización"]
        M["🖥️ /master<br/>observador P2P no elegible"]
        C1["📱 Jugador A<br/>réplica + recursos cacheados"]
        C2["📱 Jugador B<br/>réplica + recursos cacheados"]
        C3["📱 Jugadores C…E<br/>réplica + recursos cacheados"]
    end

    H -->|"Bootstrap, P2P_SNAPSHOT y señalización"| M
    H -->|"Bootstrap, P2P_SNAPSHOT y señalización"| C1
    H -->|"Bootstrap, P2P_SNAPSHOT y señalización"| C2
    H -->|"Bootstrap, P2P_SNAPSHOT y señalización"| C3
    C1 <-->|"WebRTC DataChannel"| C2
    C2 <-->|"WebRTC DataChannel"| C3
    C1 <-->|"WebRTC DataChannel"| C3
    M <-.->|"WebRTC · solo observa"| C1
    M <-.->|"WebRTC · solo observa"| C2

    DB[("PostgreSQL / SQLite<br/>solo historia cerrada")]
    H -.->|"fuera del camino crítico"| DB

    C1 & C2 & C3 -.-> E["Caída del host<br/>elección Bully entre jugadores"]
    E --> L["Nuevo líder ejecuta Clásico<br/>desde el snapshot local"]
    L --> O["GAME + STATE por DataChannel<br/>sin HTTP ni base de datos"]
```

-->

### Dos aciertos concurrentes: Lamport + exclusión mutua

```mermaid
sequenceDiagram
    participant A as 📱 Ana
    participant B as 📱 Beto
    participant H as 💻 Backend líder

    Note over A,B: Ambos envían la respuesta correcta casi a la vez
    A->>H: GUESS "ROUTER" (L_cli=7)
    B->>H: GUESS "ROUTER" (L_cli=5)

    Note over H: Eje 3 · mutex FIFO del marcador
    H->>H: 🔒 runExclusive(Ana)
    H->>H: Eje 2 · L = max(local, 7) + 1 = 12
    H->>H: registra a Ana en posición lógica #1
    H->>H: 🔓 libera y atiende al siguiente

    H->>H: 🔒 runExclusive(Beto)
    H->>H: Eje 2 · L = max(12, 5) + 1 = 13
    H->>H: registra a Beto en posición lógica #2
    H->>H: 🔓 libera

    Note over H: Al cerrar: puntos = 100 + 900 × (1 − (posición − 1) / N)
    H-->>A: ROUND_END (Ana #1 → 1000 pts, L=12)
    H-->>B: ROUND_END (Beto #2 → 550 pts, L=13)
```

### Caída del backend líder: réplica durable y algoritmo del Matón

```mermaid
sequenceDiagram
    participant L as Backend líder
    participant R2 as Réplica 2
    participant R3 as Réplica 3
    participant C as Celular

    C->>L: acción + Lamport + stateVersion
    L->>L: mutex FIFO + fsync local
    L->>R2: N_REPLICATE(term, index, snapshot)
    L->>R3: N_REPLICATE(term, index, snapshot)
    R2-->>L: N_REPLICATE_ACK
    L-->>C: evento confirmado por quorum 2/3
    Note over L: caída del proceso o de la red
    R2<<->>R3: heartbeats ausentes + elección Bully
    R3->>R2: solicita réplicas durables
    R3->>R3: restaura mayor (term,index)
    R3-->>C: WebSocket reconectado + siguiente TICK
```

<!-- Secuencia histórica P2P sustituida:

```mermaid
sequenceDiagram
    participant H as 💻 Laptop host
    participant A as 📱 Jugador A
    participant B as 📱 Jugador B (ID P2P mayor)

    H-->>A: P2P_SNAPSHOT + recursos de la partida
    H-->>B: P2P_SNAPSHOT + recursos de la partida
    A<<->>B: WebRTC DataChannel abierto

    loop cada 1000 ms
        A-->>B: HEARTBEAT · serverAlive=true
        B-->>A: HEARTBEAT · serverAlive=true
    end

    Note over H: 💀 se apaga o pierde la red
    Note over A,B: WebSocket cerrado o sin host por más de 3,2 s
    A-->>B: HEARTBEAT · serverAlive=false
    B-->>A: HEARTBEAT · serverAlive=false
    Note over A,B: tras 1,2 s de gracia y mayoría,<br/>ambos eligen el jugador con ID P2P mayor
    B-->>A: LEADER B
    B->>B: startEngine(snapshot local)

    A->>B: ACTION · GUESS "ROUTER" (Lamport)
    B-->>A: GAME · CORRECT_ANSWER / TICK / ROUND_END
    B-->>A: STATE · snapshot convergente
    Note over A,B: Clásico continúa sin HTTP ni PostgreSQL.<br/>Usa la caché local y rondas de 25, 22, 19… hasta 5 s.
```

-->

### Modelo de datos

```mermaid
erDiagram
    JUGADORES ||--o{ PARTICIPACIONES : "juega"
    PARTIDAS  ||--o{ PARTICIPACIONES : "registra"

    JUGADORES {
        UUID    token PK "guardado en el celular"
        TEXT    nick
        TIMESTAMPTZ creado_en
        SMALLINT avatar_id
        UUID avatar_key UK "clave pública opcional"
        TEXT avatar_mime "image/jpeg"
        BYTEA avatar_data "foto reducida, máximo 200 KB"
    }
    PARTIDAS {
        UUID    id PK
        BIGINT  numero UK
        TEXT    nombre "ej. Casa Abierta #3"
        TEXT    modo "clasico|relajo|silustack"
        INTEGER total_rondas
        TIMESTAMPTZ jugada_en
    }
    PARTICIPACIONES {
        UUID jugador_token PK,FK
        UUID partida_id PK,FK
        INTEGER puntos
        INTEGER puesto "1 = ganó"
        TEXT    medalla "oro|plata|bronce|NULL"
    }
    CLUSTER_LEADER {
        TEXT cluster_id PK "solo clúster Node opcional"
        TEXT node_id
        BIGINT term "fencing token"
        TIMESTAMPTZ lease_until
        TIMESTAMPTZ updated_at
    }
```

> Los diagramas renderizados en PNG para el reporte impreso están en
> [`docs/diagrams/`](docs/diagrams/), junto al reporte arquitectónico en HTML.

---

## 4. Base de datos

El esquema completo y comentado está en **[`BDD.sql`](BDD.sql)**.

- **Motor:** PostgreSQL 16 recomendado, compartido por los tres nodos mediante la misma
  variable `DATABASE_URL`.
- **Migración automática:** al arrancar, `src/postgres.ts` aplica [`BDD.sql`](BDD.sql) de
  forma idempotente. Un bloqueo asesor serializa el DDL cuando los tres nodos arrancan a
  la vez.
- **Desarrollo local:** [`compose.yaml`](compose.yaml) levanta PostgreSQL con Docker. Si
  no se define `DATABASE_URL`, se usa SQLite como compatibilidad local y se muestra una
  advertencia; ese modo no garantiza historial consistente en un clúster.
- **Alcance:** solo guarda **historia ya cerrada** (identidades y resultados de partidas
  terminadas). El estado vivo nunca toca la base.
- **Regla distribuida:** solo el **coordinador electo** escribe. PostgreSQL mantiene una
  concesión (*lease*) con término de cercado: un líder anterior no puede seguir
  escribiendo durante un cambio de coordinador o un escenario de *split-brain*.
- **Cierre íntegro:** partida y participaciones se guardan en una transacción. Cada partida
  lleva un UUID replicado, por lo que un reintento tras un failover es idempotente.
- Las estadísticas (partidas ganadas, puntos totales, medallero) **se calculan** con
  consultas agregadas, no se almacenan — así no pueden quedar desincronizadas.

---

## 5. Metodología de desarrollo

> **⚠️ Sección a completar por el equipo.** No la redacté por ustedes porque describe el
> proceso real del grupo (herramienta de gestión, ceremonias, reparto de tareas) y no es
> algo que se pueda inferir del código sin inventarlo. Abajo queda la plantilla con lo
> que la rúbrica pide y lo que sí es verificable desde el repositorio.

**Metodología elegida:** _(ej. Scrum / Kanban / XP)_ — justificar en 2-3 líneas por qué se
eligió para un proyecto de este tamaño y duración.

**Herramienta de gestión:** _(Jira / Trello / GitHub Projects)_ — enlace al tablero.

**Organización del trabajo:**

| Aspecto | Detalle |
|---|---|
| Duración de iteración | _(ej. sprints de 1 semana)_ |
| Ceremonias | _(daily, revisión, retro…)_ |
| Definición de "terminado" | _(ej. compila + bots de V&V en verde + revisado por otro integrante)_ |
| Reparto de responsabilidades | _(quién llevó cada eje / frontend / V&V)_ |

**Trazabilidad en el repositorio** (esto sí es verificable y conviene mencionarlo):

- Los commits que implementan un eje lo declaran explícitamente en el mensaje
  (`"Eje 3: exclusion mutua explicita (candado FIFO)"`), de modo que el historial de git
  sirve como evidencia directa frente a la rúbrica.
- El desarrollo fue **incremental y verificable**: primero el juego jugable en un solo
  nodo, y solo después la partición en 3 nodos y cada eje por separado.
  `git log --oneline` muestra esa progresión.

---

## 6. Guía detallada de despliegue
> **Ruta Docker recomendada:** [`docs/DESPLIEGUE-DOCKER.md`](docs/DESPLIEGUE-DOCKER.md)
> permite levantar el cluster completo con gateway y PostgreSQL usando:
>
> ```powershell
> .\scripts\docker-cluster.ps1 up
> ```
>
> La misma guia explica el despliegue de un nodo Docker en cada laptop y el tunel publico opcional.


### 6.1. Requisitos previos

| Requisito | Detalle |
|---|---|
| **Node.js 22 o superior** | Obligatorio para compilar/ejecutar y para el respaldo SQLite de desarrollo. Verificar con `node --version`. |
| **PostgreSQL 16+** | Recomendado para el clúster. Puede ser una instancia administrada o Docker; debe ser accesible desde los tres nodos. |
| Docker Desktop | Opcional: facilita levantar PostgreSQL local con `docker compose up -d postgres`. |
| Git | Solo para clonar el repositorio. |
| Navegador moderno | En los celulares y en la laptop del proyector. |

No hace falta Redis ni un servidor web adicional. Para el historial consistente sí hace
falta PostgreSQL compartido.

### 6.2. Instalación

```bash
git clone <URL-del-repositorio>
cd silunet
npm install      # descarga ws + TypeScript (una sola vez)
npm run build    # compila TypeScript a dist/

# PostgreSQL local de desarrollo (opcional)
docker compose up -d postgres
```

Con el contenedor local, la URL es
`postgresql://silunet:silunet_dev@localhost:5432/silunet`. Es una credencial exclusiva
de desarrollo; no debe reutilizarse en producción.

### 6.3. Modo A — Un solo nodo (prueba rápida del juego)

```bash
npm run dev      # compila y arranca en un paso
```

Al arrancar imprime en consola la IP y las URLs. Abrir:

- **Pantalla proyectada:** http://localhost:3001/master → pulsar "Iniciar partida"
- **Jugador:** http://localhost:3001/join → abrir 2-3 pestañas con nicks distintos para
  ver la concurrencia.

### 6.4. Modo B — Clúster de 3 nodos en UNA laptop (desarrollo y defensa)

Es **el mismo código** ejecutado tres veces con variables de entorno distintas. Abrir
**tres terminales** en la carpeta del proyecto:

**PowerShell (Windows):**

En cada terminal, definir primero la **misma** conexión:

```powershell
$env:DATABASE_URL="postgresql://silunet:silunet_dev@localhost:5432/silunet"
```

```powershell
# Terminal 1 — coordinador inicial
$env:NODE_ID="node1"; $env:PORT="3001"; $env:COORDINATOR_ID="node1"; $env:PEERS="ws://localhost:3002,ws://localhost:3003"; node dist/server.js

# Terminal 2
$env:NODE_ID="node2"; $env:PORT="3002"; $env:COORDINATOR_ID="node1"; $env:PEERS="ws://localhost:3001,ws://localhost:3003"; node dist/server.js

# Terminal 3
$env:NODE_ID="node3"; $env:PORT="3003"; $env:COORDINATOR_ID="node1"; $env:PEERS="ws://localhost:3001,ws://localhost:3002"; node dist/server.js
```

**Bash (Linux / macOS):**

Exportar una sola vez en cada terminal:

```bash
export DATABASE_URL='postgresql://silunet:silunet_dev@localhost:5432/silunet'
```

```bash
NODE_ID=node1 PORT=3001 COORDINATOR_ID=node1 PEERS=ws://localhost:3002,ws://localhost:3003 node dist/server.js
NODE_ID=node2 PORT=3002 COORDINATOR_ID=node1 PEERS=ws://localhost:3001,ws://localhost:3003 node dist/server.js
NODE_ID=node3 PORT=3003 COORDINATOR_ID=node1 PEERS=ws://localhost:3001,ws://localhost:3002 node dist/server.js
```

Cuando los tres estén arriba, cada consola muestra `✓ Peer listo: nodeX`. Los jugadores
pueden entrar por **cualquiera** de los tres puertos y compiten sobre el mismo marcador.

### 6.5. Modo C — Despliegue distribuido real en 3 laptops

Las tres laptops deben tener el repositorio compilado, IP reservada en el router y el
puerto 3001 permitido en el firewall. Ejemplo: `192.168.1.11`, `.12` y `.13`.

En **node1**:

```powershell
$env:PEERS='ws://192.168.1.12:3001,ws://192.168.1.13:3001'
$env:PUBLIC_NODES='http://192.168.1.11:3001,http://192.168.1.12:3001,http://192.168.1.13:3001'
.\scripts\node1.ps1
```

En **node2** se usan como peers `.11` y `.13`, y se ejecuta `node2.ps1`. En **node3**
se usan `.11` y `.12`, y se ejecuta `node3.ps1`. `PUBLIC_NODES` es idéntico en los tres.

Los celulares abren cualquiera de las tres direcciones `/join`; la pantalla abre
`/master`. Si el backend conectado deja de responder PING/PONG durante 2 s, el navegador
rota a la siguiente dirección. El líder nuevo solo reanuda cuando conserva quorum 2/3.

### 6.6. Verificar el despliegue

`/api/info` debe mostrar `quorumAvailable: true`, `quorumRequired: 2` y un
`replicaIndex` creciente en los tres dispositivos.

### 6.7. Prueba de fuego

Con una partida activa, apagar el proceso o desconectar de la LAN solamente al líder.
Los otros dos servidores eligen sucesor, recuperan el snapshot durable y continúan. Para
provocar otra caída primero se reintegra el nodo anterior; una única réplica no puede
seguir escribiendo porque perdería consistencia estricta.

```powershell
npm run vv:caos
```

<!-- Documentación histórica de la implementación P2P sustituida:

**Red.** Llevar un **router/AP propio**, no usar la red del recinto (suele tener
*AP isolation* o puertos bloqueados, lo que rompe el juego). No necesita salida a
internet: todo el sistema funciona en LAN cerrada.

Lista de verificación de red:

- [ ] **Desactivar "AP / Client Isolation"** en el router. Es la falla más común: los
      celulares se conectan al Wi-Fi pero no pueden hablarle a las laptops.
- [ ] **Reservar IP fija** para la laptop host, para que el QR no cambie.
- [ ] **Permitir el puerto 3001** en el firewall de la laptop.
- [ ] **Banda:** 5 GHz aguanta mejor la concurrencia; 2.4 GHz tiene más alcance pero se
      satura con muchos celulares.
- [ ] Usar **entre 2 y 5 jugadores**. Cinco jugadores producen solo 10 enlaces directos.
- [ ] La laptop **no debe ser el hotspot**: si apaga la red física, WebRTC tampoco puede
      continuar. El router/AP debe seguir encendido durante la prueba.

```powershell
npm run build
./scripts/node1.ps1
```

Abrir `http://IP-DE-LA-LAPTOP:3001/master` y compartir
`http://IP-DE-LA-LAPTOP:3001/join`. Antes de iniciar Clásico, esperar que todos los
jugadores hayan entrado y que **cada celular muestre "Respaldo P2P listo entre
jugadores"**. Al comenzar la partida también debe aparecer **"Partida offline lista ·
imágenes guardadas en este celular"**; ese segundo aviso confirma que las siluetas y
revelaciones futuras ya no dependen del servidor. Si alguno no aparece, no ejecutar la
prueba: revisar *AP/Client Isolation*, el firewall y que los celulares estén realmente
en la misma LAN.

La continuidad P2P cubre **modo Clásico**. Relajo y SiluStack todavía requieren el host.
Durante una caída no entran jugadores nuevos, no se recarga la página y no se escribe el
resultado histórico hasta recuperar el servidor.

### 6.6. Verificar el despliegue

```bash
curl http://localhost:3001/api/info
```

Devuelve JSON con el host, fase y estado de persistencia. La malla de navegadores puede
inspeccionarse desde la consola con `window.__silunetP2P.openPeerIds()`.

### 6.7. Probar la tolerancia a fallos (demo de la defensa)

Con Clásico en curso, cerrar Node o desconectar de Wi-Fi la laptop host, manteniendo
encendido el router. Lo esperado:

1. Los jugadores pierden el WebSocket, pero conservan sus DataChannels.
2. Al faltar respuestas `PONG`, aunque el WebSocket quede falsamente en `OPEN`, tras
   aproximadamente 4-5 s la mayoría confirma la caída.
3. Bully elige un único navegador jugador como líder.
4. El reloj continúa, se aceptan respuestas y arranca la siguiente ronda.

```bash
npm run test:p2p-fire
```

-->

### 6.8. Variables de entorno

| Variable | Para qué sirve | Default |
|---|---|---|
| `NODE_ID` | Identificador único del nodo en el clúster. | `node1` |
| `PORT` | Puerto HTTP/WebSocket donde escucha. | `3001` |
| `COORDINATOR_ID` | Quién es coordinador al arrancar. | `node1` |
| `PEERS` | URLs WS de los otros nodos, separadas por comas. | *(vacío = nodo solo)* |
| `PUBLIC_NODES` | URLs HTTP LAN de los tres nodos que usarán master y celulares para reconectar. | deriva de `PEERS` |
| `DATABASE_URL` | PostgreSQL opcional para historia global; no participa en el estado vivo. | *(vacío = historia local)* |
| `DB_POOL_SIZE` | Máximo de conexiones PostgreSQL por nodo. | `5` |
| `CLUSTER_ID` | Identifica la concesión de escritura si una BD aloja varios clústeres. | `silunet-main` |
| `REPLICA_DIR` | Carpeta local de snapshots durables del backend. | `data/replicas` |

### 6.9. Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| `'node' no se reconoce` | Node no instalado o fuera del PATH. Reinstalar y reabrir la terminal. |
| `Error: listen EADDRINUSE :::3001` | El puerto está ocupado por otra instancia. Cerrarla o usar otro `PORT`. |
| Cambié TypeScript y no veo el cambio | Falta `npm run build` (o usar `npm run dev`). |
| Los celulares no abren la página | Deben estar en la **misma Wi-Fi** y usar la IP local (`http://192.168.x.x:3001/join`), no `localhost`. |
| Los nodos no se ven entre sí | Revisar que `PEERS` apunte a las IP LAN correctas. En laptops distintas todos pueden usar el puerto 3001. |
| PostgreSQL queda inaccesible | El juego continúa desde la réplica; perfiles, salón de la fama y guardado quedan pendientes hasta que vuelva. Revisar URL, firewall y host de la base. |
| El juego indica “sin quorum” | Deben estar comunicados al menos dos de los tres backends; revisar router, IP y firewall. |

Guía paso a paso ampliada: [`EJECUCION.md`](EJECUCION.md).

---

## 7. Verificación y Validación

La validación principal levanta procesos Node y conexiones WebSocket reales; no simula
el transporte ni el motor:

```bash
npm run build            # requerido antes de correr los bots

npm run vv:concurrencia  # ~30 s
npm run vv:caos          # prueba de fuego, ~3 min
```

Las dos pruebas usan el clúster de backend como arquitectura principal:

**`vv:concurrencia`** (Ejes 2 y 3) — 7 bots repartidos en los 3 nodos aciertan "a la vez"
y verifica que:

- ninguno se pierde en el candado del Eje 3;
- el ranking final queda ordenado **estrictamente** por timestamp de Lamport;
- la posición anunciada en vivo coincide con la posición final;
- el puntaje corresponde a la fórmula por posición lógica, no al tiempo de red;
- no hay jugadores duplicados.

**`vv:caos`** (Eje 4) — mata al coordinador, reintegra desde disco la réplica caída y
vuelve a matar al líder nuevo, conservando siempre quorum 2/3. Verifica que:

- cada caída dispara una elección Bully hacia un coordinador **distinto**, en tiempo
  acotado;
- la partida **nunca se congela** (vuelve a haber `TICK`/`ROUND_START` poco después);
- el nodo reiniciado carga una versión durable, no una variable conservada en RAM;
- los celulares caídos con su nodo reconectan **sin duplicarse** en el marcador final.

Con `VV_VERBOSE=1` delante del comando se ven los logs internos de cada nodo. Ambos bots
salen con **código 0** si pasan, así que sirven tal cual en un pipeline de CI.
Por defecto aíslan la prueba con SQLite. Para validar también la integración compartida,
se puede definir `VV_DATABASE_URL` apuntando a una base PostgreSQL exclusiva de pruebas;
en ese modo, `vv:caos` también exige que el cierre quede persistido exactamente una vez.

**Herramientas complementarias contempladas para la materia de V&V:** SonarQube
(calidad), Jenkins (CI/CD), Cypress o Selenium (e2e) y Burp Suite (seguridad).

---

## 8. Estructura del repositorio

```
src/
  server.ts     HTTP + WebSocket, enrutado de mensajes, punto de entrada
  game.ts       reglas del juego: rondas, votación, puntaje, pistas
  cluster.ts    comunicación entre nodos, heartbeats, elección Bully (Eje 4)
  replicaStore.ts snapshots atómicos, término e índice durable por nodo
  lamport.ts    reloj lógico de Lamport (Eje 2)
  mutex.ts      candado FIFO del marcador compartido (Eje 3)
  monitoring.ts agrega salud, latencia y heartbeats de navegadores/nodos
  db.ts         contrato de persistencia + respaldo SQLite local
  postgres.ts   PostgreSQL compartido, transacciones y concesión de líder
  wordBank.ts   banco de palabras + siluetas SVG + dificultad
  types.ts      protocolo completo (S2C / C2S / N2N) y modelos de datos
public/         cliente sin build: join.html, play.html, master.html, distributed-monitor.js
  p2p.js        telemetría WebRTC; no ejecuta el motor autoritativo
vv/             bots de verificación y validación
scripts/        arranque del host y utilidades del proyecto
test/           pruebas unitarias, JUnit y Selenium
docs/           conceptos, reporte, diagramas y capturas de evidencia
BDD.sql         esquema de base de datos documentado
compose.yaml    PostgreSQL local para desarrollo
EJECUCION.md    guía de ejecución paso a paso
```

### Sitemap

| Ruta | Qué es |
|---|---|
| `/join` | Lo que abre el QR: nick + avatar, asigna el celular a un nodo. |
| `/play` | Cliente del celular: silueta, palabra, timer, intento, pista, ranking. |
| `/master` | Pantalla proyectada (solo lectura): silueta grande, ranking con medallas, panel didáctico y salud del clúster. |
| `/api/info` | JSON con el estado del nodo (depuración y scripts). |
