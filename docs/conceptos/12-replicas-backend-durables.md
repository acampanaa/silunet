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
2. El backend conectado rechaza la acción si su réplica está desactualizada.
3. Si es seguidor, reenvía la acción al líder por el canal inter-nodo.
4. El líder entra en la cola FIFO y modifica la sección crítica una sola vez.
5. El líder escribe el snapshot en su disco con archivo temporal, `fsync` y rename.
6. Envía `N_REPLICATE(term,index,snapshot)` a los seguidores.
7. Cada seguidor fuerza el snapshot a su disco y responde `N_REPLICATE_ACK`.
8. Con 2 de 3 copias confirmadas, el líder hace broadcast inmediato a jugadores y master.

El estado se recibe; nunca se consulta en un bucle HTTP.

## Término, índice y fencing

El **término** identifica una época de liderazgo. Una elección incrementa el término; un
mensaje de un líder anterior queda cercado y no puede sobrescribir la réplica nueva.

El **índice** es la versión monotónica del snapshot dentro de esa historia. También viaja
a los clientes como `stateVersion`. Un movimiento sobre otra versión recibe
`STATE_STALE` y el backend empuja la ronda y ranking vigentes.

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

Los nodos detectan ausencia de heartbeat a los 2000 ms. Los supervivientes ejecutan
Bully, pero un candidato solo se proclama si tiene quorum. Antes de arrancar timers, el
nuevo líder solicita las réplicas durables, elige la de mayor `(term,index)`, la restaura,
la sella con el término nuevo y la confirma por mayoría.

Los navegadores también envían PING cada 1000 ms. Si no reciben actividad del backend en
2000 ms abandonan el WebSocket fantasma y rotan por `PUBLIC_NODES`. El token del jugador
permite recuperar identidad y puntaje sin duplicarlo.

## PostgreSQL no es el coordinador

PostgreSQL es opcional para perfiles e historia global. El estado vivo y la elección no
dependen de PostgreSQL, etcd, Redis ni de la laptop inicial. Si la base histórica falla,
la partida sigue; si un backend falla, otro backend continúa desde su disco.

## Evidencia ejecutable

`npm run vv:concurrencia` distribuye siete bots entre tres nodos y valida mutex y
Lamport. `npm run vv:caos` mata dos líderes en momentos distintos, reintegra una réplica
entre ambas caídas y termina la partida con quorum 2/3.

Archivos principales:

- `src/replicaStore.ts`: persistencia atómica local;
- `src/cluster.ts`: heartbeats, términos, quorum y Bully;
- `src/server.ts`: commit mayoritario, ACK y broadcasting;
- `vv/caos-coordinador.js`: prueba de fuego reproducible.
