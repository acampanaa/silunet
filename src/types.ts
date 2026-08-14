// 'voting': entre que el master pulsa "Iniciar partida" y se cierra la
// votación de categoría entre los jugadores conectados.
// 'countdown': entre que se conoce la siguiente ronda y arranca el timer real
// -> ventana de la cuenta regresiva "3, 2, 1, ¡YA!" (sincroniza al público).
export type GamePhase = 'waiting' | 'voting' | 'countdown' | 'playing' | 'roundEnd' | 'gameEnd';

// 'clasico': rondas fijas, con votación de temática y dificultad.
// 'relajo' : sin votación ni temáticas — el banco completo mezclado y un
//            RELOJ COMPARTIDO por todo el público que solo se alarga cuando
//            alguien acierta. Termina cuando ese reloj llega a cero.
export type GameMode = 'clasico' | 'relajo' | 'silustack';

export type StackPieceKind = 'I' | 'O' | 'T' | 'L' | 'J' | 'S' | 'Z';
export type StackAction = 'left' | 'right' | 'rotate' | 'down' | 'drop';

export interface StackPiece {
  kind: StackPieceKind;
  rotation: number;
  x: number;
  y: number;
  color: number;
}

export interface StackBoardState {
  playerId: string;
  nick: string;
  board: number[][];
  active: StackPiece | null;
  activeCells: Array<[number, number]>;
  nextKind: StackPieceKind;
  pieces: number;
  lines: number;
  combo: number;
  level: number;
  lastClear: number;
  unlocked: boolean;
  locked: boolean;
  eliminated: boolean;
  eliminatedAt?: number;
}

export interface StackState {
  width: number;
  height: number;
  round: number;
  survivors: number;
  boards: StackBoardState[];
}

export interface Player {
  id: string;
  nick: string;
  score: number;
  // Índice del avatar elegido en /join (ver public/avatars.js). Es solo un
  // número: viaja gratis dentro de RANKING, que se difunde constantemente.
  avatarId?: number;
  // Clave pública de una foto personalizada. La imagen no viaja en snapshots;
  // los clientes la descargan una vez desde /api/avatar/:key.
  avatarKey?: string;
  // v2: identidad persistente del jugador (token guardado en su propio celular).
  // Viaja en el snapshot para que el coordinador electo sepa a quién persistir.
  token?: string;
  // Eje 4 (resiliencia de cliente): false mientras el celular está desconectado a
  // mitad de partida. El jugador NO se borra del mapa -> conserva su puntaje para
  // poder reconectarse (mismo token) sin perder lo acumulado en la partida en curso.
  connected?: boolean;
  // Eje 4: nodo donde vive el WebSocket real de este jugador ahora mismo. Si ese
  // nodo cae, es lo único que permite distinguir "sigue conectado" de "fantasma"
  // (ver Game.pruneToLivingNodes).
  originNode?: string;
}

// Nivel de una palabra. NO se anota a mano: se deriva del largo de la palabra
// (ver wordBank.difficultyOf), así el banco no se puede desincronizar.
export type Difficulty = 'facil' | 'intermedio' | 'dificil';

export interface WordEntry {
  word: string;
  category: string;
  svg: string;
  hint: string;
  difficulty: Difficulty;
  // Silueta en archivo (public/images/). Si está, el cliente la muestra en
  // lugar del SVG inline; si no, `svg` sigue siendo el camino normal.
  image?: string;
  // El objeto a color. Solo se manda al CERRAR la ronda: antes regalaría
  // la respuesta.
  reveal?: string;
}

export interface RoundState {
  wordEntry: WordEntry;
  hiddenWord: string[];
  revealOrder: number[];
  revealedCount: number;
  timeLeft: number;
  totalTime: number;
  // lamport: timestamp Lamport del acierto — define la POSICIÓN LÓGICA de llegada.
  // Los puntos NO se guardan aquí: se calculan al cerrar la ronda según esa posición y N.
  solvers: Array<{ id: string; lamport: number }>;
  hintedPlayerIds: string[];
}

export interface RankEntry {
  nick: string;
  score: number;
  connected: boolean;
  avatarId?: number;
  avatarKey?: string;
}

