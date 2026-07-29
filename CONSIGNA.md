Silunet — Trivia de Siluetas Distribuida en Tiempo Real
(PUCE-SM Silhouette Guesser)

Proyecto Práctico 2 — Materias Sistemas Distribuidos y Gestión para la Verificación y Validación de Software · PUCE Sede Manabí · Ingeniería de Software.


1. Título y Justificación del Proyecto

Silunet es una plataforma de entretenimiento interactivo en tiempo real en la que múltiples jugadores independientes compiten simultáneamente intentando adivinar palabras ocultas representadas como siluetas, al estilo de una trivia visual tipo Kahoot. El sistema está diseñado específicamente para captar la atención del público en la Casa Abierta de la facultad: los visitantes escanean un código QR con su teléfono y se unen a la partida de inmediato, sin instalar ninguna aplicación.

¿Por qué este proyecto?

La consigna no pide un CRUD ni un servidor centralizado: pide demostrar ingeniería de sistemas distribuidos real. Silunet corre sobre un clúster de 3 nodos simétricos (no un único servidor) porque esa es la única forma de que los cuatro ejes técnicos de la materia se manifiesten de manera auténtica y no decorativa: comunicación bidireccional concurrente, ordenamiento lógico de eventos, exclusión mutua distribuida y tolerancia a fallos con elección de líder. Un juego masivo, rápido y con público real es el escenario perfecto para estresar y evidenciar en vivo cada uno de esos mecanismos.

Dinámica del juego

- El servidor muestra una silueta junto a la palabra oculta con guiones (ej. _ e _ a _ t e), agrupada por categoría (ej. "Computadores").
- Cada celular conectado puede escribir su intento en cualquier momento.
- Cada ciertos segundos sin acierto se revela una letra adicional de forma automática, y existe un tiempo límite por ronda (ej. 24 s).
- Todos los que acierten antes del límite ganan puntos, pero el puntaje depende de la velocidad: puntos = puntos_base * (tiempo_restante / tiempo_total).
- Al finalizar las rondas se muestra un ranking acumulado con medallas (oro, plata y bronce).

Identidad institucional

La pantalla maestra del stand luce el branding de la PUCE Sede Manabí y proyecta en tiempo real el estado de la partida, el ranking con medallas y el panel de salud del clúster, orientado a la promoción de la carrera de Ingeniería de Software.


2. Arquitectura del Sistema y Conexión Física

El despliegue en el stand de la feria se organiza sobre una red local (LAN) y se estructura conceptualmente en tres capas claramente diferenciadas.

Infraestructura de Red

Un router local (sin necesidad de salida a internet) provisto por el equipo. Todos los nodos —servidores del clúster, pantalla maestra y celulares del público— se conectan a esta red privada vía Wi-Fi.

Capa 1 — Clientes Jugadores (celulares del público)

Dispositivos móviles de los visitantes conectados al Wi-Fi del router. Al escanear el código QR de la pantalla principal, los teléfonos abren /join (ingreso del nick, que asigna el celular a un nodo del clúster) y luego /play: una interfaz web táctil ligera, optimizada para escribir intentos y ver el ranking en vivo. No se instala ninguna aplicación.

Capa 2 — Pantalla Maestra (Dashboard del Stand)

Una laptop conectada a un monitor grande o proyector. Abre la ruta /master en el navegador: un cliente de solo lectura que recibe el estado del juego en tiempo real y lo proyecta para todo el público —la silueta actual, el ranking con medallas en vivo y el panel de salud del clúster (nodos activos y quién es el coordinador actual).

Capa 3 — Clúster de Servidores (3 nodos simétricos)

Tres instancias del mismo proceso Node.js ejecutándose en una o más laptops del equipo, cada una con su propio NODE_ID, PORT y lista de PEERS. Los nodos se comunican entre sí y con los clientes mediante WebSockets puros (librería ws). En condiciones normales uno actúa como coordinador y los otros dos como réplicas.

El nodo coordinador mantiene el estado maestro de la ronda en curso (palabra activa, letras reveladas, cola de intentos y puntajes). Cada cambio de estado se propaga mediante broadcasting hacia los nodos réplica, que conservan en memoria una copia sincronizada de la partida. Deliberadamente no se utiliza ninguna base de datos externa ni almacén clave-valor (como Redis): la replicación del estado entre los propios nodos servidor es, en sí misma, el mecanismo que elimina el punto único de fallo (Single Point of Failure), ya que cualquier réplica posee la información necesaria para asumir el rol de coordinador si el líder cae.


3. Requisitos Técnicos y Funcionales

Para obtener la calificación máxima, el software debe cumplir obligatoriamente con los siguientes cuatro ejes de ingeniería de sistemas distribuidos. Si una pieza de código no demuestra claramente uno de estos ejes, no es prioritaria.

A. Comunicación y Backend en Tiempo Real (Eje 1)

- Prohibición de Polling. Queda terminantemente prohibido el uso de peticiones HTTP cíclicas o repetitivas (fetch, axios o AJAX dentro de un bucle setInterval). El estado del juego no se consulta; se recibe.
- Canal bidireccional y persistente. La comunicación de eventos (envío de un intento, actualización del ranking, revelación de letra) debe ser instantánea mediante WebSockets puros con la librería ws de Node.js, sin abstracciones que oculten el protocolo.
- Empuje de estado (Broadcasting). En cuanto el servidor valida un intento correcto, debe procesar el cambio y empujar (push) de inmediato el nuevo estado de la ronda a todos los celulares y a la pantalla maestra simultáneamente, en pocos milisegundos. El mismo mecanismo aplica para la revelación automática de letras y el cierre de ronda por tiempo.

