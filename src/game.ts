import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { GamePhase, GameMode, Player, WordEntry, RoundState, RankEntry, S2C, GameSnapshot, GameOverResult, Difficulty, StackState, StackPiece, StackPieceKind, StackAction } from './types';
import { getRandomRounds, getMixedQueue, getCategoryCounts, DIFFICULTIES, DIFFICULTY_LABEL } from './wordBank';
import { LamportClock } from './lamport';
import { Mutex } from './mutex';

const TOTAL_TIME   = 24;  // segundos por ronda
const REVEAL_EVERY = 4;   // revelar una letra cada N segundos
const GAP_BETWEEN  = 4;   // segundos entre rondas
const COUNTDOWN_FROM = 3; // "3, 2, 1, ¡YA!" antes de que arranque el timer real
const VOTE_SECONDS = 8;   // ventana para que los jugadores voten la categoría
// Cuántas palabras recuerda el juego entre partidas para no repetirlas.
// Cubre varias partidas seguidas de la misma combinación temática+dificultad.
const RECENT_WORDS_MEMORY = 60;

// ── Modo Relajo (reloj compartido) ───────────────────────────────────────────
// Un único cronómetro para TODO el público: solo se alarga cuando alguien
// acierta, y la partida muere cuando llega a cero. La bonificación depende de
// CUÁNTA gente acertó (no de quién llegó primero), para que sea cooperativo de
// verdad: te conviene que todos adivinen, no solo tú.
const RELAJO_START_SECONDS   = 45; // reloj inicial
const RELAJO_ROUND_SECONDS   = 20; // tope por silueta si nadie acierta
const RELAJO_ADVANCE_AFTER   = 3;  // s tras el primer acierto antes de pasar a la siguiente
const RELAJO_BONUS_PER_SOLVER = 2;  // s que suma CADA persona que acierta

// Tope de bonificación por silueta, que DECAE con las despejadas. Es el motor
// del modo: mientras el tope supere el costo de un ciclo (avance 3s + pausa 1s
// = 4s), un público numeroso hace crecer el reloj; cuando cae por debajo, la
// partida entra en cuenta atrás irreversible por más que acierten todos.
// Sin esta decadencia la partida no termina nunca: con 6 jugadores rápidos el
// reloj crecía indefinidamente.
const RELAJO_BONUS_CAP_START = 10;
// 0 a propósito: al final de la partida ningún acierto suma tiempo, y ahí el
// reloj cae sin remedio. Con mínimo 1 el primer acierto seguía sumando 2s y
// casi cubría el ciclo, estirando la partida a ~4 minutos.
const RELAJO_BONUS_CAP_MIN   = 0;
const RELAJO_QUEUE_SIZE      = 40; // siluetas que se preparan por tanda
const RELAJO_GAP_BETWEEN     = 1;  // pausa entre siluetas (el clásico usa 4)

// Eje 2+3: el puntaje depende de la POSICIÓN LÓGICA de llegada (orden de Lamport
// resuelto por el coordinador), NO del tiempo ni de la latencia de red del celular.
//   puntos = POINTS_BASE + (POINTS_TOP - POINTS_BASE) * (1 - (posición - 1) / N)
// con N = total de aciertos de la ronda. Primero (pos=1) → POINTS_TOP.
// ── SiluStack ────────────────────────────────────────────────────────────────
// Tablero autoritativo replicado por eventos discretos. Cada silueta genera una
// pieza; el primer acierto se convierte en piloto.
const STACK_WIDTH = 10;
const STACK_HEIGHT = 16;
const STACK_QUEUE_SIZE = 40;
const STACK_ROUND_SECONDS = 18;
const STACK_GAP_BETWEEN = 1;
const STACK_PIECES_PER_LEVEL = 5;
const STACK_LINE_BONUS = 150;

const STACK_KINDS: StackPieceKind[] = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];
const STACK_COLORS: Record<StackPieceKind, number> = {
  I: 1, O: 2, T: 3, L: 4, J: 5, S: 6, Z: 7,
};
const STACK_SHAPES: Record<StackPieceKind, Array<Array<[number, number]>>> = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
};
const POINTS_TOP  = 1000; // puntos del primero en orden lógico
const POINTS_BASE = 100;  // base garantizada (el último en orden lógico tiende a esto)
const HINT_UNLOCK_AFTER = 5;
const HINT_PENALTY_PERCENT = 20;

export class Game extends EventEmitter {
  private players         = new Map<string, Player>();
  private phase: GamePhase = 'waiting';
  private rounds: WordEntry[] = [];
  private currentGameId?: string;
  private pendingGameOverResult?: GameOverResult;
  private currentRoundIndex  = -1;
  private round?: RoundState;
  private timer?: ReturnType<typeof setInterval>;
  private countdownTimer?: ReturnType<typeof setTimeout>;

  // Palabras usadas en partidas anteriores (de la más antigua a la más reciente),
  // para no repetirlas en la siguiente. Viaja en el snapshot para que un
  // coordinador promovido por Bully no pierda la memoria (Eje 4).
  private recentWords: string[] = [];

  // Modo de juego y estado propio del modo Relajo.
  private mode: GameMode = 'clasico';
  private sharedClock = 0;   // segundos que le quedan de vida a la partida
  private cleared = 0;
  private stack?: StackState;       // tablero compartido de SiluStack

  // Votación de categoría (fase 'voting'): un jugador puede cambiar su voto
  // mientras dure la ventana, por eso es un mapa (no un contador directo).
  private votes = new Map<string, string>();           // playerId -> categoría
  private difficultyVotes = new Map<string, string>(); // playerId -> dificultad
  private voteCategories: string[] = [];
  private voteTimer?: ReturnType<typeof setTimeout>;
  private pendingTotalRounds = 10;

