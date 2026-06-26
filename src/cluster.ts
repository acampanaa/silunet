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
const HEARTBEAT_TIMEOUT_MS  = 2500; // sin latido por más de esto → peer caído

export class Cluster extends EventEmitter {
  readonly nodeId: string;
  coordinatorId:   string;   // puede cambiar con Bully (Eje 4)
  readonly clock:  LamportClock;

  // peerId → WebSocket (tanto conexiones salientes como entrantes)
  private peers = new Map<string, WebSocket>();
  private peerUrls: string[];

  // Eje 4: último latido recibido por peer, y timers de heartbeat
  private lastSeen = new Map<string, number>();
  private hbTimer?:   ReturnType<typeof setInterval>;
  private hbMonitor?: ReturnType<typeof setInterval>;

  constructor(nodeId: string, coordinatorId: string, clock: LamportClock, peerUrls: string[]) {
    super();
    this.nodeId        = nodeId;
    this.coordinatorId = coordinatorId;
    this.clock         = clock;
    this.peerUrls      = peerUrls;
  }

  get isCoordinator() { return this.nodeId === this.coordinatorId; }

  getConnectedPeers() { return [...this.peers.keys()]; }

  // ── Conexiones entrantes (llamado por server.ts cuando detecta x-quorum-peer) ──

  handleIncomingPeer(ws: WebSocket) {
    let peerId: string | null = null;

    ws.on('message', (raw) => {
      let msg: N2N;
      try { msg = JSON.parse(raw.toString()) as N2N; }
      catch { return; }

      if (!peerId) {
        if (msg.type !== 'N_HELLO') return;
        peerId = msg.nodeId;
        this.peers.set(peerId, ws);
        this.lastSeen.set(peerId, Date.now());
        this.clock.update(msg.lamport);
        // Responder con nuestro propio HELLO
        this.rawSend(ws, { type: 'N_HELLO', nodeId: this.nodeId, lamport: this.clock.tick() });
        console.log(`[${this.nodeId}] Peer conectado (entrante): ${peerId}`);
        this.emit('peer_connected', peerId);
        return;
      }

      this.onFrame(ws, peerId, msg);
    });

    ws.on('close', () => {
      if (peerId) {
        this.peers.delete(peerId);
        console.log(`[${this.nodeId}] Peer desconectado: ${peerId}`);
        this.emit('peer_disconnected', peerId);
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
  private onFrame(ws: WebSocket, peerId: string, msg: N2N) {
    this.lastSeen.set(peerId, Date.now());
    if (msg.type === 'N_HEARTBEAT') { this.clock.merge(msg.lamport); return; }
    this.clock.update(msg.lamport);
    this.emit('peer_message', msg, peerId);
  }

  /** Envía un latido a cada peer y vigila la ausencia de latidos. */
  private startHeartbeats() {
    if (this.hbTimer) return;
    this.hbTimer = setInterval(() => {
      this.broadcastToPeers({ type: 'N_HEARTBEAT', nodeId: this.nodeId, lamport: this.clock.value });
    }, HEARTBEAT_INTERVAL_MS);
    this.hbMonitor = setInterval(() => this.checkTimeouts(), HEARTBEAT_INTERVAL_MS);
  }

  /** Marca como caído a todo peer del que no llega latido dentro del umbral. */
  private checkTimeouts() {
    const now = Date.now();
    for (const [peerId, ws] of [...this.peers]) {
      const last = this.lastSeen.get(peerId) ?? now;
      if (now - last > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[${this.nodeId}] heartbeat perdido de ${peerId} (${now - last}ms) -> caido`);
        this.peers.delete(peerId);
        this.lastSeen.delete(peerId);
        try { ws.terminate(); } catch { /* ya cerrado */ }
        this.emit('peer_timeout', peerId);      // señal para Bully (Paso C)
        this.emit('peer_disconnected', peerId);
      }
    }
  }

  private connectToPeer(url: string) {
    const ws = new WebSocket(url, { headers: { 'x-quorum-peer': '1' } });
    let peerId: string | null = null;

    ws.on('open', () => {
      this.rawSend(ws, { type: 'N_HELLO', nodeId: this.nodeId, lamport: this.clock.tick() });
    });

    ws.on('message', (raw) => {
      let msg: N2N;
      try { msg = JSON.parse(raw.toString()) as N2N; }
      catch { return; }

      if (!peerId) {
        if (msg.type !== 'N_HELLO') return;
        peerId = msg.nodeId;
        this.peers.set(peerId, ws);
        this.lastSeen.set(peerId, Date.now());
        this.clock.update(msg.lamport);
        console.log(`[${this.nodeId}] Conectado a peer (saliente): ${peerId}`);
        this.emit('peer_connected', peerId);
        return;
      }

      this.onFrame(ws, peerId, msg);
    });

    ws.on('close', () => {
      if (peerId) {
        this.peers.delete(peerId);
        this.emit('peer_disconnected', peerId);
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
    const ws = this.peers.get(this.coordinatorId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn(`[${this.nodeId}] Coordinador (${this.coordinatorId}) no disponible`);
    }
  }

  /** Envía a un peer específico. */
  sendToPeer(peerId: string, msg: N2N) {
    const ws = this.peers.get(peerId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Difunde a todos los peers conectados. */
  broadcastToPeers(msg: N2N) {
    const data = JSON.stringify(msg);
    for (const ws of this.peers.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private rawSend(ws: WebSocket, msg: N2N) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