// v2: resultado final de una partida, emitido por Game como evento interno
// 'game_over'. Lo consume server.ts SOLO en el coordinador para persistirlo.
// No es un mensaje de red: es el puente entre la lógica de juego y la DB.
export interface FinalStanding {
  token?: string;   // identidad persistente (puede faltar si el jugador no la tenía)
  nick: string;
  score: number;
  position: number; // 1 = ganador de la partida
  medalla: 'oro' | 'plata' | 'bronce' | null;
}

export interface GameOverResult {
  gameId: string;
  mode: GameMode;
  totalRounds: number;
  standings: FinalStanding[];
}

// v2: perfil agregado del jugador (se calcula desde la DB, no se almacena).
export interface PerfilReciente {
  partida: string;
  puesto: number;
  puntos: number;
  medalla: string | null;
}

export interface Perfil {
  nick: string;
  avatarId: number;
  avatarKey?: string;
  creadoEn: string;
  partidasJugadas: number;
  partidasGanadas: number;
  puntosAcumulados: number;
  medallas: { oro: number; plata: number; bronce: number };
  recientes: PerfilReciente[];
}

// v2.1: "salón de la fama" — ranking acumulado de TODAS las partidas jugadas
// (no solo la actual), calculado desde la misma DB del perfil individual.
export interface HallOfFameEntry {
  nick: string;
  avatarId: number;
  avatarKey?: string;
  partidasJugadas: number;
  partidasGanadas: number;
  puntosAcumulados: number;
  oro: number;
  plata: number;
  bronce: number;
}

export interface RecentGamePlayer {
  nick: string;
  avatarId: number;
  avatarKey?: string;
  puntos: number;
  puesto: number;
  medalla: 'oro' | 'plata' | 'bronce' | null;
}

export interface RecentGame {
  nombre: string;
  jugadaEn: string;
  modo: GameMode;
  totalRondas: number;
  ganador: string | null;
  jugadores: RecentGamePlayer[];
}

// Snapshot completo del estado autoritativo del juego.
// Viaja por el canal inter-nodo (N_REPLICATE) para que cada seguidor mantenga
// una réplica pasiva y pueda continuar la partida si es promovido a coordinador.
export interface GameSnapshot {
  phase: GamePhase;
  currentGameId?: string;
  pendingGameOverResult?: GameOverResult | null;
  rounds: WordEntry[];
  currentRoundIndex: number;
  round: RoundState | null;
  players: Player[];
  lamport: number;
  // Eje 4: anfitrión vigente. Viaja en el snapshot para que un coordinador
  // promovido por Bully no pierda de vista quién puede continuar la partida.
  hostId?: string | null;
  // Votación de categoría (ver GamePhase 'voting'): playerId -> categoría elegida.
  votes: Record<string, string>;
  difficultyVotes: Record<string, string>;
  voteCategories: string[];
  pendingTotalRounds: number;
  // Palabras de partidas recientes, para no repetirlas en la siguiente.
  recentWords: string[];
  mode: GameMode;
  sharedClock: number;
  cleared: number;
  stack: StackState | null;
  // Ventana durable de idempotencia. Evita reaplicar una jugada si el cliente
  // reintenta al cambiar de replica o si el coordinador cae tras confirmarla.
  processedActionIds?: string[];
}

export interface P2PPeerDescriptor {
  peerId: string;
  role: 'player' | 'master';
  playerId?: string;
  nick?: string;
}

// Telemetria que cada navegador adjunta a su PING de control. El servidor no
// confia en estos valores para decidir el juego; solo los agrega para que la
// pantalla maestra pueda explicar el estado del sistema distribuido en vivo.
export interface BrowserTelemetry {
  serverRttMs?: number;
  openPeers: number;
  openPlayerPeers: number;
  knownPlayers: number;
  meshReady: boolean;
  failoverActive: boolean;
  serverAlive: boolean;
  leaderId?: string | null;
  stateVersion: number;
  offlineAssetsReady: boolean;
}

export type MonitorHealth = 'healthy' | 'warning' | 'offline';

export interface MonitorParticipant {
  connectionId: string;
  role: 'player' | 'master';
  nick: string;
  playerId?: string;
  p2pPeerId?: string;
  nodeId: string;
  connectedAt: number;
  lastSeenAt: number;
  heartbeatAgeMs: number;
  status: MonitorHealth;
  disconnectedAt?: number;
  telemetry?: BrowserTelemetry;
}

export interface MonitorNode {
  id: string;
  up: boolean;
  isCoordinator: boolean;
  heartbeatAgeMs: number | null;
  clients: number;
  players: number;
  masters: number;
}