  // Eje 2: reloj de Lamport del nodo
  readonly clock = new LamportClock();

  // Eje 3: candado lógico que serializa el acceso al marcador compartido
  private readonly scoreboardLock = new Mutex('marcador');

  constructor() {
    super();
    // Panel didáctico de /master (Eje 3): retransmite el momento exacto en
    // que dos aciertos concurrentes chocan contra el candado.
    this.scoreboardLock.on('queued', (waiting: number) => {
      this.broadcast({ type: 'MUTEX_QUEUED', waiting });
    });
  }

  // --- Consultas de estado ---

  getPhase()       { return this.phase; }
  // Cuenta solo conectados: un desconectado a mitad de partida sigue en el mapa
  // (conserva puntaje) pero no debe inflar el contador que ve la pantalla maestra.
  getPlayerCount() { return [...this.players.values()].filter(p => p.connected !== false).length; }
  getPlayer(id: string) { return this.players.get(id); }

  getRanking(): RankEntry[] {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map(p => ({ nick: p.nick, score: p.score, avatarId: p.avatarId ?? 0, avatarKey: p.avatarKey }));
  }

  /** Pulso del motor distribuido para el panel didáctico de /master (Eje 2 + Eje 3). */
  broadcastEngineState(): void {
    this.broadcast({ type: 'ENGINE_STATE', lamport: this.clock.value, mutexWaiting: this.scoreboardLock.waiting });
  }

  getCurrentRoundInfo() {
    if (!this.round || this.phase !== 'playing') return null;
    return {
      roundNumber: this.currentRoundIndex + 1,
      totalRounds: this.mode === 'silustack' ? (this.stack?.pieces ?? 0) + 1 : this.rounds.length,
      category:    this.round.wordEntry.category,
      svg:         this.round.wordEntry.svg,
      image:       this.round.wordEntry.image,
      hiddenWord:  this.round.hiddenWord.join(' '),
      timeLeft:    this.round.timeLeft,
      totalTime:   this.round.totalTime,
    };
  }

  stackState(): StackState | null {
    // Guarda de modo, igual que sharedClockState(): sin esto un tablero viejo
    // se filtraba a las partidas Clásica/Relajo (server.ts lo empuja a todo el
    // que se une o recarga), y el cliente se quedaba pintando "SiluStack" el
    // resto de la partida.
    if (this.mode !== 'silustack') return null;
    // Tampoco se manda un tablero MUERTO: entre partidas el modo sigue siendo
    // 'silustack' hasta que arranque la siguiente, así que sin este chequeo
    // quien se une (o recarga) en el lobby recibe el tablero de la partida ya
    // terminada y su pantalla se queda en SiluStack.
    if (this.phase === 'waiting' || this.phase === 'gameEnd') return null;
    return this.cloneStackState();
  }

  private cloneStackState(): StackState | null {
    if (!this.stack) return null;
    return {
      ...this.stack,
      board: this.stack.board.map(row => [...row]),
      active: this.stack.active ? { ...this.stack.active } : null,
      activeCells: this.stack.activeCells.map(cell => [cell[0], cell[1]]),
    };
  }

  private broadcastStackState(): void {
    const state = this.cloneStackState();
    if (state) this.broadcast({ type: 'STACK_STATE', state });
  }
  // --- Replicación (Eje 3: réplica por nodo) ---

  /** Estado autoritativo completo, para enviar a los seguidores (N_REPLICATE). */
  snapshot(): GameSnapshot {
    return {
      phase:             this.phase,
      currentGameId:     this.currentGameId,
      pendingGameOverResult: this.pendingGameOverResult ?? null,
      rounds:            this.rounds,
      currentRoundIndex: this.currentRoundIndex,
      round:             this.round ?? null,
      players:           [...this.players.values()].map(p => ({ ...p })),
      lamport:           this.clock.value,
      votes:             Object.fromEntries(this.votes),
      difficultyVotes:   Object.fromEntries(this.difficultyVotes),
      voteCategories:    this.voteCategories,
      pendingTotalRounds: this.pendingTotalRounds,
      recentWords:       this.recentWords,
      mode:              this.mode,
      sharedClock:       this.sharedClock,
      cleared:           this.cleared,
      stack:             this.cloneStackState(),
    };
  }

  /**
   * Aplica un snapshot recibido del coordinador. Réplica PASIVA: solo absorbe
   * estado, nunca arranca timers ni emite eventos. Si este nodo es promovido a
   * coordinador (Bully, Paso C), reanudará la partida desde esta réplica.
   */
  restore(s: GameSnapshot): void {
    this.phase             = s.phase;
    this.currentGameId     = s.currentGameId;
    this.pendingGameOverResult = s.pendingGameOverResult ?? undefined;
    this.rounds            = s.rounds;
    this.currentRoundIndex = s.currentRoundIndex;
    this.round             = s.round
      ? { ...s.round, hintedPlayerIds: s.round.hintedPlayerIds ?? [] }
      : undefined;
    this.players           = new Map(s.players.map(p => [p.id, { ...p }]));
    this.clock.merge(s.lamport);
    this.votes             = new Map(Object.entries(s.votes ?? {}));
    this.difficultyVotes   = new Map(Object.entries(s.difficultyVotes ?? {}));
    this.voteCategories    = s.voteCategories ?? [];
    this.pendingTotalRounds = s.pendingTotalRounds ?? 10;
    this.recentWords       = s.recentWords ?? [];
    this.mode              = s.mode ?? 'clasico';
    this.sharedClock       = s.sharedClock ?? 0;
    this.cleared           = s.cleared ?? 0;
    this.stack             = s.stack ? {
      ...s.stack,
      board: s.stack.board.map(row => [...row]),
      active: s.stack.active ? { ...s.stack.active } : null,
      activeCells: (s.stack.activeCells ?? []).map(cell => [cell[0], cell[1]]),
    } : undefined;
  }

