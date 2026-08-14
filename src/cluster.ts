/**
 * Eje 1 (inter-nodo) + Eje 2: Gestión del clúster de 3 nodos.
 *
 * Cada nodo tiene conexiones WS salientes hacia sus PEERS.
 * Cuando un peer se conecta entrante, se identifica con N_HELLO.
 * Todos los mensajes N2N llevan timestamp Lamport para sincronización (Eje 2).
 * La elección de coordinador (Bully) se añadirá en Eje 4.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { N2N } from './types';
import { LamportClock } from './lamport';

// Eje 4: heartbeats entre nodos. El documento pide detectar la caída en ~2s.
const HEARTBEAT_INTERVAL_MS = 1000; // latido a cada peer
// Docker Desktop puede pausar brevemente un contenedor durante el fsync.
const HEARTBEAT_TIMEOUT_MS  = 5000; // evita elecciones falsas sin ocultar una caida real
const HEARTBEAT_CHECK_MS    = 50;

// Eje 4 — Algoritmo del Matón (Bully)
const ELECTION_TIMEOUT_MS = 1500;   // espera de respuestas N_ALIVE antes de proclamarse
const COORD_WAIT_MS       = 3000;   // espera del anuncio de coordinador antes de reintentar

export class Cluster extends EventEmitter {
  readonly nodeId: string;
  coordinatorId:   string;   // puede cambiar con Bully (Eje 4)
  readonly clock:  LamportClock;
  private term = 1;
  private readonly clusterSize: number;
  private quorumAvailableState: boolean;

  // Un par de nodos puede abrir simultáneamente una conexión entrante y otra
  // saliente. Se conservan ambas: cerrar una no debe borrar la otra, que puede
  // seguir sana y transportando heartbeats.
  private peers = new Map<string, Set<WebSocket>>();
  private peerUrls: string[];

  // Eje 4: último latido recibido por peer, y timers de heartbeat
  private lastSeen = new Map<string, number>();
  private hbTimer?:   ReturnType<typeof setInterval>;

  // Eje 4: nodos vistos al menos una vez (para el panel de salud)
  private knownNodes = new Set<string>();

  // Eje 4: estado de la elección Bully
  private electionInProgress = false;
  private gotAlive = false;
  private electionTimer?: ReturnType<typeof setTimeout>;
  private coordWaitTimer?: ReturnType<typeof setTimeout>;

  constructor(nodeId: string, coordinatorId: string, clock: LamportClock, peerUrls: string[]) {
    super();
    this.nodeId        = nodeId;
    this.coordinatorId = coordinatorId;
    this.clock         = clock;
    this.peerUrls      = peerUrls;
    this.clusterSize   = peerUrls.length + 1;
    this.quorumAvailableState = this.hasQuorum;
    this.knownNodes.add(nodeId);

    // Eje 4: si el peer que cae es el coordinador y yo no lo soy, abro elección Bully.
    this.on('peer_disconnected', (peerId: string) => {
      if (peerId === this.coordinatorId && !this.isCoordinator) {
        console.log(`[${this.nodeId}] Coordinador ${peerId} caído -> iniciar elección Bully`);
        this.startElection();
      }
    });
  }

  get isCoordinator() { return this.nodeId === this.coordinatorId; }

  get currentTerm() { return this.term; }

  get quorumSize() { return Math.floor(this.clusterSize / 2) + 1; }

  get hasQuorum() { return this.peers.size + 1 >= this.quorumSize; }

  private emitQuorumIfChanged(): void {
    const available = this.hasQuorum;
    if (available === this.quorumAvailableState) return;
    this.quorumAvailableState = available;
    this.emit('quorum_changed', available);
  }

  getConnectedPeers() { return [...this.peers.keys()]; }

  /** Vista de salud del clúster desde este nodo (para la pantalla maestra). */
  clusterState() {
    const up = new Set([this.nodeId, ...this.peers.keys()]);
    const nodes = [...this.knownNodes].sort().map(id => ({
      id,
      up: up.has(id),
      isCoordinator: id === this.coordinatorId,
    }));
    return {
      nodes,
      electionInProgress: this.electionInProgress,
      term: this.term,
      quorum: this.quorumSize,
      quorumAvailable: this.hasQuorum,
    };
  }

  /** Estado de heartbeats con edad observable para el monitor distribuido. */
  monitoringState(now = Date.now()) {
    const up = new Set([this.nodeId, ...this.peers.keys()]);
    const nodes = [...this.knownNodes].sort().map(id => ({
      id,
      up: up.has(id),
      isCoordinator: id === this.coordinatorId,
      heartbeatAgeMs: id === this.nodeId
        ? 0
        : this.lastSeen.has(id)
          ? Math.max(0, now - this.lastSeen.get(id)!)
          : null,
    }));
    return {
      nodes,
      electionInProgress: this.electionInProgress,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    };
  }

  /** Registra un socket y devuelve true únicamente cuando el peer aparece. */
  private registerPeer(peerId: string, ws: WebSocket): boolean {
    let sockets = this.peers.get(peerId);
    const firstConnection = !sockets || sockets.size === 0;
    if (!sockets) {
      sockets = new Set<WebSocket>();
      this.peers.set(peerId, sockets);
    }
    sockets.add(ws);
    this.lastSeen.set(peerId, Date.now());
    this.knownNodes.add(peerId);
    if (firstConnection) this.emitQuorumIfChanged();
    return firstConnection;
  }

  /** Retira solo el socket cerrado; devuelve true si el peer quedó sin rutas. */
  private unregisterPeer(peerId: string, ws: WebSocket): boolean {
    const sockets = this.peers.get(peerId);
    if (!sockets || !sockets.delete(ws)) return false;
    if (sockets.size > 0) return false;
    this.peers.delete(peerId);
    this.lastSeen.delete(peerId);
    this.emitQuorumIfChanged();
    return true;
  }

  private openSocket(peerId: string): WebSocket | undefined {
    return [...(this.peers.get(peerId) ?? [])].find(ws => ws.readyState === WebSocket.OPEN);
  }

  // ── Conexiones entrantes (llamado por server.ts cuando detecta x-silunet-peer) ──

  handleIncomingPeer(ws: WebSocket) {
    let peerId: string | null = null;

    ws.on('message', (raw) => {
      let msg: N2N;
      try { msg = JSON.parse(raw.toString()) as N2N; }
      catch { return; }

      if (!peerId) {
        if (msg.type !== 'N_HELLO') return;
        peerId = msg.nodeId;
        this.observeTerm(msg.term, msg.coordinatorId);
        const firstConnection = this.registerPeer(peerId, ws);
        this.clock.update(msg.lamport);
        // Responder con nuestro propio HELLO
        this.rawSend(ws, {
          type: 'N_HELLO', nodeId: this.nodeId, term: this.term,
          coordinatorId: this.coordinatorId, lamport: this.clock.tick(),
        });
        if (firstConnection) {
          console.log(`[${this.nodeId}] Peer conectado (entrante): ${peerId}`);
          this.emit('peer_connected', peerId);
        }
        return;
      }

      this.onFrame(peerId, msg);
    });

    ws.on('close', () => {
      if (peerId) {
        if (this.unregisterPeer(peerId, ws)) {
          console.log(`[${this.nodeId}] Peer desconectado: ${peerId}`);
          this.emit('peer_disconnected', peerId);
        }
        peerId = null;
      }
    });

    ws.on('error', () => {});
  }

  // ── Conexiones salientes hacia peerUrls ───────────────────────────────────

  connectToPeers() {
    for (const url of this.peerUrls) {
      this.connectToPeer(url);
    }
    this.startHeartbeats();
  }

  // ── Heartbeats (Eje 4) ─────────────────────────────────────────────────────

  /** Procesa un frame de un peer ya identificado; intercepta los latidos. */
  private onFrame(peerId: string, msg: N2N) {
    this.lastSeen.set(peerId, Date.now());
    if ('term' in msg) this.observeTerm(msg.term, msg.type === 'N_HEARTBEAT' ? msg.coordinatorId : undefined);
    if (msg.type === 'N_HEARTBEAT') { this.clock.merge(msg.lamport); return; }
    if (msg.type === 'N_MONITOR_REPORT') {
      // La observabilidad no crea un evento causal del juego.
      this.clock.merge(msg.lamport);
      this.emit('peer_message', msg, peerId);
      return;
    }
    this.clock.update(msg.lamport);
    if (msg.type === 'N_ELECTION' || msg.type === 'N_ALIVE' || msg.type === 'N_COORDINATOR') {
      this.handleElection(msg);
      return;
    }
    this.emit('peer_message', msg, peerId);
  }

  // ── Elección de líder — Algoritmo del Matón / Bully (Eje 4) ─────────────────

  /** ¿Es el nodo `a` de mayor jerarquía que `b`? (mayor número de nodo gana). */
  private higher(a: string, b: string): boolean {
    const na = parseInt(a.replace(/\D/g, ''), 10);
    const nb = parseInt(b.replace(/\D/g, ''), 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na > nb;
    return a > b;
  }

  private observeTerm(remoteTerm: number, coordinatorId?: string): void {
    if (!Number.isSafeInteger(remoteTerm) || remoteTerm < this.term) return;
    if (remoteTerm > this.term) {
      this.term = remoteTerm;
      this.clearElectionTimers();
      this.electionInProgress = false;
    }
    if (coordinatorId && remoteTerm === this.term && coordinatorId !== this.coordinatorId) {
      this.setCoordinator(coordinatorId, remoteTerm);
    }
  }

  restoreTerm(term: number): void {
    if (Number.isSafeInteger(term) && term > this.term) this.term = term;
  }

  private handleElection(msg: { type: string; nodeId: string; term: number }) {
    switch (msg.type) {
      case 'N_ELECTION':
        // Un nodo menor me reta: respondo que sigo vivo y arranco mi propia elección.
        this.sendToPeer(msg.nodeId, {
          type: 'N_ALIVE', nodeId: this.nodeId, term: this.term, lamport: this.clock.tick(),
        });
        this.startElection();
        break;
      case 'N_ALIVE':
        // Hay alguien mayor vivo: no seré coordinador; espero su anuncio.
        this.gotAlive = true;
        if (this.electionTimer) clearTimeout(this.electionTimer);
        this.waitForCoordinator();
        break;
      case 'N_COORDINATOR':
        this.setCoordinator(msg.nodeId, msg.term);
        break;
    }
  }

  /** Inicia una elección: reta a los nodos de mayor jerarquía conectados. */
  startElection() {
    if (this.isCoordinator && this.hasQuorum) { this.announceVictory(); return; }
    if (this.electionInProgress) return;
    if (!this.hasQuorum) {
      this.emit('quorum_lost');
      return;
    }
    this.term++;
    this.electionInProgress = true;
    this.gotAlive = false;
    // Panel didáctico de /master: avisa de inmediato que arrancó una elección,
    // sin esperar a que termine (become_coordinator ya avisa el cierre).
    this.emit('election_started');

    const higher = [...this.peers.keys()].filter(id => this.higher(id, this.nodeId));
    console.log(`[${this.nodeId}] Elección Bully: nodos mayores conectados = [${higher.join(', ')}]`);

    if (higher.length === 0) { this.becomeCoordinator(); return; }

    for (const id of higher) {
      this.sendToPeer(id, {
        type: 'N_ELECTION', nodeId: this.nodeId, term: this.term, lamport: this.clock.tick(),
      });
    }
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.electionTimer = setTimeout(() => {
      if (!this.gotAlive) this.becomeCoordinator(); // nadie mayor respondió → gano
    }, ELECTION_TIMEOUT_MS);
  }

  private waitForCoordinator() {
    if (this.coordWaitTimer) clearTimeout(this.coordWaitTimer);
    this.coordWaitTimer = setTimeout(() => {
      // El nodo mayor no anunció victoria (quizá también cayó) → reintento.
      this.electionInProgress = false;
      this.startElection();
    }, COORD_WAIT_MS);
  }

  private becomeCoordinator() {
    if (!this.hasQuorum) {
      this.electionInProgress = false;
      this.emit('quorum_lost');
      return;
    }
    if (this.isCoordinator) return;
    console.log(`[${this.nodeId}] [COORDINATOR] Me proclamo COORDINADOR (Bully)`);
    this.coordinatorId = this.nodeId;
    this.clearElectionTimers();
    this.electionInProgress = false;
    this.announceVictory();
    this.emit('became_coordinator');
    this.emit('coordinator_changed', this.nodeId);
  }

  private announceVictory() {
    this.broadcastToPeers({
      type: 'N_COORDINATOR', nodeId: this.nodeId, term: this.term, lamport: this.clock.tick(),
    });
  }

  private setCoordinator(id: string, term = this.term) {
    if (term < this.term) return;
    this.term = term;
    this.clearElectionTimers();
    this.electionInProgress = false;
    if (this.coordinatorId !== id) {
      this.coordinatorId = id;
      console.log(`[${this.nodeId}] Nuevo coordinador reconocido: ${id}`);
      this.emit('coordinator_changed', id);
    }
  }

  private clearElectionTimers() {
    if (this.electionTimer)  { clearTimeout(this.electionTimer);  this.electionTimer = undefined; }
    if (this.coordWaitTimer) { clearTimeout(this.coordWaitTimer); this.coordWaitTimer = undefined; }
  }

  /** Envía un latido a cada peer y vigila la ausencia de latidos. */
  private startHeartbeats() {
    if (this.hbTimer) return;
    this.hbTimer = setInterval(() => {
      this.broadcastToPeers({
        type: 'N_HEARTBEAT', nodeId: this.nodeId, term: this.term,
        coordinatorId: this.coordinatorId, lamport: this.clock.value,
      });
    }, HEARTBEAT_INTERVAL_MS);
    setInterval(() => this.checkTimeouts(), HEARTBEAT_CHECK_MS);
  }

  /** Marca como caído a todo peer del que no llega latido dentro del umbral. */
  private checkTimeouts() {
    const now = Date.now();
    for (const [peerId, sockets] of [...this.peers]) {
      const last = this.lastSeen.get(peerId) ?? now;
      if (now - last >= HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[${this.nodeId}] heartbeat perdido de ${peerId} (${now - last}ms) -> caido`);
        this.peers.delete(peerId);
        this.lastSeen.delete(peerId);
        for (const ws of sockets) {
          try { ws.terminate(); } catch { /* ya cerrado */ }
        }
        this.emit('peer_timeout', peerId);      // señal para Bully (Paso C)
        this.emit('peer_disconnected', peerId);
      }
    }
  }

  private connectToPeer(url: string) {
    const ws = new WebSocket(url, { headers: { 'x-silunet-peer': '1' } });
    let peerId: string | null = null;

    ws.on('open', () => {
      this.rawSend(ws, {
        type: 'N_HELLO', nodeId: this.nodeId, term: this.term,
        coordinatorId: this.coordinatorId, lamport: this.clock.tick(),
      });
    });

    ws.on('message', (raw) => {
      let msg: N2N;
      try { msg = JSON.parse(raw.toString()) as N2N; }
      catch { return; }

      if (!peerId) {
        if (msg.type !== 'N_HELLO') return;
        peerId = msg.nodeId;
        this.observeTerm(msg.term, msg.coordinatorId);
        const firstConnection = this.registerPeer(peerId, ws);
        this.clock.update(msg.lamport);
        if (firstConnection) {
          console.log(`[${this.nodeId}] Conectado a peer (saliente): ${peerId}`);
          this.emit('peer_connected', peerId);
        }
        return;
      }

      this.onFrame(peerId, msg);
    });

    ws.on('close', () => {
      if (peerId) {
        if (this.unregisterPeer(peerId, ws)) this.emit('peer_disconnected', peerId);
        peerId = null;
      }
      // Reintentar conexión después de 3s
      setTimeout(() => this.connectToPeer(url), 3000);
    });

    ws.on('error', () => { /* close handler reintenta */ });
  }

  // ── Envío de mensajes ─────────────────────────────────────────────────────

  /** Envía al coordinador. Si somos coordinador, emite localmente. */
  sendToCoordinator(msg: N2N) {
    if (this.isCoordinator) {
      // Procesamiento local — igual que si llegara por red
      setImmediate(() => this.emit('peer_message', msg, this.nodeId));
      return;
    }
    const ws = this.openSocket(this.coordinatorId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn(`[${this.nodeId}] Coordinador (${this.coordinatorId}) no disponible`);
    }
  }

  /** Envía a un peer específico. */
  sendToPeer(peerId: string, msg: N2N) {
    const ws = this.openSocket(peerId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Difunde a todos los peers conectados. */
  broadcastToPeers(msg: N2N) {
    const data = JSON.stringify(msg);
    for (const peerId of this.peers.keys()) {
      const ws = this.openSocket(peerId);
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private rawSend(ws: WebSocket, msg: N2N) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
