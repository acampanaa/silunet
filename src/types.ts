// 'voting': entre que el master pulsa "Iniciar partida" y se cierra la
// votación de categoría entre los jugadores conectados.
// 'countdown': entre que se conoce la siguiente ronda y arranca el timer real
// -> ventana de la cuenta regresiva "3, 2, 1, ¡YA!" (sincroniza al público).
export type GamePhase = 'waiting' | 'voting' | 'countdown' | 'playing' | 'roundEnd' | 'gameEnd';

export interface Player {
  id: string;
  nick: string;
  score: number;
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

export interface WordEntry {
  word: string;
  category: string;
  svg: string;
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
}

export interface RankEntry {
  nick: string;
  score: number;
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
  partidasJugadas: number;
  puntosAcumulados: number;
  oro: number;
  plata: number;
  bronce: number;
}

export interface RecentGame {
  nombre: string;
  jugadaEn: string;
  totalRondas: number;
  ganador: string | null;
}

// Snapshot completo del estado autoritativo del juego.
// Viaja por el canal inter-nodo (N_REPLICATE) para que cada seguidor mantenga
// una réplica pasiva y pueda continuar la partida si es promovido a coordinador.
export interface GameSnapshot {
  phase: GamePhase;
  rounds: WordEntry[];
  currentRoundIndex: number;
  round: RoundState | null;
  players: Player[];
  lamport: number;
  // Votación de categoría (ver GamePhase 'voting'): playerId -> categoría elegida.
  votes: Record<string, string>;
  voteCategories: string[];
  pendingTotalRounds: number;
}

// Mensajes servidor → cliente
export type S2C =
  // v2: token = identidad persistente (el celular lo guarda); returning = "ya jugaste antes"
  // score = puntaje autoritativo actual (para reconstruirlo tras una reconexión);
  // reconnected = true si esta identidad ya tenía puntaje en la partida en curso.
  | { type: 'WELCOME'; playerId: string; nick: string; playerCount: number; token: string; returning: boolean; score: number; reconnected: boolean }
  | { type: 'PLAYER_COUNT'; count: number }
  | { type: 'PLAYER_LEFT'; nick: string }  // Eje 4: "Jugador X: Desconectado"
  // Votación de categoría: el master pulsó "Iniciar partida" -> se abre una
  // ventana de `durationSec` para que los jugadores elijan entre `categories`
  // (las reales del banco, ver wordBank.getCategoryCounts).
  | { type: 'VOTE_START'; categories: string[]; durationSec: number }
  | { type: 'VOTE_COUNTDOWN'; secondsLeft: number }
  // Conteo en vivo — se difunde cada vez que alguien vota o cambia su voto.
  | { type: 'VOTE_TALLY'; tally: Record<string, number>; totalVotes: number }
  // Se cerró la votación: `winner` es la categoría con más votos (empate se
  // decide al azar; si nadie votó, al azar entre todas). Inmediatamente
  // después llega el ROUND_PREVIEW de la primera ronda con esa categoría.
  | { type: 'VOTE_RESULT'; winner: string }
  // Se conoce la siguiente ronda (categoría/silueta/palabra) pero el timer real
  // TODAVÍA no arrancó -> los clientes pintan la pantalla y esperan COUNTDOWN.
  | { type: 'ROUND_PREVIEW'; roundNumber: number; totalRounds: number; category: string; svg: string; hiddenWord: string }
  // "3, 2, 1, ¡YA!" — value 3→1 cuenta, 0 = arranca (mismo instante que ROUND_START).
  // La emite el coordinador para TODOS al mismo tiempo (Eje 1): si cada celular
  // la mostrara por su cuenta, el timer real ya estaría corriendo mientras el
  // jugador todavía ve "3, 2, 1" y perdería segundos reales de la ronda.
  | { type: 'COUNTDOWN'; value: number }
  | { type: 'ROUND_START'; roundNumber: number; totalRounds: number; category: string; svg: string; hiddenWord: string; timeLeft: number; totalTime: number }
  | { type: 'TICK'; timeLeft: number; hiddenWord: string }
  | { type: 'CORRECT_ANSWER'; nick: string; playerId: string; position: number; lamport: number }
  | { type: 'WRONG_ANSWER' }
  | { type: 'ALREADY_SOLVED' }
  | { type: 'ROUND_END'; word: string; solvers: Array<{ nick: string; points: number; position: number; lamport: number }> }
  | { type: 'RANKING'; entries: RankEntry[]; final: boolean }
  // v2: perfil persistente solicitado por el celular (null si el token no existe)
  | { type: 'PROFILE'; profile: Perfil | null }
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
  | { type: 'ERROR'; message: string };

// Mensajes nodo → nodo (inter-cluster)
export type N2N =
  | { type: 'N_HELLO';         nodeId: string; lamport: number }
  | { type: 'N_HEARTBEAT';     nodeId: string; lamport: number }
  | { type: 'N_REPLICATE';     snapshot: GameSnapshot; lamport: number }
  // Eje 4 — Algoritmo del Matón (Bully)
  | { type: 'N_ELECTION';      nodeId: string; lamport: number }
  | { type: 'N_ALIVE';         nodeId: string; lamport: number }
  | { type: 'N_COORDINATOR';   nodeId: string; lamport: number }
  | { type: 'N_FORWARD_JOIN';  playerId: string; nick: string; token: string | null; originNode: string; lamport: number }
  | { type: 'N_FORWARD_GUESS'; playerId: string; word: string; originNode: string; lamport: number }
  | { type: 'N_FORWARD_START'; totalRounds: number; lamport: number }
  // Votación de categoría: seguidor reenvía el voto de su jugador al coordinador
  | { type: 'N_FORWARD_VOTE';  playerId: string; category: string; originNode: string; lamport: number }
  // v2: seguidor pide al coordinador el perfil de un jugador (solo el coord. tiene DB)
  | { type: 'N_FORWARD_PROFILE'; playerId: string; token: string; originNode: string; lamport: number }
  // v2.1: seguidor pide al coordinador el salón de la fama para su pantalla maestra
  | { type: 'N_FORWARD_HALL_OF_FAME'; requesterId: string; originNode: string; lamport: number }
  | { type: 'N_PLAYER_LEFT';   playerId: string; lamport: number }
  | { type: 'N_BROADCAST';     payload: S2C; lamport: number }
  | { type: 'N_SEND_TO';       playerId: string; payload: S2C; lamport: number };

// Mensajes cliente → servidor
export type C2S =
  | { type: 'JOIN'; nick: string; token?: string | null }  // v2: token persistente opcional
  | { type: 'MASTER_JOIN' }
  | { type: 'GUESS'; word: string; lamport: number }
  | { type: 'START_GAME'; totalRounds?: number }
  | { type: 'CAST_VOTE'; category: string }  // votación de categoría, uno por jugador (se puede cambiar)
  | { type: 'GET_PROFILE'; token: string }  // v2: el celular pide su perfil persistente
  | { type: 'GET_HALL_OF_FAME' }  // v2.1: el master pide el salón de la fama
  | { type: 'PING'; l?: number };  // Eje 4: latido del celular al servidor