export interface MonitorNodeReport {
  nodeId: string;
  generatedAt: number;
  participants: MonitorParticipant[];
}

export interface DistributedMonitorSnapshot {
  generatedAt: number;
  coordinatorId: string;
  electionInProgress: boolean;
  participants: MonitorParticipant[];
  nodes: MonitorNode[];
  thresholds: {
    heartbeatIntervalMs: number;
    clientTimeoutMs: number;
    peerTimeoutMs: number;
    nodeTimeoutMs: number;
    serverTimeoutMs: number;
  };
}

// Mensajes servidor → cliente
export type S2C = (
  // v2: token = identidad persistente (el celular lo guarda); returning = "ya jugaste antes"
  // score = puntaje autoritativo actual (para reconstruirlo tras una reconexión);
  // reconnected = true si esta identidad ya tenía puntaje en la partida en curso.
  | { type: 'WELCOME'; playerId: string; nick: string; playerCount: number; token: string; returning: boolean; score: number; reconnected: boolean; avatarId: number; avatarKey?: string }
  | { type: 'PLAYER_COUNT'; count: number }
  | { type: 'PLAYER_LEFT'; nick: string }  // Eje 4: "Jugador X: Desconectado"
  // Eje 4 (capa navegador): quién manda en la sala. `hostId` es el jugador
  // promovido a anfitrión cuando NO queda ninguna pantalla maestra viva en el
  // clúster; vuelve a null en cuanto reaparece una /master.
  | { type: 'HOST_CHANGED'; hostId: string | null; hostNick: string | null; masterOnline: boolean }
  // Votación: el master pulsó "Iniciar partida" -> se abre una ventana de
  // `durationSec` donde cada jugador elige UNA categoría (las reales del
  // banco) y UNA dificultad. Son dos votos independientes en la misma ventana.
  | { type: 'VOTE_START'; categories: string[]; difficulties: string[]; difficultyLabels: Record<string, string>; durationSec: number }
  | { type: 'VOTE_COUNTDOWN'; secondsLeft: number }
  // Conteo en vivo — se difunde cada vez que alguien vota o cambia su voto.
  | { type: 'VOTE_TALLY'; tally: Record<string, number>; totalVotes: number;
      difficultyTally: Record<string, number>; totalDifficultyVotes: number }
  // Se cerró la votación: categoría y dificultad más votadas (empate se decide
  // al azar; si nadie votó, al azar entre todas). Inmediatamente después llega
  // el ROUND_PREVIEW de la primera ronda.
  | { type: 'VOTE_RESULT'; winner: string; difficulty: string; difficultyLabel: string }
  // Se conoce la siguiente ronda (categoría/silueta/palabra) pero el timer real
  // TODAVÍA no arrancó -> los clientes pintan la pantalla y esperan COUNTDOWN.
  | { type: 'ROUND_PREVIEW'; roundNumber: number; totalRounds: number; category: string; svg: string; image?: string; hiddenWord: string }
  // "3, 2, 1, ¡YA!" — value 3→1 cuenta, 0 = arranca (mismo instante que ROUND_START).
  // La emite el coordinador para TODOS al mismo tiempo (Eje 1): si cada celular
  // la mostrara por su cuenta, el timer real ya estaría corriendo mientras el
  // jugador todavía ve "3, 2, 1" y perdería segundos reales de la ronda.
  | { type: 'COUNTDOWN'; value: number }
  | { type: 'ROUND_START'; roundNumber: number; totalRounds: number; category: string; svg: string; image?: string; hiddenWord: string; timeLeft: number; totalTime: number }
  | { type: 'TICK'; timeLeft: number; hiddenWord: string }
  // Modo Relajo: pulso del reloj comunitario. `cleared` es el contador de
  // siluetas que el grupo lleva despejadas (el récord que intenta batir).
  | { type: 'SHARED_CLOCK'; secondsLeft: number; cleared: number; bonusPerSolver: number }
  | { type: 'STACK_STATE'; state: StackState }
  | { type: 'CORRECT_ANSWER'; nick: string; playerId: string; position: number; lamport: number; usedHint: boolean }
  | { type: 'HINT_RESULT'; status: 'revealed' | 'locked' | 'unavailable'; hint?: string; secondsLeft?: number; penaltyPercent?: number; alreadyUsed?: boolean }
  | { type: 'WRONG_ANSWER' }
  | { type: 'ALREADY_SOLVED' }
  | { type: 'ROUND_END'; word: string; reveal?: string; solvers: Array<{ nick: string; points: number; position: number; lamport: number; usedHint: boolean }> }
  | { type: 'RANKING'; entries: RankEntry[]; final: boolean }
  // v2: perfil persistente solicitado por el celular (null si el token no existe)
  | { type: 'PROFILE'; profile: Perfil | null }
  | { type: 'AVATAR_UPDATED'; avatarId: number; avatarKey: string | null }
  | { type: 'IDENTITY_UPDATED'; nick: string }
  // v2.1: salón de la fama solicitado por la pantalla maestra
  | { type: 'HALL_OF_FAME'; top: HallOfFameEntry[]; recentGames: RecentGame[] }
  // Eje 4: salud del clúster empujada a la pantalla maestra (sin polling).
  // electionInProgress: hay una elección Bully en curso ahora mismo.
  | { type: 'CLUSTER_STATE'; nodes: Array<{ id: string; up: boolean; isCoordinator: boolean }>; electionInProgress: boolean }
  // Eje 2 + Eje 3: pulso del "motor" distribuido para el panel didáctico de
  // /master — reloj de Lamport del coordinador y tamaño de la cola del
  // candado del marcador, en vivo.
  | { type: 'ENGINE_STATE'; lamport: number; mutexWaiting: number }
  // Eje 3: evento puntual de la cola del candado (para el log en vivo del
  // panel didáctico) — se emite justo cuando un acierto tiene que esperar.
  | { type: 'MUTEX_QUEUED'; waiting: number }
  // El servidor solo presenta navegadores y entrega la última réplica. Una vez
  // abiertos los DataChannels, estos mensajes dejan de ser necesarios.
  | { type: 'P2P_PEERS'; selfId: string; peers: P2PPeerDescriptor[] }
  | { type: 'P2P_SIGNAL'; source: string; data: unknown }
  // `spare` es la MUNICIÓN del motor P2P: un lote de palabras extra, con sus
  // imágenes precacheables, para que el líder de la malla pueda arrancar una
  // partida NUEVA sin servidor. Sin esto, cuando se agotan `snapshot.rounds` la
  // continuidad se acaba: el banco de palabras vive en el servidor.
  | { type: 'P2P_SNAPSHOT'; revision: number; snapshot: GameSnapshot; spare: WordEntry[] }
  | { type: 'DISTRIBUTED_MONITOR'; snapshot: DistributedMonitorSnapshot }
  | { type: 'PONG'; ts: number; clientTs?: number }
  | { type: 'STATE_STALE'; expectedVersion: number; receivedVersion: number }
  | { type: 'ERROR'; message: string }
) & {
  /** Índice durable confirmado por mayoría que produjo este estado. */
  stateVersion?: number;
  /** Timestamp lógico del coordinador que ordenó el evento. */
  lamport?: number;
};