  /**
   * Eje 4: este nodo acaba de ser promovido a coordinador (Bully). Reanuda la
   * partida desde la réplica: re-sincroniza a los clientes y vuelve a arrancar
   * los timers que solo corren en el coordinador.
   */
  resume(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    if (this.voteTimer) clearTimeout(this.voteTimer);
    if ((this.phase === 'playing' || this.phase === 'countdown') && this.round) {
      // Si la caída agarró a mitad de la cuenta regresiva, no la repite desde
      // el nuevo coordinador (ya es bastante desincronización con el propio
      // failover) -> salta directo a jugar con el timeLeft que ya tenía.
      this.startRoundTimer();
    } else if (this.phase === 'roundEnd') {
      setTimeout(() => this.nextRound(), this.gapBetweenRounds() * 1000);
    } else if (this.phase === 'voting') {
      // Igual que con la cuenta regresiva: no reinicia la ventana de votación
      // desde cero (ya es bastante desincronización con el propio failover) ->
      // cierra la votación ya mismo con lo que se alcanzó a replicar.
      this.finishVote();
    } else if (this.phase === 'gameEnd' && this.pendingGameOverResult) {
      // El resultado viaja en el snapshot. Si el coordinador anterior cayó
      // antes de confirmar PostgreSQL, el nuevo líder reintenta el mismo UUID.
      this.emit('game_over', this.pendingGameOverResult);
    }
  }

  // --- Gestión de jugadores ---

  /**
   * Eje 4 (resiliencia de cliente): si `token` coincide con un jugador que sigue
   * en el mapa pero marcado `connected: false` (se cayó a mitad de partida, de
   * este nodo o de otro tras un failover), lo RECONECTA bajo el nuevo `id` de
   * sesión en lugar de crear uno nuevo con puntaje 0. Así un celular puede
   * perder la señal, reconectar por cualquier nodo vivo del clúster con el
   * mismo token, y seguir jugando sin perder lo acumulado en esta partida.
   */
  addPlayer(id: string, nick: string, token: string | undefined, originNode: string, avatarId?: number, avatarKey?: string): Player {
    if (token) {
      const existing = [...this.players.values()].find(p => p.token === token && p.connected === false);
      if (existing) {
        const previousId = existing.id;
        this.players.delete(previousId);
        existing.id         = id;
        existing.nick        = nick;
        existing.connected  = true;
        existing.originNode = originNode;
        if (avatarId != null) existing.avatarId = avatarId;
        if (avatarKey !== undefined) existing.avatarKey = avatarKey;
        this.players.set(id, existing);
        if (this.round) {
          this.round.hintedPlayerIds = this.round.hintedPlayerIds
            .map(hintedId => hintedId === previousId ? id : hintedId);
          this.round.solvers = this.round.solvers
            .map(solver => solver.id === previousId ? { ...solver, id } : solver);
        }
        if (this.stack?.pilotId === previousId) {
          this.stack.pilotId = id;
          this.stack.pilotNick = nick;
          this.broadcastStackState();
        }
        this.broadcast({ type: 'PLAYER_COUNT', count: this.getPlayerCount() });
        return existing;
      }
    }
    const player: Player = { id, nick, score: 0, token, connected: true, originNode, avatarId: avatarId ?? 0, avatarKey };
    this.players.set(id, player);
    this.broadcast({ type: 'PLAYER_COUNT', count: this.getPlayerCount() });
    return player;
  }

  /**
   * Cambio de avatar en vivo. Refresca el ranking para que la pantalla maestra
   * y los celulares lo vean al instante (solo viaja el índice, no una imagen).
   */
  setPlayerAvatar(playerId: string, avatarId: number): void {
    const p = this.players.get(playerId);
    if (!p || (p.avatarId === avatarId && !p.avatarKey)) return;
    p.avatarId = avatarId;
    p.avatarKey = undefined;
    this.broadcast({ type: 'RANKING', entries: this.getRanking(), final: false });
  }

  setPlayerCustomAvatar(playerId: string, avatarKey: string): void {
    const p = this.players.get(playerId);
    if (!p || p.avatarKey === avatarKey) return;
    p.avatarKey = avatarKey;
    this.broadcast({ type: 'RANKING', entries: this.getRanking(), final: false });
  }

  /** ¿Este jugador tiene puntaje acumulado en la partida en curso y podría reconectar? */
  wasConnected(token: string | undefined): boolean {
    if (!token) return false;
    const p = [...this.players.values()].find(pl => pl.token === token);
    return !!p && p.connected === false;
  }

  /** ¿Hay una partida en curso (o por arrancar) donde valga la pena proteger la sesión? */
  private isGameLive(): boolean {
    return this.phase === 'voting' || this.phase === 'countdown'
        || this.phase === 'playing' || this.phase === 'roundEnd';
  }

  /**
   * Eje 4: se llama cuando cambia la topología del clúster (un nodo cae, o
   * este nodo acaba de ganar la elección Bully). Un jugador cuyo `originNode`
   * ya no está vivo es un FANTASMA: su WebSocket real vivía en el nodo que
   * murió, y ese nodo jamás alcanzó a avisar "se desconectó" (murió entero,
   * no cerró prolijamente). Sin esto quedaría `connected: true` para siempre
   * -> su propio intento de reconexión (mismo token) nunca lo encontraría
   * como desconectado, perdería su puntaje y se le crearía un duplicado.
   */
  pruneToLivingNodes(livingNodeIds: string[]) {
    const living  = new Set(livingNodeIds);
    let changed = false;
    for (const [id, p] of [...this.players]) {
      if (p.connected === false) continue;
      if (!p.originNode || living.has(p.originNode)) continue;
      changed = true;
      if (this.isGameLive()) {
        p.connected = false;
      } else {
        this.players.delete(id);
      }
      this.broadcast({ type: 'PLAYER_LEFT', nick: p.nick });
    }
    if (changed) this.broadcast({ type: 'PLAYER_COUNT', count: this.getPlayerCount() });
  }

