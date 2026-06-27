# Silunet — "¿Qué es esto?"

Proyecto integrador para las materias **Sistemas Distribuidos** y **Gestión
para la Verificación y Validación de Software** (PUCE Sede Manabí).

Juego de adivinanza de siluetas en tiempo real, estilo Kahoot/trivia visual,
pensado para una feria de exposición ("Casa Abierta"): el público se conecta
desde el celular escaneando un QR, y una pantalla maestra proyecta el estado
del juego en vivo.

## Reglas del juego

- El servidor muestra una silueta + la palabra oculta con guiones
  (ej. `_ e _ a _ t e`), agrupada por categoría (ej. "Computadores").
- Cada celular conectado puede escribir su intento en cualquier momento.
- Cada N segundos sin acierto se revela una letra adicional, automáticamente.
- Hay un tiempo límite por ronda (ej. 24s); si nadie acierta, la ronda cierra
  sin ganador.
- Todos los que acierten antes del límite ganan puntos, pero el puntaje
  depende de la velocidad: `puntos = puntos_base * (tiempo_restante / tiempo_total)`.
- Ranking acumulado con medallas (oro/plata/bronce) al final de la partida
  (varias rondas, ej. 20 preguntas).

## Los 4 ejes técnicos — INNEGOCIABLES

Este es un sistema distribuido, no un CRUD centralizado. El backend corre
sobre **un clúster de 3 nodos simétricos** (no un solo servidor): es la única
forma de que estos 4 ejes sean reales y no decorativos.

1. **Comunicación bidireccional y concurrencia real** — WebSockets puro
   (librería `ws`), nunca HTTP polling. Mínimo 3 clientes simultáneos sobre
   el mismo estado.
2. **Sincronización y ordenamiento lógico** — relojes de Lamport para
   ordenar eventos (ej. quién acertó primero) de forma consistente entre
   nodos, sin depender de la latencia de red de cada celular.
3. **Exclusión mutua y consistencia de datos** — cuando 2+ celulares
   aciertan casi al mismo tiempo en nodos distintos, el acceso al marcador
   se serializa con token o Ricart-Agrawala, y el nuevo estado se
   difunde (broadcast) a todos los nodos y a la pantalla maestra.
4. **Tolerancia a fallos y reconfiguración dinámica** — heartbeats entre
   nodos; si cae el coordinador, los demás eligen uno nuevo (algoritmo del
   Matón / Bully) sin congelar la partida para el público.

Si una pieza de código no demuestra claramente uno de estos 4 ejes, no es
prioritaria. No sobre-diseñar: los ejes deben verse en el código, no
ocultarse detrás de una librería que los resuelva por nosotros (ej. no usar
Redis como lock/coordinador: eso recentraliza el sistema y mata el sentido
de la elección de líder).

## Stack

- **Servidor**: Node.js + TypeScript, librería `ws` (WebSocket puro).
  Un solo código de servidor que se ejecuta 3 veces (`NODE_ID`, `PORT`,
  `PEERS` distintos por instancia vía variables de entorno).
- **Cliente**: HTML + CSS + JS plano, sin build, para que abra desde el QR
  sin instalar nada.
- **Sin Redis ni base de datos externa** en v1: el estado vive en memoria y
  se replica entre nodos (coordinador → seguidores).

## Sitemap (3 páginas independientes, cada una con su propio WebSocket)

- `/join` — lo que abre el QR. Pide nick, asigna el celular a un nodo,
  redirige a `/play`.
- `/play` — cliente del celular: silueta, palabra con guiones, temporizador,
  campo de intento, tu puntaje, ranking en vivo.
- `/master` — pantalla maestra (solo lectura) para proyectar: silueta
  grande, ranking con medallas, panel de salud del clúster (nodos
  activos / quién es coordinador).

## Componentes de V&V (la otra mitad del proyecto)

SonarQube (calidad), Jenkins (CI/CD), Cypress o Selenium (e2e), Burp Suite
(seguridad), y validación distribuida propia: bots que mandan intentos
concurrentes y comprueban que el ranking respeta el orden de Lamport, más
pruebas de caos que matan al coordinador y verifican continuidad.

## Cómo quiero que trabajes en este repo

- Avanza en pasos pequeños y verificables. No generes el sistema completo de
  una sola vez: yo voy aprobando cada pieza.
- Prioriza que el juego sea **jugable y divertido en un solo nodo** antes de
  tocar nada distribuido. Recién después se parte a 3 nodos.
- Cuando implementes uno de los 4 ejes, dilo explícitamente en el commit o
  en tu respuesta ("esto implementa el Eje 3: exclusión mutua") para que
  quede trazable de cara a la defensa del proyecto.
- Si algo no está definido en este archivo (ej. el banco de palabras, el
  estilo visual de las páginas), pregúntame antes de asumir.
- No instales dependencias nuevas sin decírmelo primero y explicar por qué
  hacen falta.