// Mensajes nodo → nodo (inter-cluster)
export type N2N =
  | { type: 'N_HELLO';         nodeId: string; term: number; coordinatorId: string; lamport: number }
  | { type: 'N_HEARTBEAT';     nodeId: string; term: number; coordinatorId: string; lamport: number }
  | { type: 'N_REPLICATE';     leaderId: string; term: number; index: number; snapshot: GameSnapshot; lamport: number }
  | { type: 'N_REPLICATE_ACK'; nodeId: string; term: number; index: number; lamport: number }
  | { type: 'N_STATE_REQUEST'; nodeId: string; requestId: string; lamport: number }
  | { type: 'N_STATE_RESPONSE'; nodeId: string; requestId: string; leaderId: string; term: number; index: number; snapshot: GameSnapshot | null; lamport: number }
  // Eje 4 — Algoritmo del Matón (Bully)
  | { type: 'N_ELECTION';      nodeId: string; term: number; lamport: number }
  | { type: 'N_ALIVE';         nodeId: string; term: number; lamport: number }
  | { type: 'N_COORDINATOR';   nodeId: string; term: number; lamport: number }
  | { type: 'N_MONITOR_REPORT'; report: MonitorNodeReport; lamport: number }
  | { type: 'N_FORWARD_JOIN';  playerId: string; nick: string; token: string | null; avatarId?: number; originNode: string; lamport: number }
  // Cambio de avatar: el seguidor lo reenvía al coordinador (solo él tiene DB)
  | { type: 'N_FORWARD_SET_AVATAR'; playerId: string; token: string; avatarId: number; originNode: string; lamport: number }
  | { type: 'N_FORWARD_SET_NICK'; playerId: string; token: string; nick: string; originNode: string; lamport: number }
  | { type: 'N_FORWARD_CUSTOM_AVATAR'; playerId: string; token: string; dataUrl: string; originNode: string; lamport: number }
  | { type: 'N_FORWARD_GUESS'; playerId: string; word: string; originNode: string; actionId?: string; stateVersion?: number; lamport: number }
  | { type: 'N_FORWARD_HINT';  playerId: string; originNode: string; actionId?: string; stateVersion?: number; lamport: number }
  | { type: 'N_FORWARD_START'; totalRounds: number; mode: GameMode; requesterId: string; originNode: string; actionId?: string; stateVersion?: number; lamport: number }
  | { type: 'N_FORWARD_END_GAME'; requesterId: string; originNode: string; actionId?: string; stateVersion?: number; lamport: number }
  | { type: 'N_FORWARD_STACK_ACTION'; playerId: string; action: StackAction; originNode: string; actionId?: string; stateVersion?: number; lamport: number }
  // Votación de categoría: seguidor reenvía el voto de su jugador al coordinador
  | { type: 'N_FORWARD_VOTE';  playerId: string; kind: 'category' | 'difficulty'; option: string; originNode: string; actionId?: string; stateVersion?: number; lamport: number }
  // v2: seguidor pide al coordinador el perfil de un jugador (solo el coord. tiene DB)
  | { type: 'N_FORWARD_PROFILE'; playerId: string; token: string; originNode: string; lamport: number }
  // v2.1: seguidor pide al coordinador el salón de la fama para su pantalla maestra
  | { type: 'N_FORWARD_HALL_OF_FAME'; requesterId: string; originNode: string; lamport: number }
  | { type: 'N_PLAYER_LEFT';   playerId: string; lamport: number }
  | { type: 'N_FORWARD_OFFLINE_RESULT'; result: GameOverResult; lamport: number }
  | { type: 'N_BROADCAST';     payload: S2C; lamport: number }
  | { type: 'N_SEND_TO';       playerId: string; payload: S2C; lamport: number };

