# 06 · Elección de líder y consistencia

Detectar que Node cayó no basta. Si todos los navegadores arrancaran un reloj y aceptaran
respuestas simultáneamente, aparecerían múltiples versiones del juego. La elección establece un
único motor autoritativo entre los sobrevivientes.

## Algoritmo Bully adaptado

El algoritmo del Matón (*Bully*) elige al proceso vivo con mayor prioridad. En Silunet la
prioridad es el orden lexicográfico de `peerId`:

```text
p_18ab... < p_91cd... < p_f230...
                         ↑ líder
```

Cada jugador ejecuta localmente la misma función:

1. incluye su `peerId` si su rol es `player`;
2. incluye peers vivos y elegibles conectados por DataChannel;
3. ordena los identificadores;
4. escoge el último.

No se sortea y no depende de quién pulse primero. Si los peers conservan la misma vista de
membresía, calculan el mismo resultado sin una ronda extensa de mensajes de elección.

## Diferencia frente al Bully clásico

En el Bully clásico un candidato envía `ELECTION` a procesos de mayor ID, recibe `ALIVE` y el
mayor sobreviviente anuncia `COORDINATOR`. La variante web de Silunet simplifica ese intercambio:
la malla y los heartbeats ya proporcionan la lista de jugadores vivos, así que todos calculan el
máximo y el mensaje `LEADER` sirve como confirmación.

Es correcto describirlo como **elección determinista inspirada/adaptada de Bully**, porque conserva
su propiedad central —gana el identificador elegible mayor— aunque no reproduce todos los mensajes
del algoritmo académico clásico.

## Elegibilidad

Un candidato es elegible si:

- tiene rol `player`;
- su DataChannel está abierto;
- fue visto dentro de `PEER_TIMEOUT_MS`;
- en el caso local, la pestaña misma es un jugador.

`/master` nunca entra. Aunque tenga una réplica y DataChannels, carece de identidad de jugador y
no debe validar acciones en nombre de alguien.

## Activación del failover

`activateFailover(leaderId)` realiza una transición importante:

- marca `failoverActive = true`;
- fija `serverAlive = false`;
- guarda `leaderId`;
- detiene cualquier timer P2P anterior;
- anuncia `LEADER`;
- si el peer local ganó, llama `startEngine()` y vacía acciones pendientes.

Los seguidores no arrancan motor. En adelante envían `ACTION` al líder y solo aceptan `GAME` o
`STATE` cuando provienen del `leaderId` vigente.

## Un solo escritor

La regla de consistencia más importante es:

> Solo el líder modifica el estado de la partida; los demás proponen acciones y aplican réplicas.

El código lo refuerza con condiciones como:

```text
if (this.leaderId !== this.peerId) return
```

El patrón se parece a **primary-backup**:

- líder = primario que procesa escrituras;
- jugadores restantes = réplicas/seguidores;
- `STATE` = propagación de la copia autoritativa.

## Acciones durante la transición

Puede haber un intervalo donde el host ya no responde pero aún no existe líder. `submitAction()`
sella la acción con Lamport y la guarda en `pendingActions`. Cuando el líder empieza, `flushActions()`
reintenta esas acciones.

Así se evita descartar inmediatamente una respuesta enviada durante la elección. No hay garantía
de entrega exactamente una vez ante todos los fallos posibles, pero el diseño reduce pérdidas en
la transición controlada.

## Eventos duplicados y versiones

La consistencia también necesita rechazar información repetida o vieja:

- Cada `GAME` tiene `eventId`; `seenEvents` impide procesarlo dos veces.
- `seenEvents` conserva hasta 500 IDs para limitar memoria.
- Cada `STATE` lleva `version`; un seguidor rechaza versiones menores o iguales.
- Un seguidor rechaza mensajes de juego cuyo origen no sea el líder actual.

Esto ofrece deduplicación práctica, no una garantía formal de *exactly-once*. Es más preciso decir
“eventos identificados y estados versionados” que afirmar “exactamente una vez”.

## Reloj lógico de Lamport

Cada acción P2P sale con un Lamport creciente del jugador. Al procesarla, el líder hace:

```text
L_lider = max(L_lider, L_accion) + 1
```

El valor resultante ordena aciertos sin depender del reloj físico del celular. Si Ana recibe
Lamport 41 y Beto 42, ese es el orden lógico usado por la ronda, aunque sus relojes de pared no
estén sincronizados.

Lamport establece un orden causal/lógico, pero no demuestra por sí solo que el primero en tiempo
real haya sido Ana. Esa distinción es importante en una defensa técnica.

## Qué pasa si cae el líder P2P

Durante failover, `monitor()` verifica si `leaderId` sigue siendo elegible. Si no, vuelve a llamar
`electedLeader()` y promueve al mayor sobreviviente restante. Las réplicas `STATE` permiten que
otro peer tenga una copia reciente.

## Límite ante particiones de red

La mayoría reduce el split-brain respecto al host, pero esta implementación no es un protocolo de
consenso completo como Raft. No tiene términos P2P durables, log replicado ni recuperación formal
de particiones divergentes. Está diseñada para una LAN pequeña y una prueba de caída controlada.

Código principal: `electedLeader`, `activateFailover`, `submitAction`, `rememberEvent` y
`handlePeerMessage` en [`public/p2p.js`](../../public/p2p.js).

Anterior: [05 · Detección de fallos](05-deteccion-de-fallos.md). Siguiente:
[07 · Motor Clásico sin host](07-motor-clasico-sin-host.md).
