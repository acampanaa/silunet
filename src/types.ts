export type GamePhase = 'waiting' | 'playing' | 'roundEnd' | 'gameEnd';

export interface Player {
  id: string;
  nick: string;
  score: number;
  // v2: identidad persistente del jugador (token guardado en su propio celular).
  // Viaja en el snapshot para que el coordinador electo sepa a quién persistir.
  token?: string;
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
}

// Mensajes servidor → cliente
export type S2C =
  // v2: token = identidad persistente (el celular lo guarda); returning = "ya jugaste antes"
  | { type: 'WELCOME'; playerId: string; nick: string; playerCount: number; token: string; returning: boolean }
  | { type: 'PLAYER_COUNT'; count: number }
  | { type: 'PLAYER_LEFT'; nick: string }  // Eje 4: "Jugador X: Desconectado"
  | { type: 'ROUND_START'; roundNumber: number; totalRounds: number; category: string; svg: string; hiddenWord: string; timeLeft: number; totalTime: number }
  | { type: 'TICK'; timeLeft: number; hiddenWord: string }
  | { type: 'CORRECT_ANSWER'; nick: string; playerId: string; position: number; lamport: number }
  | { type: 'WRONG_ANSWER' }
  | { type: 'ALREADY_SOLVED' }
  | { type: 'ROUND_END'; word: string; solvers: Array<{ nick: string; points: number; position: number; lamport: number }> }
  | { type: 'RANKING'; entries: RankEntry[]; final: boolean }
  // v2: perfil persistente solicitado por el celular (null si el token no existe)
  | { type: 'PROFILE'; profile: Perfil | null }
  // Eje 4: salud del clúster empujada a la pantalla maestra (sin polling)
  | { type: 'CLUSTER_STATE'; nodes: Array<{ id: string; up: boolean; isCoordinator: boolean }> }
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
  // v2: seguidor pide al coordinador el perfil de un jugador (solo el coord. tiene DB)
  | { type: 'N_FORWARD_PROFILE'; playerId: string; token: string; originNode: string; lamport: number }
  | { type: 'N_PLAYER_LEFT';   playerId: string; lamport: number }
  | { type: 'N_BROADCAST';     payload: S2C; lamport: number }
  | { type: 'N_SEND_TO';       playerId: string; payload: S2C; lamport: number };

// Mensajes cliente → servidor
export type C2S =
  | { type: 'JOIN'; nick: string; token?: string | null }  // v2: token persistente opcional
  | { type: 'MASTER_JOIN' }
  | { type: 'GUESS'; word: string; lamport: number }
  | { type: 'START_GAME'; totalRounds?: number }
  | { type: 'GET_PROFILE'; token: string }  // v2: el celular pide su perfil persistente
  | { type: 'PING'; l?: number };  // Eje 4: latido del celular al servidor