// Mensajes cliente → servidor
export type C2S = (
  | { type: 'JOIN'; nick: string; token?: string | null; avatarId?: number }  // v2: token persistente opcional
  | { type: 'SET_AVATAR'; token: string; avatarId: number }  // cambiar avatar desde el perfil
  | { type: 'SET_NICK'; token: string; nick: string }
  | { type: 'SET_CUSTOM_AVATAR'; token: string; dataUrl: string }
  | { type: 'MASTER_JOIN' }
  | { type: 'GUESS'; word: string; lamport: number }
  | { type: 'REQUEST_HINT' }
  | { type: 'START_GAME'; totalRounds?: number; mode?: GameMode }
  | { type: 'END_GAME' }  // el master corta la partida antes de tiempo
  | { type: 'STACK_ACTION'; action: StackAction }
  // Voto de categoría o de dificultad — uno de cada por jugador, se puede cambiar
  | { type: 'CAST_VOTE'; kind: 'category' | 'difficulty'; option: string }
  | { type: 'GET_PROFILE'; token: string }  // v2: el celular pide su perfil persistente
  | { type: 'GET_HALL_OF_FAME' }  // v2.1: el master pide el salón de la fama
  // El celular abre (o cierra) el monitor distribuido. Es una suscripción
  // explícita: el snapshot completo NO se le empuja mientras no lo esté mirando.
  | { type: 'MONITOR_SUBSCRIBE'; active: boolean }
  // Eje 4: el líder de la malla sube una partida que se jugó SIN servidor.
  // No es estado vivo —eso lo manda el servidor— sino un hecho ya cerrado que
  // solo falta escribir en el historial. `gameId` lo hace idempotente.
  | { type: 'OFFLINE_RESULT'; result: GameOverResult }
  | { type: 'P2P_REGISTER'; peerId: string; role: 'player' | 'master'; playerId?: string; nick?: string }
  | { type: 'P2P_SIGNAL'; target: string; data: unknown }
  | { type: 'PING'; l?: number; sentAt?: number; telemetry?: BrowserTelemetry }
) & {
  actionId?: string;
  stateVersion?: number;
  lamport?: number;
};  // Eje 4: latido del navegador al servidor
