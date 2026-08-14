# 12 · Sistema distribuido real: tres réplicas de backend

## Qué cambió

Un navegador abierto en `/play` ya no puede convertirse en coordinador del juego. Los
celulares son clientes WebSocket y conservan una vista para dibujar la interfaz, pero el
motor, los candados y el estado autoritativo viven siempre en procesos backend.

El mismo programa se instala en tres dispositivos:

```text
                    WebSocket persistente
 celulares ───────────────────────────────────┐
 espectador ──────────────────────────────────┤
                                              ▼
                                      backend líder
                                      cola FIFO + Lamport
                                        │           │
                              snapshot + fsync  snapshot + fsync
                                        ▼           ▼
                                  seguidor 2    seguidor 3
```

## Qué es una réplica

Una réplica no es otro programa distinto. Es otra ejecución de `dist/server.js` con:

- el mismo banco de palabras y archivos web;
- su propio WebSocket para clientes;
- conexiones WebSocket persistentes hacia los otros dos backends;
- una copia en memoria para ejecutar rápido;
- un snapshot local en `data/replicas/` para reiniciar sin depender de RAM.

Cada snapshot durable contiene fase, ronda, tiempo restante, jugadores, puntajes,
Lamport, votos, palabras utilizadas y estado de los modos de juego.

## Camino de una jugada

1. El teléfono incrementa Lamport y envía acción, `actionId` y `stateVersion`.
2. El backend conectado rechaza la acción si no tiene quorum o si esa `stateVersion` quedó
   fuera de la ventana de tolerancia (capítulo 14).
3. Si es seguidor, reenvía la acción al líder por el canal inter-nodo.
4. El líder descarta duplicados por `actionId`, entra en la cola FIFO y modifica la sección
   crítica una sola vez.
5. El líder escribe el snapshot en su disco con archivo temporal, `fsync` y rename.
6. Envía `N_REPLICATE(term,index,snapshot)` a los seguidores.
7. Cada seguidor fuerza el snapshot a su disco y responde `N_REPLICATE_ACK`.
8. Con 2 de 3 copias confirmadas, el líder hace broadcast inmediato a jugadores y master.

El estado se recibe; nunca se consulta en un bucle HTTP.

Las escrituras durables están **serializadas en una cola de promesas** dentro de
`ReplicaStore`. Son asíncronas para no congelar el event loop del proceso durante el `fsync`
—un nodo bloqueado en disco deja de latir y parece caído— y encoladas para que el índice 12
nunca se escriba después del 13. El detalle está en el capítulo 14.

## Término, índice y fencing

El **término** identifica una época de liderazgo. Una elección incrementa el término; un
mensaje de un líder anterior queda cercado y no puede sobrescribir la réplica nueva.

El **índice** es la versión monotónica del snapshot dentro de esa historia. También viaja
a los clientes como `stateVersion`. Un movimiento sobre una versión demasiado antigua recibe
`STATE_STALE` y el backend empuja la ronda y ranking vigentes.

## Constantes vigentes

| Constante | Valor | Dónde | Significado |
|---|---:|---|---|
| `HEARTBEAT_INTERVAL_MS` | 1000 ms | `cluster.ts` | latido a cada peer. |
| `HEARTBEAT_TIMEOUT_MS` | 5000 ms | `cluster.ts` | silencio para sospechar la caída de un peer. |
| `HEARTBEAT_CHECK_MS` | 50 ms | `cluster.ts` | frecuencia de evaluación del detector. |
| `ELECTION_TIMEOUT_MS` | 1500 ms | `cluster.ts` | espera de `N_ALIVE` antes de proclamarse. |
| `COORD_WAIT_MS` | 3000 ms | `cluster.ts` | espera del anuncio de coordinador antes de reintentar. |
| `REPLICA_COMMIT_TIMEOUT_MS` | 4000 ms | `server.ts` | plazo para reunir la mayoría de ACK. |
| `REPLICA_SYNC_WINDOW_MS` | 700 ms | `server.ts` | ventana para recoger réplicas antes de liderar. |
| `MAX_ACTION_VERSION_LAG` | 8 | `server.ts` | retraso de `stateVersion` tolerado (capítulo 14). |
| `ACTION_ID_WINDOW` | 1000 | `game.ts` | acciones recordadas para deduplicar. |

El umbral de heartbeat subió de 2000 a 5000 ms al desplegar en Docker: Docker Desktop puede
pausar un contenedor durante un `fsync` y con 2 s eso provocaba **elecciones falsas**. Con
latido cada segundo, 5 s siguen siendo cinco latidos perdidos seguidos: no oculta una caída
real, solo deja de castigar una pausa de disco. Es el compromiso del capítulo 5 —menos falsos
positivos a cambio de detectar un poco más tarde— con números concretos.

## Por qué se exige quorum 2/3

Dos copias constituyen mayoría. Con una caída todavía quedan dos nodos capaces de elegir
un líder único y confirmar escrituras. Un nodo aislado no puede continuar porque dos
particiones podrían otorgar puntos distintos y ambas creer que son correctas.

Por eso la prueba válida es:

1. matar un líder;
2. comprobar continuidad sobre los dos supervivientes;
3. reintegrar la réplica caída desde disco;
4. recién entonces provocar otra caída.

Continuar con uno de tres sería disponibilidad sin consistencia, no el modelo estricto
pedido por la rúbrica.

## Recuperación después de una caída

Los nodos detectan ausencia de heartbeat a los 5000 ms. Los supervivientes ejecutan
Bully, pero un candidato solo se proclama si tiene quorum. Antes de arrancar timers, el
nuevo líder solicita las réplicas durables, elige la de mayor `(term,index)`, la restaura,
la sella con el término nuevo y la confirma por mayoría.

Los navegadores también envían PING cada 1000 ms. Al cerrarse el WebSocket reintentan cada
1200 ms y, tras dos intentos fallidos contra el mismo destino, rotan al siguiente de la lista
que les inyectó el servidor. Detrás del gateway esa lista tiene un solo elemento —su propio
origen— y es Nginx quien los reasigna a un nodo vivo (capítulo 13). El token del jugador
permite recuperar identidad y puntaje sin duplicarlo, y `actionId` evita que el reintento
sume puntos dos veces (capítulo 14).

## PostgreSQL no es el coordinador

PostgreSQL es opcional para perfiles e historia global. El estado vivo y la elección no
dependen de PostgreSQL, etcd, Redis ni de la laptop inicial. Si la base histórica falla,
la partida sigue; si un backend falla, otro backend continúa desde su disco.

## Evidencia ejecutable

`npm run vv:concurrencia` distribuye siete bots entre tres nodos y valida mutex y
Lamport. `npm run vv:caos` mata dos líderes en momentos distintos, reintegra una réplica
entre ambas caídas y termina la partida con quorum 2/3.

Sobre el clúster en Docker, `.\scripts\docker-cluster.ps1 fire` mata al coordinador vigente y
cronometra la aparición del sucesor sin cambiar la URL pública (capítulo 13).

Archivos principales:

- `src/replicaStore.ts`: persistencia atómica local y cola de commits;
- `src/cluster.ts`: heartbeats, términos, quorum y Bully;
- `src/server.ts`: commit mayoritario, ACK y broadcasting;
- `vv/caos-coordinador.js`: prueba de fuego reproducible.

Siguiente: [13 · Gateway y una sola dirección](13-gateway-y-una-sola-direccion.md).