B. Sincronización y Ordenamiento Lógico — Relojes de Lamport (Eje 2)

- El reto. Dos o más jugadores conectados a nodos distintos pueden enviar el intento correcto en el mismo instante. La latencia de Wi-Fi hace que los mensajes lleguen en orden arbitrario; el sistema no puede depender del reloj físico de cada celular para decidir quién acertó primero.
- Implementación obligatoria. Cada acción de juego lleva adjunto un timestamp de Reloj Lógico de Lamport (L). Al recibir un evento, cada nodo actualiza su reloj según la regla L_local = max(L_local, L_recibido) + 1. El coordinador procesa los intentos garantizando el orden causal, de modo que el ranking respete quién acertó primero independientemente de la latencia de la red.

C. Exclusión Mutua y Consistencia de Datos (Eje 3)

- El reto de la concurrencia. Cuando dos o más celulares conectados a nodos distintos envían el intento correcto casi en el mismo milisegundo, el sistema no puede otorgar el punto completo a ambos ni actualizar el marcador dos veces con datos inconsistentes.
- Implementación obligatoria. Mecanismo de exclusión mutua distribuida basado en paso de token o en el algoritmo de Ricart-Agrawala. El coordinador serializa el acceso al marcador: valida al ganador según el orden de Lamport, actualiza el puntaje y difunde (broadcast) el nuevo estado a todos los seguidores y clientes. Los intentos que lleguen fuera del token reciben un evento de "ronda ya resuelta".
- Modelo de consistencia. Cada nodo mantiene en memoria una réplica local del estado (ronda actual, puntajes, letras reveladas). El coordinador es la fuente de verdad y propaga los cambios a los seguidores tras cada evento, garantizando consistencia secuencial en tiempo real.

D. Tolerancia a Fallos y Reconfiguración Dinámica (Eje 4)

En una casa abierta es común que un visitante escanee el código, juegue unos segundos y se aleje perdiendo la conexión; también puede fallar una laptop del equipo. El sistema debe ser resiliente ante ambos escenarios.

- Detección por heartbeats. Cada celular envía un mensaje de control (heartbeat / ping) al servidor cada 1000 ms. Los nodos del clúster intercambian heartbeats entre sí en el mismo intervalo.
- Caída de cliente. Si un jugador se desconecta o apaga su pantalla, el servidor detecta la ausencia de heartbeats en un umbral máximo de 2 segundos, lo elimina del pool activo y actualiza el marcador ("Jugador X: Desconectado") sin congelar ni reiniciar la partida.
- Elección de líder — Algoritmo del Matón (Bully). Si el coordinador del clúster cae (heartbeat ausente), los nodos restantes ejecutan automáticamente el Algoritmo del Matón para elegir un nuevo coordinador con base en el identificador de mayor prioridad disponible. El nuevo líder retoma el estado replicado y la partida continúa para el público sin interrupción visible.


4. Entregables Esperados y Evaluación

El día de la defensa, el grupo deberá presentar obligatoriamente:

1. Demostración práctica. Ejecución en vivo de una partida con múltiples teléfonos, evidenciando la actualización síncrona en la pantalla gigante. Se probará la concurrencia (dos personas enviando el mismo intento correcto a la vez desde nodos distintos) y la tolerancia a fallos (apagar el Wi-Fi de una laptop del clúster a mitad de la partida y verificar que la elección de líder ocurre sin congelar el juego).
2. Código fuente. Repositorio en GitHub estructurado. El backend debe evidenciar claramente el módulo de relojes de Lamport, el mecanismo de exclusión mutua (token o Ricart-Agrawala), la lógica de heartbeats y el Algoritmo del Matón.
3. Reporte arquitectónico técnico (PDF, máximo 3 páginas):
   - Diagrama de arquitectura de la red local del stand (clúster de 3 nodos + pantalla maestra + celulares).
   - Diagrama de secuencia del ciclo de vida de dos intentos correctos concurrentes: cómo los relojes de Lamport ordenan los eventos y cómo la exclusión mutua decide el ganador.
   - Análisis del comportamiento del clúster ante la caída del coordinador (pasos del Algoritmo del Matón y tiempo de recuperación medido).


5. Stack Tecnológico

- Backend: Node.js + TypeScript con la librería ws (WebSocket puro). Un único archivo de servidor que se lanza tres veces con variables de entorno distintas (NODE_ID, PORT, PEERS) para formar el clúster. El estado de la partida vive en memoria y se replica entre nodos; no se utiliza Redis ni base de datos externa, ya que externalizarlo recentralizaría el sistema y vaciaría de sentido la elección de líder.
- Frontend: HTML5, CSS y Vanilla JavaScript sin proceso de build, para que la interfaz abra directamente desde el QR del celular sin instalar nada. Tres páginas independientes, cada una con su propio WebSocket: /join (registrar nick), /play (jugar) y /master (proyectar en el stand).
- Verificación y Validación (V&V): SonarQube (calidad), Jenkins (CI/CD), Cypress o Selenium (e2e), Burp Suite (seguridad), y validación distribuida propia: bots que envían intentos concurrentes para comprobar que el ranking respeta el orden de Lamport, más pruebas de caos que matan al coordinador y verifican la continuidad de la partida.
