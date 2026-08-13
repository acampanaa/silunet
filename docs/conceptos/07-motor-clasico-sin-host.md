# 07 · El motor Clásico dentro del navegador

Después de ganar la elección, el navegador no “mantiene viva” una conexión con Node: Node ya no
existe. El líder ejecuta una implementación del ciclo esencial de Clásico usando el snapshot local.

## Arranque del motor de respaldo

`startEngine()` verifica dos precondiciones:

1. existe `state` —sin snapshot no hay nada que continuar—;
2. `state.mode === 'clasico'` —los otros modos no están soportados por este motor P2P—.

Luego clona el estado, aumenta la versión y decide cómo reanudar según la fase:

| Fase del snapshot | Acción del líder |
|---|---|
| `playing` o `countdown` | Cambia a `playing`, reemite `ROUND_START` y arranca ticks. |
| `roundEnd` | Programa la siguiente ronda después de una pausa corta. |
| `gameEnd` | Reemite el ranking final. |
| otra fase | Informa que no hay una partida reanudable. |

## Reloj distribuido, no reloj persistente

El líder crea un `setInterval` de un segundo. En cada pulso:

1. comprueba que todavía es líder;
2. resta uno a `timeLeft`;
3. revela una letra cuando corresponde;
4. emite `GAME/TICK`;
5. difunde un `STATE` nuevo;
6. si llega a cero, cierra la ronda.

El reloj continúa porque otro proceso —la pestaña líder— crea un timer nuevo desde el valor
replicado. No continúa porque el timer original haya “migrado”: se reconstruye desde datos.

## Procesamiento de acciones

La interfaz de cada jugador intercepta `GUESS` y `REQUEST_HINT`. Durante el failover,
`p2p.submitAction()` evita enviarlas al WebSocket muerto:

- si el jugador es líder, procesa localmente;
- si es seguidor, envía `ACTION` al líder;
- si todavía no hay líder, encola la acción.

El líder valida que el origen:

- corresponda a un peer conocido con rol `player`;
- anuncie el mismo `playerId` que tiene registrado;
- exista dentro de `state.players`.

Después aplica las reglas de pista, intento repetido, respuesta incorrecta o acierto.

## Orden lógico y puntaje

Cada acierto se guarda como `{ id, lamport }`. Al cerrar la ronda se ordenan los aciertos por
Lamport y se calcula:

```text
puntos = 100 + 900 × (1 − (posición − 1) / N)
```

Para cuatro aciertos sin pista:

| Posición | Puntos |
|---:|---:|
| 1 | 1000 |
| 2 | 775 |
| 3 | 550 |
| 4 | 325 |

Quien usó pista recibe el 80 % del valor que le correspondía. Los puntos se suman al jugador
dentro del snapshot y el líder emite `ROUND_END` y `RANKING`.

## Progresión del tiempo en Clásico

La duración de cada ronda depende de cuántas palabras ya pasaron:

```text
duración = max(5, 25 − índiceDeRonda × 3)
```

| Ronda | Índice interno | Segundos |
|---:|---:|---:|
| 1 | 0 | 25 |
| 2 | 1 | 22 |
| 3 | 2 | 19 |
| 4 | 3 | 16 |
| 5 | 4 | 13 |
| 6 | 5 | 10 |
| 7 | 6 | 7 |
| 8 en adelante | ≥ 7 | 5 |

La fórmula está duplicada deliberadamente entre el motor Node y el motor P2P para que ambos
produzcan el mismo ritmo. Esto crea un costo de mantenimiento: toda futura modificación de reglas
debe aplicarse y probarse en ambos lugares.

## Eventos de interfaz frente a estado replicado

El líder emite dos flujos complementarios:

- `GAME`: eventos que actualizan inmediatamente la interfaz, por ejemplo `TICK`,
  `CORRECT_ANSWER`, `ROUND_END` o `RANKING`;
- `STATE`: snapshot versionado para que los seguidores converjan y puedan reemplazar al líder.

Los seguidores ejecutan la misma función `dispatchGameMessage` que usaban con mensajes WebSocket.
Así el HTML no necesita dos interfaces visuales separadas.

## Paso a la siguiente ronda

Después de `ROUND_END`, el líder espera cuatro segundos, incrementa `currentRoundIndex`, toma el
siguiente `WordEntry` de `state.rounds`, crea la máscara y ejecuta la cuenta regresiva `3, 2, 1, 0`.

Este paso es la evidencia fuerte de continuidad: no basta con que el contador anterior llegue a
cero. Crear una ronda posterior demuestra que la cola de palabras, las reglas y los timers están
operando fuera de Node.

## Qué ocurre al finalizar la partida sin host

El líder emite el ranking final y detiene sus timers. El resultado histórico no se guarda mientras
el servidor/base no estén disponibles. La disponibilidad de la partida tiene prioridad sobre la
persistencia del historial.

## Por qué solo Clásico

Relajo y SiluStack tienen máquinas de estado y reglas adicionales. El snapshot contiene parte de
esa información, pero `startEngine()` rechaza explícitamente cualquier modo distinto de Clásico.
Decir que “todo el sistema continúa” sería incorrecto; la garantía actual es:

> Una partida Clásica ya iniciada puede continuar entre navegadores preparados.

Código principal: `startEngine`, `startTicking`, `applyAction`, `endRound`, `nextRound`,
`runCountdown`, `emitGame` y `syncState` en [`public/p2p.js`](../../public/p2p.js).

Anterior: [06 · Elección y consistencia](06-eleccion-y-consistencia.md). Siguiente:
[08 · Recursos offline](08-recursos-offline.md).
