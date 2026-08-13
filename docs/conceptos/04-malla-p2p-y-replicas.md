# 04 · Malla P2P y réplicas calientes

La malla es la infraestructura que ya debe existir **antes** de apagar el host. No se puede
esperar a la caída para crearla, porque la señalización también desaparece con Node.

## Identidad de un peer

Cada pestaña genera un `peerId` con prefijo `p_` y lo guarda en `sessionStorage`. Esa identidad:

- distingue conexiones WebRTC;
- permite ordenar quién inicia la negociación;
- sirve como prioridad de la elección Bully;
- dura mientras vive la sesión de esa pestaña.

No debe confundirse con `playerId` ni con el token persistente del perfil:

| Identificador | Alcance | Uso |
|---|---|---|
| `peerId` | Pestaña/sesión P2P | Conexión y elección. |
| `playerId` | Jugador en la partida actual | Validar acciones y puntaje. |
| `token` | Identidad persistente de usuario | Perfil, reconexión e historia. |

## Cómo se forma la malla

1. Cada pestaña envía `P2P_REGISTER` por WebSocket.
2. Node arma y difunde `P2P_PEERS` con roles e identidades.
3. Cada navegador llama `ensurePeer` para los peers anunciados.
4. Una comparación lexicográfica de `peerId` decide qué extremo crea la oferta y el DataChannel.
5. Node retransmite SDP y candidatos ICE mediante `P2P_SIGNAL`.
6. Cuando abre el canal, los extremos intercambian `HELLO` y `HEARTBEAT`.

La comparación determinista evita que ambos extremos creen simultáneamente conexiones duplicadas.

## Por qué el canal es ordenado

El DataChannel se crea con `{ ordered: true }`. Los mensajes de un mismo canal llegan en el
orden enviado. Esto resulta útil para secuencias como:

```text
GAME: CORRECT_ANSWER
STATE: versión 41
GAME: ROUND_END
STATE: versión 42
```

El orden del canal no resuelve por sí solo la consistencia global, porque existen varios canales.
Por eso también hay líder, reloj de Lamport, versiones y deduplicación de eventos.

## Mensajes que circulan directamente

| `kind` | Emisor típico | Propósito |
|---|---|---|
| `HELLO` | Cualquier peer al abrir | Anunciar rol, jugador y estado del servidor. |
| `HEARTBEAT` | Todos, cada segundo | Mantener membresía y reportar si ven vivo al host. |
| `LEADER` | Peer que activa failover | Anunciar el líder calculado. |
| `ACTION` | Jugador seguidor | Enviar `GUESS` o `REQUEST_HINT` al líder. |
| `GAME` | Líder | Emitir eventos que la interfaz ya sabe procesar. |
| `STATE` | Líder | Replicar el estado completo con versión creciente. |

Node no reenvía estos mensajes. El método `broadcast` escribe el JSON directamente en cada
DataChannel abierto.

## Réplica caliente en cada navegador

Cada jugador conserva:

- `state`: último `GameSnapshot` aceptado;
- `stateVersion`: versión más reciente;
- `assetCache`: imágenes convertidas a data URL;
- `known`: identidades y roles de peers;
- `peers`: conexiones WebRTC y su última señal de vida;
- `seenEvents`: IDs ya procesados;
- `pendingActions`: acciones retenidas mientras todavía no hay líder.

La réplica es “caliente” porque se actualiza durante el juego. No está ejecutando timers mientras
Node sigue siendo autoritativo; está lista para que el ganador de la elección llame `startEngine()`.

## Cuándo se considera lista la malla

La interfaz muestra **“Respaldo P2P listo entre jugadores”** cuando:

- existen al menos dos jugadores conocidos;
- este jugador tiene DataChannel abierto con todos los demás jugadores esperados.

Un canal con `/master` no sustituye un canal entre jugadores. Además, `master` no cuenta para la
mayoría ni entra en la lista de candidatos a líder.

## Complejidad y límite de cinco jugadores

Una malla completa usa `N(N−1)/2` conexiones. Es excelente para grupos pequeños porque no hay
un relay central, pero escala cuadráticamente. Cinco jugadores implican diez conexiones entre
jugadores, además de las del observador si `/master` participa.

El límite de cinco no es una regla matemática de WebRTC; es una decisión de ingeniería para
mantener estable una demo en celulares heterogéneos.

## Qué ocurre si cae un peer jugador

Si un peer no emite mensajes durante más de 3,5 segundos, su canal deja de considerarse vivo. Si
era el líder durante failover, los sobrevivientes vuelven a ejecutar `electedLeader()` sobre los
jugadores elegibles que conservan canal abierto.

Esto permite un segundo cambio de líder dentro de la malla, aunque la prueba automatizada principal
solo mata el servidor y comprueba una elección inicial.

## Riesgo de recargar

Recargar crea una nueva ejecución JavaScript y puede cambiar el `peerId`. Sin el host ya no existe
roster ni señalización para reconstruir el DataChannel. Por eso la prueba exige mantener abiertas
las pestañas sobrevivientes.

Código principal: `handleRoster`, `ensurePeer`, `bindDataChannel`, `handlePeerMessage` y
`reportMesh` en [`public/p2p.js`](../../public/p2p.js).

Anterior: [03 · Estado y snapshots](03-estado-autoritativo-y-snapshots.md). Siguiente:
[05 · Detección de fallos](05-deteccion-de-fallos.md).