  removePlayer(id: string) {
    const player = this.players.get(id);
    if (!player) return;

    // Eje 4: mientras hay partida en curso, NO se borra al jugador -> conserva su
    // puntaje para poder reconectarse (mismo token) por este nodo o por otro tras
    // un failover. Fuera de partida (lobby / fin de juego) no hay nada que
    // proteger, así que se elimina de inmediato como antes.
    if (this.isGameLive()) {
      player.connected = false;
    } else {
      this.players.delete(id);
    }
    // Eje 4: avisar al stand para mostrar "Jugador X: Desconectado"
    this.broadcast({ type: 'PLAYER_LEFT', nick: player.nick });
    this.broadcast({ type: 'PLAYER_COUNT', count: this.getPlayerCount() });
  }

  // --- Control de partida ---

  /**
   * El master pulsó "Iniciar partida": NO arranca la partida todavía, abre
   * una votación entre los jugadores conectados — categoría Y dificultad, dos
   * votos independientes en la misma ventana. beginRounds() (llamado al cerrar
   * la votación) es quien de verdad arranca las rondas.
   */
  startGame(totalRounds = 10, mode: GameMode = 'clasico'): boolean {
    if (this.phase !== 'waiting' && this.phase !== 'gameEnd') return false;
    if (this.timer) clearInterval(this.timer);
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.mode = mode;

    // Los modos infinitos no necesitan votación: arrancan de inmediato.
    if (mode === 'silustack') { this.beginSiluStack(); return true; }
    if (mode === 'relajo') { this.beginRelajo(); return true; }

    this.pendingTotalRounds = totalRounds;
    this.votes.clear();
    this.difficultyVotes.clear();
    this.voteCategories = getCategoryCounts().map(c => c.name);
    this.phase = 'voting';

    this.broadcast({
      type:             'VOTE_START',
      categories:       this.voteCategories,
      difficulties:     DIFFICULTIES,
      difficultyLabels: DIFFICULTY_LABEL,
      durationSec:      VOTE_SECONDS,
    });
    this.runVoteCountdown(VOTE_SECONDS);
    return true;
  }

  /** Un jugador vota (o cambia su voto) mientras dura la ventana de votación. */
  castVote(playerId: string, kind: 'category' | 'difficulty', option: string): void {
    if (this.phase !== 'voting') return;
    if (kind === 'category') {
      if (!this.voteCategories.includes(option)) return;
      this.votes.set(playerId, option);
    } else {
      if (!DIFFICULTIES.includes(option as Difficulty)) return;
      this.difficultyVotes.set(playerId, option);
    }
    this.broadcastTally();
  }

  private broadcastTally() {
    this.broadcast({
      type:                 'VOTE_TALLY',
      tally:                this.tally(this.voteCategories, this.votes),
      totalVotes:           this.votes.size,
      difficultyTally:      this.tally(DIFFICULTIES, this.difficultyVotes),
      totalDifficultyVotes: this.difficultyVotes.size,
    });
  }

  private tally(options: readonly string[], votes: Map<string, string>): Record<string, number> {
    const t: Record<string, number> = {};
    for (const o of options) t[o] = 0;
    for (const v of votes.values()) t[v] = (t[v] ?? 0) + 1;
    return t;
  }

  /** Opción más votada; empate se decide al azar entre las empatadas, y si
   *  nadie votó, al azar entre todas — nunca se traba esperando votos. */
  private pickWinner(options: readonly string[], votes: Map<string, string>): string {
    const t = this.tally(options, votes);
    const max = Math.max(0, ...Object.values(t));
    const winners = max > 0 ? options.filter(o => t[o] === max) : options;
    return winners[Math.floor(Math.random() * winners.length)];
  }

  private runVoteCountdown(secondsLeft: number) {
    this.broadcast({ type: 'VOTE_COUNTDOWN', secondsLeft });
    if (secondsLeft > 0) {
      this.voteTimer = setTimeout(() => this.runVoteCountdown(secondsLeft - 1), 1000);
    } else {
      this.finishVote();
    }
  }

  /** Cierra la votación y arranca la partida con lo que se haya votado. */
  private finishVote() {
    if (this.voteCategories.length === 0) this.voteCategories = getCategoryCounts().map(c => c.name);
    const winner     = this.pickWinner(this.voteCategories, this.votes);
    const difficulty = this.pickWinner(DIFFICULTIES, this.difficultyVotes) as Difficulty;

    this.broadcast({
      type: 'VOTE_RESULT',
      winner,
      difficulty,
      difficultyLabel: DIFFICULTY_LABEL[difficulty],
    });
    this.beginRounds(this.pendingTotalRounds, [winner], difficulty);
  }

  /** Arranca el modo Relajo: banco completo mezclado y reloj comunitario. */
  private beginRelajo() {
    this.clearStackIfNotSiluStack();
    this.resetPlayersForNewGame();
    // Sin filtro de temática ni dificultad: las 160 palabras revueltas.
    this.rounds = getMixedQueue(RELAJO_QUEUE_SIZE, this.recentWords);
    this.recentWords = [...this.recentWords, ...this.rounds.map(r => r.word)].slice(-RECENT_WORDS_MEMORY);
    this.currentGameId = randomUUID();
    this.pendingGameOverResult = undefined;
    this.currentRoundIndex = -1;
    this.sharedClock = RELAJO_START_SECONDS;
    this.cleared = 0;
    this.broadcastSharedClock();
    this.nextRound();
  }

