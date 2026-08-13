# 10 · Límites, decisiones y guía de defensa

Una buena defensa técnica no consiste en afirmar que el sistema resuelve todos los fallos. Consiste
en definir el modelo, demostrar las propiedades implementadas y explicar conscientemente los
límites. Este capítulo reúne esa narrativa.

## Garantía precisa

La afirmación defendible es:

> Con una partida Clásica ya iniciada, entre dos y cinco jugadores en una LAN que permita WebRTC,
> con la malla completa y recursos precargados, la caída del único host Node activa una elección
> determinista entre los navegadores. Un jugador retoma el motor desde el snapshot en memoria y
> la partida puede procesar acciones y abrir rondas posteriores por DataChannel.

Cada parte de esa frase importa. Quitar una precondición ampliaría la promesa más allá de lo probado.

## Lo que sí garantiza

- continuidad del modo Clásico tras detener el único proceso Node;
- comunicación directa entre jugadores ya conectados;
- detección por WebSocket/timeout y confirmación por mayoría;
- elección determinista de un solo jugador líder;
- reloj, pistas, respuestas, puntaje, ranking y nuevas rondas en el motor P2P;
- replicación versionada desde el líder a seguidores;
- siluetas embebidas y recursos de la partida precargados;
- reelección si el líder P2P deja de ser elegible;
- límite explícito de cinco jugadores.

## Lo que no garantiza

- continuidad de Relajo o SiluStack sin host;
- ingreso de jugadores nuevos durante la caída;
- recarga o reapertura de pestañas cuando ya no existe servidor;
- guardado inmediato del resultado histórico mientras la base/host están fuera;
- tolerancia si también cae el router o se desconectan entre sí los celulares;
- consenso bizantino ni defensa contra un navegador manipulado;
- secreto de respuestas frente a quien inspeccione el snapshot;
- consenso formal de nivel Raft/Paxos ante particiones arbitrarias;
- escalabilidad P2P para grandes cantidades de jugadores.

## Decisiones y trade-offs

### Disponibilidad sobre secreto

La respuesta viaja dentro del snapshot porque el líder debe validar intentos sin Node. Esto permite
continuar, pero un usuario técnico puede inspeccionarla. Para una demo académica se priorizó la
disponibilidad; un producto competitivo necesitaría otro modelo, por ejemplo ejecución confiable,
compromisos criptográficos o validación redundante.

### Memoria sobre persistencia durable

Guardar snapshots y recursos en memoria es simple y rápido, pero no sobrevive a recargas. IndexedDB
ampliaría esa garantía, a cambio de migraciones, expiración, seguridad y recuperación más complejas.

### Malla completa sobre relay

La malla elimina un nuevo punto central de fallo y encaja en cinco jugadores, pero usa conexiones
cuadráticas. Para más participantes convendría un SFU, relay o una topología parcial, que volvería a
introducir infraestructura adicional.

### Elección determinista sobre consenso completo

Escoger el mayor `peerId` permite acuerdo rápido en una LAN estable. No proporciona log replicado,
términos durables o reconciliación formal. La solución es proporcional al alcance de la prueba.

### Base fuera del camino crítico

PostgreSQL conserva historia y puede usar una concesión de líder en el clúster Node opcional, pero
no recibe cada tick. Esto evita que una base lenta congele el juego y permite continuidad P2P; el
costo es que una partida terminada totalmente offline no se persiste en ese momento.

## Preguntas difíciles y respuestas cortas

### “¿Por qué PostgreSQL o etcd no resuelven la caída?”

Porque al desconectar la laptop también puede perderse la ruta hacia esos servicios, y una base no
ejecuta la interfaz ni conecta celulares. La ronda viva necesita cómputo, estado y comunicación en
los dispositivos sobrevivientes. etcd ayudaría a coordinar servidores alcanzables; no reemplaza
la malla entre navegadores en este despliegue de una sola laptop.

### “¿Esto sigue en memoria caliente?”

Sí. La continuidad funciona precisamente porque cada navegador mantiene una réplica caliente en
memoria. Lo que se elimina es la dependencia de la memoria de la laptop master. No se promete
persistencia tras cerrar todos los participantes.

### “¿Por qué se llama P2P si al inicio usa servidor?”

Porque el servidor hace bootstrap y señalización, pero los DataChannels posteriores conectan
directamente a los navegadores. P2P no implica arranque sin infraestructura; implica que el camino
de comunicación de respaldo no pasa por el servidor.

