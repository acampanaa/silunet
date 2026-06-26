import { EventEmitter } from 'events';
import { GamePhase, Player, WordEntry, RoundState, RankEntry, S2C, GameSnapshot } from './types';
import { getRandomRounds } from './wordBank';
import { LamportClock } from './lamport';
import { Mutex } from './mutex';

const TOTAL_TIME   = 24;  // segundos por ronda
const REVEAL_EVERY = 4;   // revelar una letra cada N segundos
const GAP_BETWEEN  = 4;   // segundos entre rondas

// Eje 2+3: el puntaje depende de la POSICIÓN LÓGICA de llegada (orden de Lamport
// resuelto por el coordinador), NO del tiempo ni de la latencia de red del celular.
//   puntos = POINTS_BASE + (POINTS_TOP - POINTS_BASE) * (1 - (posición - 1) / N)
// con N = total de aciertos de la ronda. Primero (pos=1) → POINTS_TOP.
const POINTS_TOP  = 1000; // puntos del primero en orden lógico
const POINTS_BASE = 100;  // base garantizada (el último en orden lógico tiende a esto)

export class Game extends EventEmitter {
  private players         = new Map<string, Player>();
  private phase: GamePhase = 'waiting';
  private rounds: WordEntry[] = [];
  private currentRoundIndex  = -1;
  private round?: RoundState;
  private timer?: ReturnType<typeof setInterval>;

  // Eje 2: reloj de Lamport del nodo
  readonly clock = new LamportClock();

  // Eje 3: candado lógico que serializa el acceso al marcador compartido
  private readonly scoreboardLock = new Mutex('marcador');

  // --- Consultas de estado ---

  getPhase()       { return this.phase; }
  getPlayerCount() { return this.players.size; }
  getPlayer(id: string) { return this.players.get(id); }

  getRanking(): RankEntry[] {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map(p => ({ nick: p.nick, score: p.score }));
  }

  getCurrentRoundInfo() {
    if (!this.round || this.phase !== 'playing') return null;
    return {
      roundNumber: this.currentRoundIndex + 1,
      totalRounds: this.rounds.length,
      category:    this.round.wordEntry.category,
      svg:         this.round.wordEntry.svg,
      hiddenWord:  this.round.hiddenWord.join(' '),
      timeLeft:    this.round.timeLeft,
      totalTime:   this.round.totalTime,
    };
  }

  // --- Replicación (Eje 3: réplica por nodo) ---

  /** Estado autoritativo completo, para enviar a los seguidores (N_REPLICATE). */
  snapshot(): GameSnapshot {
    return {
      phase:             this.phase,
      rounds:            this.rounds,
      currentRoundIndex: this.currentRoundIndex,
      round:             this.round ?? null,
      players:           [...this.players.values()].map(p => ({ ...p })),
      lamport:           this.clock.value,
    };
  }

  /**
   * Aplica un snapshot recibido del coordinador. Réplica PASIVA: solo absorbe
   * estado, nunca arranca timers ni emite eventos. Si este nodo es promovido a
   * coordinador (Bully, Paso C), reanudará la partida desde esta réplica.
   */
  restore(s: GameSnapshot): void {
    this.phase             = s.phase;
    this.rounds            = s.rounds;
    this.currentRoundIndex = s.currentRoundIndex;
    this.round             = s.round ?? undefined;
    this.players           = new Map(s.players.map(p => [p.id, { ...p }]));
    this.clock.merge(s.lamport);
  }

  /**
   * Eje 4: este nodo acaba de ser promovido a coordinador (Bully). Reanuda la
   * partida desde la réplica: re-sincroniza a los clientes y vuelve a arrancar
   * los timers que solo corren en el coordinador.
   */
  resume(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.phase === 'playing' && this.round) {
      this.broadcast({
        type:        'ROUND_START',
        roundNumber: this.currentRoundIndex + 1,
        totalRounds: this.rounds.length,
        category:    this.round.wordEntry.category,
        svg:         this.round.wordEntry.svg,
        hiddenWord:  this.round.hiddenWord.join(' '),
        timeLeft:    this.round.timeLeft,
        totalTime:   this.round.totalTime,
      });
      this.timer = setInterval(() => this.tick(), 1000);
    } else if (this.phase === 'roundEnd') {
      setTimeout(() => this.nextRound(), GAP_BETWEEN * 1000);
    }
  }

  // --- Gestión de jugadores ---

  addPlayer(id: string, nick: string): Player {
    const player: Player = { id, nick, score: 0 };
    this.players.set(id, player);
    this.broadcast({ type: 'PLAYER_COUNT', count: this.players.size });
    return player;
  }

  removePlayer(id: string) {
    const player = this.players.get(id);
    this.players.delete(id);
    // Eje 4: avisar al stand para mostrar "Jugador X: Desconectado"
    if (player) this.broadcast({ type: 'PLAYER_LEFT', nick: player.nick });
    this.broadcast({ type: 'PLAYER_COUNT', count: this.players.size });
  }

  // --- Control de partida ---

  startGame(totalRounds = 10): boolean {
    if (this.phase !== 'waiting' && this.phase !== 'gameEnd') return false;
    if (this.timer) clearInterval(this.timer);

    for (const p of this.players.values()) p.score = 0;
    this.rounds = getRandomRounds(Math.min(totalRounds, 12));
    this.currentRoundIndex = -1;
    this.nextRound();
    return true;
  }

  private nextRound() {
    this.currentRoundIndex++;
    if (this.currentRoundIndex >= this.rounds.length) {
      this.endGame();
      return;
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
      timeLeft:      TOTAL_TIME,
      totalTime:     TOTAL_TIME,
      solvers:       [],
    };
    this.phase = 'playing';

    this.broadcast({
      type:        'ROUND_START',
      roundNumber: this.currentRoundIndex + 1,
      totalRounds: this.rounds.length,
      category:    entry.category,
      svg:         entry.svg,
      hiddenWord:  this.round.hiddenWord.join(' '),
      timeLeft:    TOTAL_TIME,
      totalTime:   TOTAL_TIME,
    });

    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick() {
    if (!this.round) return;
    this.round.timeLeft--;

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

    if (this.round.timeLeft <= 0) this.endRound();
  }

  // --- Lógica de adivinanza ---

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

        // Eje 1: difusión WS; Eje 2: incluir timestamp Lamport para ver el orden lógico
        this.broadcast({ type: 'CORRECT_ANSWER', nick: player.nick, playerId: player.id, position, lamport: eventLamport });
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

    const solvers = ordered.map((s, i) => {
      const position = i + 1;
      const points = Math.round(POINTS_BASE + (POINTS_TOP - POINTS_BASE) * (1 - (position - 1) / N));
      const player = this.players.get(s.id);
      if (player) player.score += points;
      return {
        nick:     player?.nick ?? '?',
        points,
        position,
        lamport:  s.lamport,
      };
    });

    this.clock.tick(); // evento interno: fin de ronda
    this.broadcast({ type: 'ROUND_END', word: this.round.wordEntry.word, solvers });
    this.broadcastRanking(false);

    setTimeout(() => this.nextRound(), GAP_BETWEEN * 1000);
  }

  private endGame() {
    if (this.timer) clearInterval(this.timer);
    this.phase = 'gameEnd';
    this.broadcastRanking(true);
  }

  private broadcastRanking(final: boolean) {
    this.broadcast({ type: 'RANKING', entries: this.getRanking(), final });
  }

  private broadcast(msg: S2C) {
    this.emit('broadcast', msg);
  }
}