  /** Arranca SiluStack con tablero vacío y banco completo mezclado. */
  private beginSiluStack() {
    this.resetPlayersForNewGame();
    this.rounds = getMixedQueue(STACK_QUEUE_SIZE, this.recentWords);
    this.recentWords = [...this.recentWords, ...this.rounds.map(r => r.word)].slice(-RECENT_WORDS_MEMORY);
    this.currentGameId = randomUUID();
    this.pendingGameOverResult = undefined;
    this.currentRoundIndex = -1;
    this.sharedClock = 0;
    this.cleared = 0;
    this.stack = {
      width: STACK_WIDTH,
      height: STACK_HEIGHT,
      board: Array.from({ length: STACK_HEIGHT }, () => Array(STACK_WIDTH).fill(0)),
      active: null,
      activeCells: [],
      nextKind: this.randomStackKind(),
      pieces: 0,
      lines: 0,
      combo: 0,
      level: 1,
      lastClear: 0,
    };
    this.nextRound();
  }
  private gapBetweenRounds(): number {
    if (this.mode === 'silustack') return STACK_GAP_BETWEEN;
    return this.mode === 'relajo' ? RELAJO_GAP_BETWEEN : GAP_BETWEEN;
  }

  /** Duración de una silueta según el modo. */
  private roundSeconds(): number {
    if (this.mode === 'silustack') return STACK_ROUND_SECONDS;
    return this.mode === 'relajo' ? RELAJO_ROUND_SECONDS : TOTAL_TIME;
  }

  private bonusPerSolver(): number { return RELAJO_BONUS_PER_SOLVER; }

  /** Tope de segundos que puede ganar UNA silueta. Baja 1s cada 2 despejadas. */
  private bonusCap(): number {
    return Math.max(RELAJO_BONUS_CAP_MIN, RELAJO_BONUS_CAP_START - this.cleared);
  }

  /** Estado del reloj comunitario, para re-sincronizar a quien llega tarde. */
  sharedClockState(): { secondsLeft: number; cleared: number; bonusPerSolver: number } | null {
    if (this.mode !== 'relajo') return null;
    return {
      secondsLeft: Math.max(0, this.sharedClock),
      cleared: this.cleared,
      bonusPerSolver: this.bonusPerSolver(),
    };
  }

  private broadcastSharedClock() {
    this.broadcast({
      type: 'SHARED_CLOCK',
      secondsLeft: Math.max(0, this.sharedClock),
      cleared: this.cleared,
      bonusPerSolver: this.bonusPerSolver(),
    });
  }

  private randomStackKind(): StackPieceKind {
    return STACK_KINDS[Math.floor(Math.random() * STACK_KINDS.length)];
  }

  private pieceCells(piece: StackPiece): Array<[number, number]> {
    const shape = STACK_SHAPES[piece.kind][piece.rotation % 4];
    return shape.map(([x, y]) => [piece.x + x, piece.y + y]);
  }

  private syncActiveCells(): void {
    if (!this.stack) return;
    this.stack.activeCells = this.stack.active ? this.pieceCells(this.stack.active) : [];
  }

  private canPlace(piece: StackPiece): boolean {
    if (!this.stack) return false;
    return this.pieceCells(piece).every(([x, y]) =>
      x >= 0 && x < this.stack!.width &&
      y >= 0 && y < this.stack!.height &&
      this.stack!.board[y][x] === 0
    );
  }

  private spawnStackPiece(): boolean {
    if (!this.stack) return false;
    const kind = this.stack.nextKind;
    const active: StackPiece = {
      kind,
      rotation: 0,
      x: Math.floor((this.stack.width - 4) / 2),
      y: 0,
      color: STACK_COLORS[kind],
    };
    this.stack.nextKind = this.randomStackKind();
    this.stack.active = active;
    this.stack.pilotId = undefined;
    this.stack.pilotNick = undefined;
    this.stack.lastClear = 0;
    this.syncActiveCells();

    if (!this.canPlace(active)) {
      this.stack.active = null;
      this.stack.activeCells = [];
      this.broadcastStackState();
      this.endGame();
      return false;
    }
    return true;
  }

  private tryStackMove(dx: number, dy: number, rotation?: number): boolean {
    if (!this.stack?.active) return false;
    const candidate: StackPiece = {
      ...this.stack.active,
      x: this.stack.active.x + dx,
      y: this.stack.active.y + dy,
      rotation: rotation ?? this.stack.active.rotation,
    };
    if (!this.canPlace(candidate)) return false;
    this.stack.active = candidate;
    this.syncActiveCells();
    return true;
  }

  stackAction(playerId: string, action: StackAction): boolean {
    if (this.mode !== 'silustack' || this.phase !== 'playing' || !this.stack?.active) return false;
    if (this.stack.pilotId !== playerId) return false;

    if (action === 'drop') {
      this.hardDropStackPiece();
      return true;
    }

    let moved = false;
    if (action === 'left') moved = this.tryStackMove(-1, 0);
    if (action === 'right') moved = this.tryStackMove(1, 0);
    if (action === 'down') moved = this.tryStackMove(0, 1);
    if (action === 'rotate') {
      const nextRotation = (this.stack.active.rotation + 1) % 4;
      for (const kick of [0, -1, 1, -2, 2]) {
        if (this.tryStackMove(kick, 0, nextRotation)) {
          moved = true;
          break;
        }
      }
    }
    if (moved) this.broadcastStackState();
    return moved;
  }

  /** La pantalla maestra puede actuar como cabina, pero nunca saltarse al piloto. */

  private hardDropStackPiece(): void {
    if (!this.stack?.active) return;
    while (this.tryStackMove(0, 1)) {
      // La caída es autoritativa y se difunde una sola vez al bloquear la pieza.
    }
    this.lockStackPiece();
  }

