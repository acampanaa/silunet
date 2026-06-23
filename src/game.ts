import { EventEmitter } from 'events';
import { GamePhase, Player, WordEntry, RoundState, RankEntry, S2C } from './types';
import { getRandomRounds } from './wordBank';
import { LamportClock } from './lamport';

const TOTAL_TIME   = 24;  // segundos por ronda
const REVEAL_EVERY = 4;   // revelar una letra cada N segundos
const GAP_BETWEEN  = 4;   // segundos entre rondas
const POINTS_BASE  = 100;
const POINTS_MIN   = 10;  // puntos mínimos por respuesta correcta

export class Game extends EventEmitter {
  private players         = new Map<string, Player>();
  private phase: GamePhase = 'waiting';
  private rounds: WordEntry[] = [];
  private currentRoundIndex  = -1;
  private round?: RoundState;
  private timer?: ReturnType<typeof setInterval>;

  // Eje 2: reloj de Lamport del nodo
  readonly clock = new LamportClock();

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

  // --- Gestión de jugadores ---

  addPlayer(id: string, nick: string): Player {
    const player: Player = { id, nick, score: 0 };
    this.players.set(id, player);
    this.broadcast({ type: 'PLAYER_COUNT', count: this.players.size });
    return player;
  }

  removePlayer(id: string) {
    this.players.delete(id);
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
  // Ese valor es el timestamp oficial del evento "acierto" en este nodo.
  handleGuess(id: string, word: string, clientLamport: number): 'correct' | 'wrong' | 'already_solved' | 'not_playing' {
    if (!this.round || this.phase !== 'playing') return 'not_playing';
    if (this.round.solvers.find(s => s.id === id)) return 'already_solved';

    // Sincronizar reloj antes de procesar el evento
    const eventLamport = this.clock.update(clientLamport);

    if (word.trim().toUpperCase() === this.round.wordEntry.word) {
      const points = Math.max(
        POINTS_MIN,
        Math.round(POINTS_BASE * (this.round.timeLeft / this.round.totalTime))
      );
      const player = this.players.get(id)!;
      player.score += points;
      this.round.solvers.push({ id, points, lamport: eventLamport });

      // Eje 1: difusión WS; Eje 2: incluir timestamp Lamport para que todos vean el orden lógico
      this.broadcast({ type: 'CORRECT_ANSWER', nick: player.nick, playerId: player.id, points, lamport: eventLamport });
      return 'correct';
    }
    return 'wrong';
  }

  // --- Fin de ronda / partida ---

  private endRound() {
    if (!this.round) return;
    clearInterval(this.timer);
    this.phase = 'roundEnd';

    // Eje 2: ordenar aciertos por timestamp Lamport (menor = acertó primero en orden lógico)
    const solvers = [...this.round.solvers]
      .sort((a, b) => a.lamport - b.lamport)
      .map(s => ({
        nick:    this.players.get(s.id)?.nick ?? '?',
        points:  s.points,
        lamport: s.lamport,
      }));

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