### “¿Cómo saben que el servidor cayó y no está lento?”

No pueden saberlo con certeza absoluta. Usan timeout, periodo de gracia y mayoría, una aproximación
práctica de detector de fallos para una LAN controlada.

### “¿Cómo evitan dos líderes?”

Todos calculan el mayor `peerId` sobre los jugadores vivos; solo ese peer ejecuta timers y muta el
estado. Los demás aceptan `GAME/STATE` exclusivamente desde el `leaderId` elegido.

### “¿Cómo sabemos que no quedó un timer viejo en Node?”

La prueba termina forzosamente el proceso y después exige una respuesta procesada y una nueva ronda
con `server.isAlive() === false`.

### “¿Qué pasa con las imágenes?”

Antes de la caída cada jugador convierte las rutas de todas las rondas en data URLs. Si una imagen
falla, el SVG embebido permanece como fallback.

### “¿Por qué máximo cinco?”

Una malla completa tiene `N(N−1)/2` conexiones. Cinco jugadores producen diez canales entre
jugadores, un límite razonable y comprobable para celulares en una demo.

### “¿Es Bully puro?”

Es una adaptación. Conserva la prioridad del identificador mayor, pero usa la membresía ya conocida
por heartbeats para calcular al ganador y un mensaje `LEADER` para confirmarlo.

## Guion sugerido de cinco minutos

### 1. Problema (30 segundos)

“El host central llevaba reloj, respuestas y recursos. Si solo cerrábamos Node, los WebSockets
morían y el juego se congelaba. La meta fue mover la capacidad de continuidad a los jugadores.”

### 2. Preparación (60 segundos)

“Node señaliza una malla WebRTC. En paralelo entrega snapshots completos y cada celular precarga
las siluetas. Estos dos avisos confirman que existen canal y datos antes de la caída.”

### 3. Detección y elección (60 segundos)

“Los peers intercambian heartbeats. Tras timeout, gracia y mayoría, eligen al jugador vivo con
mayor `peerId`. `/master` observa pero no compite. Solo el ganador arranca el motor.”

### 4. Continuidad (60 segundos)

“El líder reconstruye timers desde `timeLeft`, procesa `ACTION`, actualiza Lamport y distribuye
`GAME` más snapshots `STATE`. Los demás son seguidores y pueden reemplazarlo.”

### 5. Evidencia (60 segundos)

“La prueba mata el único proceso Node, exige el mismo líder en ambos navegadores, observa el reloj,
envía una respuesta, comprueba convergencia y espera una ronda nueva con Node aún muerto.”

### 6. Límite honesto (30 segundos)

“La garantía cubre Clásico, jugadores ya conectados y pestañas abiertas. No es persistencia durable
ni consenso bizantino; es failover P2P proporcional a una LAN y hasta cinco jugadores.”

## Niveles de evidencia

| Nivel | Evidencia | Fuerza |
|---|---|---|
| 1 | Banner “Servidor fuera” | Visual, pero podría ser cosmético. |
| 2 | Reloj disminuye | Demuestra timer fuera de Node. |
| 3 | Acierto aparece en dos peers | Demuestra acción y replicación. |
| 4 | Siguiente ronda comienza | Demuestra motor y cola offline. |
| 5 | Test mata proceso y hace aserciones | Evidencia automatizada y repetible. |

## Mejoras futuras, ordenadas por impacto

1. Persistir snapshot y recursos en IndexedDB para tolerar recarga.
2. Elegir líder considerando primero `stateVersion` y luego `peerId`, reduciendo el riesgo de
   promover una réplica atrasada.
3. Añadir términos/épocas P2P y reglas de reconciliación al regresar el host.
4. Probar automáticamente la caída del líder P2P y una segunda elección.
5. Extender el motor offline a Relajo y SiluStack.
6. Añadir pruebas con tres a cinco navegadores y pérdida parcial de enlaces.
7. Introducir autenticación de mensajes si los clientes dejan de ser confiables.

## Resumen final

La prueba de fuego se sostiene en seis ideas conectadas:

```text
malla previa
  + snapshot completo
  + recursos precargados
  + detector con mayoría
  + elección de líder
  + motor Clásico en el navegador
= continuidad sin el host
```

Anterior: [09 · Prueba de fuego](09-prueba-de-fuego.md). Volver al
[índice de conceptos](README.md).