  private lockStackPiece(): void {
    if (!this.stack?.active || !this.round) return;
    const value = this.stack.pilotId ? this.stack.active.color : 8;
    for (const [x, y] of this.pieceCells(this.stack.active)) {
      this.stack.board[y][x] = value;
    }

    const remaining = this.stack.board.filter(row => row.some(cell => cell === 0));
    const clearedNow = this.stack.height - remaining.length;
    const emptyRows = Array.from({ length: clearedNow }, () => Array(this.stack!.width).fill(0));
    this.stack.board = [...emptyRows, ...remaining];
    this.stack.pieces++;
    this.stack.lines += clearedNow;
    this.stack.combo = clearedNow > 0 ? this.stack.combo + 1 : 0;
    this.stack.level = 1 + Math.floor(this.stack.pieces / STACK_PIECES_PER_LEVEL);
    this.stack.lastClear = clearedNow;

    if (clearedNow > 0 && this.stack.pilotId) {
      const pilot = this.players.get(this.stack.pilotId);
      if (pilot) pilot.score += clearedNow * STACK_LINE_BONUS * this.stack.combo;
    }

    this.stack.active = null;
    this.stack.activeCells = [];
    this.stack.pilotId = undefined;
    this.stack.pilotNick = undefined;
    this.broadcastStackState();
    this.endRound();
  }
  /** Suelta el tablero de SiluStack: una partida de otro modo no debe heredarlo. */
  private clearStackIfNotSiluStack() {
    if (this.mode !== 'silustack') this.stack = undefined;
  }

  private resetPlayersForNewGame() {
    for (const [id, p] of [...this.players]) {
      if (p.connected === false) this.players.delete(id);
      else p.score = 0;
    }
  }

  private beginRounds(totalRounds: number, categories: string[], difficulty: Difficulty) {
    this.clearStackIfNotSiluStack();
    // Purga a quien se quedó desconectado de la partida anterior sin volver:
    // una partida nueva es el corte natural de la ventana de reconexión.
    this.resetPlayersForNewGame();
    this.rounds = getRandomRounds(totalRounds, categories, difficulty, this.recentWords);
    // Memoria entre partidas: evita que dos partidas seguidas repitan el mismo
    // set de palabras. El pool de una combinación votada puede ser de 6-8, así
    // que sin esto la partida siguiente salía casi idéntica.
    this.recentWords = [...this.recentWords, ...this.rounds.map(r => r.word)].slice(-RECENT_WORDS_MEMORY);
    this.currentGameId = randomUUID();
    this.pendingGameOverResult = undefined;
    this.currentRoundIndex = -1;
    this.nextRound();
  }

  private nextRound() {
    this.currentRoundIndex++;
    if (this.currentRoundIndex >= this.rounds.length) {
      // Relajo no termina por quedarse sin siluetas: solo el reloj lo mata.
      if (this.mode === 'relajo' || this.mode === 'silustack') {
        this.rounds = getMixedQueue(RELAJO_QUEUE_SIZE, this.recentWords);
        this.recentWords = [...this.recentWords, ...this.rounds.map(r => r.word)].slice(-RECENT_WORDS_MEMORY);
        this.currentRoundIndex = 0;
      } else {
        this.endGame();
        return;
      }
    }

    const entry = this.rounds[this.currentRoundIndex];
    const chars = entry.word.split('');

    // Orden de revelación aleatorio (solo índices de letras, no espacios)
    const letterIndices = chars
      .map((c, i) => (c !== ' ' ? i : -1))
      .filter(i => i !== -1);
    const revealOrder = [...letterIndices].sort(() => Math.random() - 0.5);

    this.round = {
      wordEntry:     entry,
      hiddenWord:    chars.map(c => (c === ' ' ? ' ' : '_')),
      revealOrder,
      revealedCount: 0,
      timeLeft:      this.roundSeconds(),
      totalTime:     this.roundSeconds(),
      solvers:       [],
      hintedPlayerIds: [],
    };
    this.phase = 'countdown';

    // SiluStack: la pieza se genera ANTES del ROUND_PREVIEW. Si el tablero ya
    // está lleno, spawnStackPiece() termina la partida y aquí se corta: así
    // nunca se emite el preview que abre el overlay de cuenta regresiva. Al
    // revés (que era como estaba) el overlay quedaba tapando el podio final,
    // porque solo ROUND_START lo cierra y ese ya no llega.
    if (this.mode === 'silustack') {
      if (!this.spawnStackPiece()) return;
    }

    // Se conoce la ronda (categoría/silueta/palabra) pero el timer real
    // todavía no arranca: los clientes pintan la pantalla y esperan la
    // cuenta regresiva. Eje 1: es un broadcast más, todos la ven a la vez.
    this.broadcast({
      type:        'ROUND_PREVIEW',
      roundNumber: this.currentRoundIndex + 1,
      totalRounds: this.rounds.length,
      category:    entry.category,
      svg:         entry.svg,
      image:       entry.image,
      hiddenWord:  this.round.hiddenWord.join(' '),
    });

    if (this.mode === 'silustack') this.broadcastStackState();

    if ((this.mode === 'relajo' && this.cleared + this.currentRoundIndex > 0)
        || (this.mode === 'silustack' && (this.stack?.pieces ?? 0) > 0)) {
      this.startRoundTimer();
    } else {
      this.runCountdown(COUNTDOWN_FROM);
    }
  }

  /** "3, 2, 1, ¡YA!" — al llegar a 0 arranca el timer real (mismo instante). */
  private runCountdown(secondsLeft: number) {
    this.broadcast({ type: 'COUNTDOWN', value: secondsLeft });
    if (secondsLeft > 0) {
      this.countdownTimer = setTimeout(() => this.runCountdown(secondsLeft - 1), 1000);
    } else {
      this.startRoundTimer();
    }
  }

