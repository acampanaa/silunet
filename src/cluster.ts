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

export class Cluster extends EventEmitter {
  readonly nodeId: string;
  coordinatorId:   string;   // puede cambiar con Bully (Eje 4)
  readonly clock:  LamportClock;

  // peerId → WebSocket (tanto conexiones salientes como entrantes)
  private peers = new Map<string, WebSocket>();
  private peerUrls: string[];

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
        this.clock.update(msg.lamport);
        // Responder con nuestro propio HELLO
        this.rawSend(ws, { type: 'N_HELLO', nodeId: this.nodeId, lamport: this.clock.tick() });
        console.log(`[${this.nodeId}] Peer conectado (entrante): ${peerId}`);
        this.emit('peer_connected', peerId);
        return;
      }

      this.clock.update(msg.lamport);
      this.emit('peer_message', msg, peerId);
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
        this.clock.update(msg.lamport);
        console.log(`[${this.nodeId}] Conectado a peer (saliente): ${peerId}`);
        this.emit('peer_connected', peerId);
        return;
      }

      this.clock.update(msg.lamport);
      this.emit('peer_message', msg, peerId);
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
