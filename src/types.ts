export type GamePhase = 'waiting' | 'playing' | 'roundEnd' | 'gameEnd';

export interface Player {
  id: string;
  nick: string;
  score: number;
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
  // lamport: timestamp Lamport del acierto — usado para ordenar cuando varios aciertan "al mismo tiempo"
  solvers: Array<{ id: string; points: number; lamport: number }>;
}

export interface RankEntry {
  nick: string;
  score: number;
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
  | { type: 'WELCOME'; playerId: string; nick: string; playerCount: number }
  | { type: 'PLAYER_COUNT'; count: number }
  | { type: 'ROUND_START'; roundNumber: number; totalRounds: number; category: string; svg: string; hiddenWord: string; timeLeft: number; totalTime: number }
  | { type: 'TICK'; timeLeft: number; hiddenWord: string }
  | { type: 'CORRECT_ANSWER'; nick: string; playerId: string; points: number; lamport: number }
  | { type: 'WRONG_ANSWER' }
  | { type: 'ALREADY_SOLVED' }
  | { type: 'ROUND_END'; word: string; solvers: Array<{ nick: string; points: number; lamport: number }> }
  | { type: 'RANKING'; entries: RankEntry[]; final: boolean }
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
  | { type: 'N_FORWARD_JOIN';  playerId: string; nick: string; originNode: string; lamport: number }
  | { type: 'N_FORWARD_GUESS'; playerId: string; word: string; originNode: string; lamport: number }
  | { type: 'N_FORWARD_START'; totalRounds: number; lamport: number }
  | { type: 'N_PLAYER_LEFT';   playerId: string; lamport: number }
  | { type: 'N_BROADCAST';     payload: S2C; lamport: number }
  | { type: 'N_SEND_TO';       playerId: string; payload: S2C; lamport: number };

// Mensajes cliente → servidor
export type C2S =
  | { type: 'JOIN'; nick: string }
  | { type: 'MASTER_JOIN' }
  | { type: 'GUESS'; word: string; lamport: number }
  | { type: 'START_GAME'; totalRounds?: number };