  /** Arranca (o reanuda, ver resume()) el timer real de la ronda ya conocida. */
  private startRoundTimer() {
    if (!this.round) return;
    this.phase = 'playing';
    this.broadcast({
      type:        'ROUND_START',
      roundNumber: this.currentRoundIndex + 1,
      totalRounds: this.rounds.length,
      category:    this.round.wordEntry.category,
      svg:         this.round.wordEntry.svg,
      image:       this.round.wordEntry.image,
      hiddenWord:  this.round.hiddenWord.join(' '),
      timeLeft:    this.round.timeLeft,
      totalTime:   this.round.totalTime,
    });
    if (this.mode === 'silustack') this.broadcastStackState();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick() {
    if (!this.round) return;
    this.round.timeLeft--;

    // Modo Relajo: el reloj comunitario corre SIEMPRE y es el que mata la
    // partida. La silueta actual solo marca cuándo pasar a la siguiente.
    if (this.mode === 'relajo') {
      this.sharedClock--;
      this.broadcastSharedClock();
      if (this.sharedClock <= 0) { this.endRelajo(); return; }
    }

    // Revelar una letra en los múltiplos de REVEAL_EVERY (excepto en 0, ya que ahí termina)
    const shouldReveal =
      this.round.timeLeft > 0 &&
      this.round.timeLeft % REVEAL_EVERY === 0 &&
      this.round.revealedCount < this.round.revealOrder.length;

    if (shouldReveal) {
      const idx = this.round.revealOrder[this.round.revealedCount];
      this.round.hiddenWord[idx] = this.round.wordEntry.word[idx];
      this.round.revealedCount++;
    }

    this.broadcast({
      type:       'TICK',
      timeLeft:   this.round.timeLeft,
      hiddenWord: this.round.hiddenWord.join(' '),
    });

    if (this.mode === 'silustack') {
      // El fin de ronda se evalúa ANTES de exigir pieza activa. Si no, un tick
      // sin pieza (p.ej. tras un failover de Bully, donde el nuevo coordinador
      // reanuda desde un snapshot tomado con active=null) devolvía para siempre
      // y la partida quedaba congelada: timeLeft bajando a negativo, sin cerrar
      // ronda ni generar pieza nueva.
      if (!this.stack?.active) {
        // Sin pieza activa no hay nada que hacer caer, pero la ronda SÍ tiene
        // que poder cerrarse: antes se retornaba sin mirar el tiempo y la
        // partida quedaba congelada para siempre (timeLeft a negativo, sin
        // cerrar ronda ni generar pieza). Es alcanzable tras un failover de
        // Bully, si el snapshot se tomó con active=null.
        if (this.round.timeLeft <= 0) this.endRound();
        return;
      }
      // Con pieza activa el fin de tiempo la hace caer de golpe, no cierra la
      // ronda a secas: si no, la pieza nunca se fija en el tablero.
      if (this.round.timeLeft <= 0) {
        this.hardDropStackPiece();
        return;
      }
      const elapsed = this.round.totalTime - this.round.timeLeft;
      const cadence = Math.max(1, 3 - Math.floor((this.stack.level - 1) / 3));
      if (elapsed > 0 && elapsed % cadence === 0) {
        if (this.tryStackMove(0, 1)) this.broadcastStackState();
        else this.lockStackPiece();
      }
      return;
    }

    if (this.round.timeLeft <= 0) this.endRound();
  }

  // --- Pistas y lógica de adivinanza ---

  requestHint(id: string):
    | { status: 'revealed'; hint: string; penaltyPercent: number; alreadyUsed: boolean }
    | { status: 'locked'; secondsLeft: number }
    | { status: 'unavailable' } {
    if (!this.round || this.phase !== 'playing') return { status: 'unavailable' };
    if (!this.players.has(id) || this.round.solvers.some(s => s.id === id)) {
      return { status: 'unavailable' };
    }

    const elapsed = this.round.totalTime - this.round.timeLeft;
    if (elapsed < HINT_UNLOCK_AFTER) {
      return { status: 'locked', secondsLeft: HINT_UNLOCK_AFTER - elapsed };
    }

    const alreadyUsed = this.round.hintedPlayerIds.includes(id);
    if (!alreadyUsed) {
      this.round.hintedPlayerIds.push(id);
      // La pista es privada, pero el uso se replica para conservar la
      // penalización aunque cambie el coordinador durante la ronda.
      this.emit('state_changed');
    }
    return {
      status: 'revealed',
      hint: this.round.wordEntry.hint,
      penaltyPercent: HINT_PENALTY_PERCENT,
      alreadyUsed,
    };
  }

  // Eje 2: clientLamport es el reloj del cliente al momento de enviar el GUESS.
  // update() sincroniza el reloj del nodo: t = max(local, clientLamport) + 1.
  // Eje 3: toda la sección que lee/modifica el marcador corre bajo el candado,
  // así dos aciertos concurrentes se procesan en serie (no se entrelazan).
  async handleGuess(id: string, word: string, clientLamport: number): Promise<'correct' | 'wrong' | 'already_solved' | 'not_playing'> {
    if (!this.round || this.phase !== 'playing') return 'not_playing';

    return this.scoreboardLock.runExclusive(id, () => {
      // ── Sección crítica: acceso exclusivo al marcador ──
      if (!this.round || this.phase !== 'playing') return 'not_playing';
      if (this.round.solvers.find(s => s.id === id)) return 'already_solved';

      // Timestamp oficial del evento "acierto" en este nodo (Eje 2)
      const eventLamport = this.clock.update(clientLamport);

      if (word.trim().toUpperCase() === this.round.wordEntry.word) {
        const player = this.players.get(id)!;
        // Solo se registra la llegada con su timestamp Lamport. Los puntos NO se
        // asignan aquí: dependen de N (total de aciertos), que se conoce al cerrar
        // la ronda. Así el puntaje queda atado a la posición lógica, no al tiempo.
        this.round.solvers.push({ id, lamport: eventLamport });

        // Posición provisional de llegada (orden lógico hasta este instante).
        const position = this.round.solvers.length;

        // Modo Relajo: cada acierto alarga el reloj de TODOS. Esta suma ocurre
        // dentro del candado (Eje 3) junto con el registro del acierto: si dos
        // personas aciertan a la vez, ambas bonificaciones se aplican una sola
        // vez cada una, sin perderse (lost update) ni duplicarse.
        if (this.mode === 'relajo') {
          const yaSumado = (position - 1) * this.bonusPerSolver();
          if (yaSumado < this.bonusCap()) {
            this.sharedClock += this.bonusPerSolver();
          }
          // Primer acierto: se acorta la silueta para dar paso a la siguiente,
          // pero deja una ventana para que los demás también sumen tiempo.
          if (position === 1 && this.round.timeLeft > RELAJO_ADVANCE_AFTER) {
            this.round.timeLeft = RELAJO_ADVANCE_AFTER;
          }
          this.broadcastSharedClock();
        }

        // Eje 1: difusión WS; Eje 2: incluir timestamp Lamport para ver el orden lógico
        if (this.mode === 'silustack' && position === 1 && this.stack?.active) {
          this.stack.pilotId = id;
          this.stack.pilotNick = player.nick;
          this.broadcastStackState();
        }
        this.broadcast({
          type: 'CORRECT_ANSWER',
          nick: player.nick,
          playerId: player.id,
          position,
          lamport: eventLamport,
          usedHint: this.round.hintedPlayerIds.includes(id),
        });
        return 'correct';
      }
      return 'wrong';
    });
  }

  // --- Fin de ronda / partida ---

  private endRound() {
    if (!this.round) return;
    clearInterval(this.timer);
    this.phase = 'roundEnd';

    // Eje 2: ordenar aciertos por timestamp Lamport (menor = llegó primero en orden lógico).
    // Eje 3: el puntaje se asigna AQUÍ, en serie y con N ya conocido, según la posición
    // lógica de cada uno — por eso no depende de la latencia de red de cada celular.
    const ordered = [...this.round.solvers].sort((a, b) => a.lamport - b.lamport);
    const N = ordered.length;

    // Relajo: la silueta cuenta como despejada si alguien la sacó. Es el
    // marcador colectivo que el grupo intenta batir.
    if (this.mode === 'relajo' && N > 0) {
      this.cleared++;
      this.broadcastSharedClock();
    } else if (this.mode === 'silustack' && N > 0) {
      this.cleared++;
    }

    const solvers = ordered.map((s, i) => {
      const position = i + 1;
      const rawPoints = Math.round(POINTS_BASE + (POINTS_TOP - POINTS_BASE) * (1 - (position - 1) / N));
      const usedHint = this.round!.hintedPlayerIds.includes(s.id);
      const points = usedHint
        ? Math.round(rawPoints * (1 - HINT_PENALTY_PERCENT / 100))
        : rawPoints;
      const player = this.players.get(s.id);
      if (player) player.score += points;
      return {
        nick:     player?.nick ?? '?',
        points,
        position,
        lamport:  s.lamport,
        usedHint,
      };
    });

    this.clock.tick(); // evento interno: fin de ronda
    this.broadcast({
      type:   'ROUND_END',
      word:   this.round.wordEntry.word,
      reveal: this.round.wordEntry.reveal, // el objeto a color, ya sin spoiler
      solvers,
    });
    this.broadcastRanking(false);

    setTimeout(() => this.nextRound(), this.gapBetweenRounds() * 1000);
  }

  /** Cierra el modo Relajo: se acabó el reloj comunitario. */
  private endRelajo() {
    if (this.timer) clearInterval(this.timer);
    this.sharedClock = 0;
    this.broadcastSharedClock();
    // Revela la palabra que quedó a medias antes de mostrar el marcador final.
    if (this.round) {
      this.broadcast({
        type:   'ROUND_END',
        word:   this.round.wordEntry.word,
        reveal: this.round.wordEntry.reveal,
        solvers: [],
      });
    }
    this.endGame();
  }

  private endGame() {
    if (this.timer) clearInterval(this.timer);
    this.phase = 'gameEnd';

    // v2: emitir el resultado final para que el coordinador lo persista (Paso 3).
    // Es un evento interno, NO un broadcast de red: server.ts decide si guardar.
    const medallas: Array<'oro' | 'plata' | 'bronce'> = ['oro', 'plata', 'bronce'];
    const standings = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({
        token:    p.token,
        nick:     p.nick,
        score:    p.score,
        position: i + 1,
        medalla:  medallas[i] ?? null,
      }));
    const result: GameOverResult = {
      gameId: this.currentGameId ?? randomUUID(),
      totalRounds: this.mode === 'silustack' ? (this.stack?.pieces ?? 0) : this.rounds.length,
      standings,
    };
    // Se asigna ANTES del broadcast final: ese broadcast dispara N_REPLICATE,
    // por lo que los seguidores reciben también el resultado pendiente.
    this.pendingGameOverResult = result;
    this.broadcastRanking(true);
    this.emit('game_over', result);
  }

  private broadcastRanking(final: boolean) {
    this.broadcast({ type: 'RANKING', entries: this.getRanking(), final });
  }

  private broadcast(msg: S2C) {
    this.emit('broadcast', msg);
  }
}
