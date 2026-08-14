# 11 · Monitoreo distribuido por participante

El monitor de **/master** vuelve visibles los mecanismos que normalmente ocurren detrás de
la interfaz: pings, heartbeats, latencia, conexiones P2P, réplicas y nodos servidores.
Incluye a cada jugador, a cada pantalla maestra y a los nodos del clúster.

## Qué problema resuelve

Saber que un WebSocket está abierto no demuestra que el otro extremo siga respondiendo. Un
corte de Wi-Fi puede dejar una conexión aparentemente abierta durante varios minutos. Por
eso Silunet usa monitoreo activo y guarda la hora del último mensaje válido.

El panel permite contestar en vivo:

- ¿qué participantes continúan activos?;
- ¿a qué nodo está conectado cada uno?;
- ¿cuánto tarda el recorrido PING → PONG?;
- ¿cuántos DataChannels P2P tiene abiertos?;
- ¿la malla está completa y los recursos offline están listos?;
- ¿qué navegador es líder después del failover?;
- ¿qué nodo servidor es coordinador y cuándo llegó su último heartbeat?

## Flujo normal con servidor

~~~mermaid
sequenceDiagram
    participant J as Navegador jugador
    participant N2 as Nodo de conexión
    participant N1 as Otros nodos
    participant M as /master

    loop cada 1000 ms
        J->>N2: PING + sentAt + telemetría P2P
        N2-->>J: PONG + clientTs
        J->>J: RTT = ahora - clientTs
        N2->>N1: N_MONITOR_REPORT
        N1-->>M: DISTRIBUTED_MONITOR agregado
    end
~~~

Cada nodo crea un reporte únicamente con sus conexiones locales. Después intercambia
**N_MONITOR_REPORT** con los demás nodos. El módulo
[src/monitoring.ts](../../src/monitoring.ts) combina esos reportes y elimina duplicados
por identidad P2P, identidad de jugador o conexión.

De esta manera, un master conectado a node2 también puede ver jugadores conectados a
node1 y node3.

## Datos reportados por un navegador

El método **p2p.telemetry()** produce una fotografía pequeña:

| Dato | Significado |
|---|---|
| serverRttMs | Tiempo aproximado de ida y vuelta del último PING/PONG. |
| openPeers | DataChannels WebRTC abiertos. |
| openPlayerPeers | DataChannels abiertos específicamente con jugadores. |
| knownPlayers | Jugadores conocidos por la malla. |
| meshReady | El navegador tiene los enlaces P2P esperados. |
| serverAlive | Todavía recibe mensajes auténticos del servidor. |
| failoverActive | La partida ya cambió al motor P2P. |
| leaderId | Navegador que coordina el motor después de la caída. |
| stateVersion | Versión de la réplica P2P observada. |
| offlineAssetsReady | Siluetas de la partida disponibles sin HTTP. |

Estos valores son **observacionales**. El servidor los valida y limita antes de mostrarlos,
pero nunca los utiliza para decidir puntajes, respuestas o liderazgo.

## Estados y umbrales

| Señal | Intervalo | Umbral de caída |
|---|---:|---:|
| Navegador → servidor | 1000 ms | 2000 ms |
| Navegador ↔ navegador | 1000 ms | 3500 ms |
| Nodo ↔ nodo | 1000 ms | 2500 ms |
| Respuesta del servidor vista por el navegador | 1000 ms | 3200 ms |

En el panel:

- **saludable:** el último heartbeat llegó dentro del intervalo normal;
- **latido retrasado:** superó aproximadamente 1,25 segundos;
- **desconectado:** alcanzó el timeout o cerró la conexión.

Una persona desconectada se conserva durante 12 segundos. Esa retención es deliberada: si
se borrara inmediatamente, el master no alcanzaría a observar qué dispositivo se perdió.

## Qué ocurre cuando desaparece el servidor

Al caer Node dejan de llegar mensajes **DISTRIBUTED_MONITOR**. El monitor no se congela:
la pantalla master consulta la malla WebRTC que ya tiene abierta y actualiza la salud de
los peers a partir de peer.lastSeen, serverAlive, leaderId y el estado del DataChannel.

Por eso la ruta indicada por el panel cambia de **WebSocket** a **WebRTC P2P**, los nodos se
muestran fuera de línea y los navegadores supervivientes continúan actualizándose.

El master sigue siendo un observador: aparece en el monitor y participa en heartbeats, pero
no es candidato a líder del juego.

## Interfaz

El botón **Monitor** está en la cabecera de /master y muestra cuántas conexiones siguen
activas. El panel permite filtrar jugadores, masters y nodos. Cada fila se puede desplegar
para ver IDs, último heartbeat, nodo, RTT, malla, líder, versión de réplica y disponibilidad
de recursos offline.

La interfaz usa color semántico acompañado de texto, navegación por teclado, cierre con
Escape, foco contenido dentro del diálogo y soporte para prefers-reduced-motion.

## Código principal

- [src/monitoring.ts](../../src/monitoring.ts): agregación, estados y retención.
- [src/server.ts](../../src/server.ts): captura de PING, reportes entre nodos y emisión.
- [src/cluster.ts](../../src/cluster.ts): edad del heartbeat de cada servidor.
- [public/p2p.js](../../public/p2p.js): RTT y fotografía de la malla.
- [public/distributed-monitor.js](../../public/distributed-monitor.js): interfaz y vista P2P sin servidor.
- [public/master.html](../../public/master.html): estructura visual del panel.

Anterior: [10 · Límites, decisiones y defensa](10-limites-y-defensa.md).
