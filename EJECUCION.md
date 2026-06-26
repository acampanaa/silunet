# Cómo ejecutar Quórum — Guía paso a paso

Esta guía explica cómo descargar las dependencias y poner a correr el proyecto,
primero en **un solo nodo** (lo más rápido para probar el juego) y luego como
**clúster de 3 nodos** (lo que demuestra los 4 ejes de sistemas distribuidos).

No necesitas instalar bases de datos ni Redis: el estado vive en memoria.

---

## 1. Requisitos previos

Antes de empezar, instala en tu computadora:

- **Node.js 18 o superior** (incluye `npm`). Verifica que esté listo:
  ```bash
  node --version
  npm --version
  ```
  Si `node --version` muestra `v18.x` o mayor, estás bien.
  Descarga: https://nodejs.org (elige la versión **LTS**).
- **Git** (solo si vas a clonar el repositorio).

---

## 2. Descargar el proyecto

Clona el repositorio (o descarga el ZIP desde GitHub y descomprímelo):

```bash
git clone <URL-del-repositorio> quorum
cd quorum
```

> A partir de aquí, todos los comandos se ejecutan **dentro de la carpeta del
> proyecto** (donde está el archivo `package.json`).

---

## 3. Instalar las dependencias

Un solo comando descarga todo lo que el proyecto necesita (la librería `ws` de
WebSockets y las herramientas de TypeScript):

```bash
npm install
```

Esto crea la carpeta `node_modules/`. Solo hay que hacerlo **una vez** (o cuando
cambien las dependencias).

---

## 4. Compilar el proyecto

El servidor está escrito en TypeScript y hay que convertirlo a JavaScript antes
de ejecutarlo:

```bash
npm run build
```

Esto genera la carpeta `dist/` con el servidor listo para correr.

---

## 5. Ejecutar en UN SOLO nodo (modo rápido para probar)

Es la forma más sencilla de ver el juego funcionando. Compila y arranca el
servidor de una sola vez:

```bash
npm run dev
```

Cuando arranque, verás en la consola algo como:

```
[node1]  COORDINADOR | Puerto 3001
[node1]  Pantalla maestra: http://localhost:3001/master
[node1]  URL celulares:    http://192.168.x.x:3001/join
```

Ahora abre en el navegador:

- **Pantalla maestra (proyector / dashboard):** http://localhost:3001/master
  → pulsa **"Iniciar partida"**.
- **Jugador (un celular o pestaña):** http://localhost:3001/join
  → escribe un nick y juega.

Para probar la concurrencia abre **2 o 3 pestañas** de `/join` con nicks
distintos. Para detener el servidor pulsa `Ctrl + C` en la consola.

---

## 6. Ejecutar el CLÚSTER de 3 nodos (modo distribuido)

Aquí es donde se demuestran los 4 ejes (Lamport, exclusión mutua, heartbeats,
elección de líder Bully). Es el **mismo código** ejecutado 3 veces con variables
de entorno distintas.

Primero compila una sola vez:

```bash
npm run build
```

Luego abre **3 terminales** y ejecuta un nodo en cada una. Cada nodo escucha en
un puerto distinto y conoce a los otros dos vía `PEERS`.

### En Linux / macOS (bash)

```bash
# Terminal 1 — nodo 1 (coordinador inicial)
NODE_ID=node1 PORT=3001 COORDINATOR_ID=node1 PEERS=ws://localhost:3002,ws://localhost:3003 node dist/server.js

# Terminal 2 — nodo 2
NODE_ID=node2 PORT=3002 COORDINATOR_ID=node1 PEERS=ws://localhost:3001,ws://localhost:3003 node dist/server.js

# Terminal 3 — nodo 3
NODE_ID=node3 PORT=3003 COORDINATOR_ID=node1 PEERS=ws://localhost:3001,ws://localhost:3002 node dist/server.js
```

### En Windows (PowerShell)

```powershell
# Terminal 1 — nodo 1 (coordinador inicial)
$env:NODE_ID="node1"; $env:PORT="3001"; $env:COORDINATOR_ID="node1"; $env:PEERS="ws://localhost:3002,ws://localhost:3003"; node dist/server.js

# Terminal 2 — nodo 2
$env:NODE_ID="node2"; $env:PORT="3002"; $env:COORDINATOR_ID="node1"; $env:PEERS="ws://localhost:3001,ws://localhost:3003"; node dist/server.js

# Terminal 3 — nodo 3
$env:NODE_ID="node3"; $env:PORT="3003"; $env:COORDINATOR_ID="node1"; $env:PEERS="ws://localhost:3001,ws://localhost:3002"; node dist/server.js
```

Cuando los 3 estén arriba, cada consola mostrará `✓ Peer listo: nodeX`.

Abre la pantalla maestra de **cualquier** nodo (todos comparten el mismo estado
replicado), por ejemplo http://localhost:3001/master, e inicia la partida. Los
jugadores pueden entrar por el `/join` de cualquier nodo (`:3001`, `:3002` o
`:3003`) y compiten sobre el mismo marcador.

### Probar la tolerancia a fallos (Eje 4)

Con la partida en curso, cierra (`Ctrl + C`) la terminal del **coordinador**
(`node1`). Los otros dos detectan la caída por heartbeats y eligen un nuevo
coordinador (algoritmo del Matón / Bully) sin que la partida se congele. El
panel de salud del clúster en `/master` refleja el cambio en vivo.

---

## 7. Variables de entorno

| Variable         | Para qué sirve                                              | Valor por defecto |
|------------------|------------------------------------------------------------|-------------------|
| `NODE_ID`        | Identificador único del nodo dentro del clúster.           | `node1`           |
| `PORT`           | Puerto HTTP/WebSocket donde escucha el nodo.               | `3001`            |
| `COORDINATOR_ID` | Quién es el coordinador inicial al arrancar.               | `node1`           |
| `PEERS`          | Lista (separada por comas) de URLs WS de los otros nodos.  | *(vacío)*         |

> Si `PEERS` queda vacío, el nodo corre **solo** (modo de la sección 5).

---

## 8. Resumen de comandos

| Acción                          | Comando            |
|---------------------------------|--------------------|
| Instalar dependencias           | `npm install`      |
| Compilar TypeScript → `dist/`   | `npm run build`    |
| Compilar y arrancar (1 nodo)    | `npm run dev`      |
| Arrancar lo ya compilado        | `npm start`        |

---

## 9. Problemas comunes

- **`'node' no se reconoce` / `command not found`:** Node.js no está instalado o
  no está en el PATH. Reinstala desde https://nodejs.org y reabre la terminal.
- **`Error: listen EADDRINUSE :::3001`:** el puerto ya está ocupado (otro nodo o
  un servidor anterior). Ciérralo o usa otro `PORT`.
- **Cambié código TypeScript y no veo el cambio:** vuelve a ejecutar
  `npm run build` (o usa `npm run dev`, que compila antes de arrancar).
- **Los celulares no abren la página:** deben estar en la **misma red Wi-Fi** que
  el servidor y usar la IP local (`http://192.168.x.x:3001/join`), no
  `localhost`. La IP correcta aparece impresa en la consola al arrancar.
- **Los nodos no se conectan entre sí:** revisa que las URLs de `PEERS` apunten a
  los puertos correctos y que cada nodo tenga un `NODE_ID` y `PORT` distinto.
