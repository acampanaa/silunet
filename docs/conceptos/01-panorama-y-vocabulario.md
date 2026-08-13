# 01 · Panorama y vocabulario

## El escenario

Silunet se presenta en una red local: una laptop ejecuta Node.js y varios celulares abren el
juego desde el navegador. La exigencia principal es que una partida Clásica ya iniciada no se
congele si la laptop se apaga o pierde la red.

La dificultad no es solamente mostrar una pantalla. Al caer la laptop también desaparecen:

- el proceso que llevaba el reloj;
- el lugar que validaba respuestas;
- la copia considerada autoritativa del marcador;
- el servidor HTTP de siluetas e imágenes;
- el WebSocket que distribuía eventos.

Para continuar, los navegadores deben haber recibido antes todo lo necesario y deben ponerse
de acuerdo sobre quién coordina.

## Componentes del sistema

| Componente | Responsabilidad mientras el host vive | Papel después de la caída |
|---|---|---|
| **Laptop host** | Sirve HTML/JS/imágenes, acepta WebSockets, ejecuta el juego y señaliza WebRTC. | Desaparece de la ejecución. |
| **Jugador** | Envía acciones, recibe eventos, conserva snapshot y recursos, participa en la malla. | Puede ser líder o seguidor P2P. |
| **`/master`** | Inicia y observa la partida; también recibe una réplica para mostrarla. | Puede seguir observando si está en otro dispositivo, pero no es elegible como líder. |
| **PostgreSQL/SQLite** | Guarda identidades y resultados de partidas terminadas. | No interviene en la continuidad de la ronda. |
| **Router/AP** | Permite que todos se alcancen en la misma LAN. | Mantiene la comunicación directa entre celulares aunque la laptop desaparezca. |

## Vocabulario esencial

### Nodo

Un participante capaz de comunicarse y mantener parte del estado. En la prueba P2P, cada
navegador jugador actúa como nodo. La laptop también es un nodo mientras está disponible.

### Peer

Significa “par”. En una conexión P2P los extremos se comunican directamente y ninguno necesita
reenviar cada mensaje a través del servidor. En el código, cada pestaña recibe un `peerId`.

### Host

La laptop que arranca el sistema. “Host” no significa que sea imprescindible para siempre:
durante el arranque sí lo es; durante el failover deja de participar.

### Estado autoritativo

La copia que tiene permiso de decidir el siguiente estado. Antes de la caída pertenece al motor
Node.js. Después de la elección pertenece al navegador líder.

### Réplica

Una copia del estado autoritativo. No basta con copiar el puntaje: se necesitan fase, ronda,
palabra, tiempo restante, jugadores, aciertos, reloj de Lamport y la cola de futuras palabras.

### Réplica caliente

Una réplica que se actualiza durante la partida y está lista para asumir pronto. En Silunet vive
en memoria JavaScript dentro de cada pestaña. “Caliente” no equivale a “persistente”: si se
recarga la pestaña después de perder el host, esa copia se pierde.

### Failover

Cambio del componente autoritativo después de un fallo. Aquí significa pasar del motor Node.js
a un motor JavaScript dentro del navegador líder.

### Coordinador o líder

El único nodo que acepta acciones como definitivas, avanza el reloj y publica el nuevo estado.
La regla de “un solo escritor” reduce resultados contradictorios.

### Disponibilidad y consistencia

- **Disponibilidad:** el jugador todavía puede interactuar y el reloj continúa.
- **Consistencia:** los sobrevivientes aceptan el mismo líder y convergen al mismo estado.

La prueba de fuego comprueba ambas de forma práctica: el juego responde después de matar Node y
los dos navegadores reportan el mismo `leaderId` y el mismo avance de ronda.

## Modelo de fallos que se asume

El sistema está pensado principalmente para un fallo por detención (*crash-stop*): el host deja
de emitir mensajes porque se apagó, se mató el proceso o salió de la red. No se supone que el
host envíe datos maliciosos ni que un jugador manipule deliberadamente el protocolo.

También se asume que:

- quedan al menos dos jugadores con DataChannels abiertos;
- la LAN permite comunicación cliente a cliente;
- las pestañas no se recargan;
- ya existe un snapshot de una partida Clásica;
- los recursos offline terminaron de cargarse.

## Dos arquitecturas que conviven en el repositorio

El proyecto conserva un clúster Node de tres procesos para pruebas de Lamport, mutex y Bully
servidor-servidor. Sin embargo, la **prueba de fuego principal** usa otro camino: un solo proceso
Node y una malla WebRTC entre navegadores. No deben mezclarse al explicarlos.

Una forma clara de decirlo es:

> El clúster Node es una ruta opcional de V&amp;V; la continuidad del despliegue final se logra con
> réplicas y elección dentro de los navegadores.

## Comprobación rápida

Si puedes responder estas preguntas, ya tienes la base:

1. ¿Quién es autoritativo antes y después de la caída?
2. ¿Por qué la base de datos no resuelve la continuidad de una ronda?
3. ¿Qué diferencia hay entre una réplica caliente y persistencia durable?
4. ¿Por qué `/master` no debe ganar una elección?

Anterior: [Índice](README.md). Siguiente: [02 · Red y transportes](02-red-y-transportes.md).
