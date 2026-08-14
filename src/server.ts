import http              from 'http';
import fs                from 'fs';
import path              from 'path';
import os                from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Game }          from './game';
import { Cluster }       from './cluster';
import { Store, normalizeAvatarId, PersistenceStore } from './db';
import { PostgresStore } from './postgres';
import { DurableReplica, ReplicaStore } from './replicaStore';
import {
  BrowserTelemetry,
  C2S,
  GameOverResult,
  GameSnapshot,
  MonitorParticipant,
  N2N,
  P2PPeerDescriptor,
  S2C,
  WordEntry,
} from './types';
import { getRandomRounds } from './wordBank';
import {
  DistributedMonitoring,
  MONITOR_CLIENT_TIMEOUT_MS,
  MONITOR_HEARTBEAT_INTERVAL_MS,
} from './monitoring';

// ── Configuración por instancia ───────────────────────────────────────────────
const NODE_ID        = process.env.NODE_ID        ?? 'node1';
const PORT           = parseInt(process.env.PORT  ?? '3001', 10);
const COORDINATOR_ID = process.env.COORDINATOR_ID ?? 'node1';
const PEER_URLS      = (process.env.PEERS ?? '').split(',').map(url => url.trim()).filter(Boolean);
const PUBLIC_NODES_SETTING = (process.env.PUBLIC_NODES ?? '').trim();
const SAME_ORIGIN_GATEWAY = PUBLIC_NODES_SETTING.toLowerCase() === 'origin';
const PUBLIC_NODE_URLS = SAME_ORIGIN_GATEWAY
  ? []
  : PUBLIC_NODES_SETTING.split(',').map(url => url.trim()).filter(Boolean);
const MAX_PLAYERS = 5;
const CLUSTER_ID = process.env.CLUSTER_ID ?? 'silunet-main';
const REPLICA_DIR = process.env.REPLICA_DIR ?? path.join(__dirname, '..', 'data', 'replicas');
const REPLICA_COMMIT_TIMEOUT_MS = 4000;
const REPLICA_SYNC_WINDOW_MS = 700;

// El Game corre en todos los nodos pero solo el coordinador lo controla.
// El reloj Lamport es compartido entre game y cluster (mismo objeto).
const game    = new Game();
const cluster = new Cluster(NODE_ID, COORDINATOR_ID, game.clock, PEER_URLS);
const monitoring = new DistributedMonitoring(NODE_ID);
const replicaStore = new ReplicaStore(NODE_ID, CLUSTER_ID, REPLICA_DIR);

// Cada proceso arranca desde disco antes de aceptar conexiones. La memoria es
// solo una cache de ejecucion: el sucesor puede reconstruirse tras reiniciarse.
const bootReplica = replicaStore.load();
if (bootReplica) {
  cluster.restoreTerm(bootReplica.term);
  game.restore(bootReplica.snapshot);
  console.log(`[${NODE_ID}] [REPLICA] Restaurada version ${bootReplica.index} (term ${bootReplica.term}) desde disco`);
}

// Persistencia de identidad e historia. En despliegue, todos los nodos apuntan
// a la misma instancia PostgreSQL; SQLite solo conserva el flujo de desarrollo.
// El coordinador resuelve identidad y escribe. La partida en vivo nunca lee aquí.
const DATABASE_URL = process.env.DATABASE_URL;
const store: PersistenceStore = DATABASE_URL
  ? new PostgresStore(DATABASE_URL, NODE_ID)
  : new Store(path.join(__dirname, '..', 'data', `silunet-${NODE_ID}.db`));
let persistenceInitialized = false;
let persistenceLeader = false;

if (!DATABASE_URL && PEER_URLS.length > 0) {
  console.warn(`[${NODE_ID}] [WARN] Sin PostgreSQL: el juego distribuido continúa; solo el historial queda local a este nodo.`);
}

const AVATAR_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CUSTOM_AVATAR_BYTES = 200 * 1024;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.woff2': 'font/woff2',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
};

function getLocalIP(): string {
  const all: Array<{ name: string; addr: string }> = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal)
        all.push({ name: name.toLowerCase(), addr: iface.address });
    }
  }
  const wifi = all.find(i => i.name.includes('wi-fi') || i.name.includes('wlan') || i.name.includes('wlp'));
  return (wifi ?? all[0])?.addr ?? 'localhost';
}

// Eje 4 (resiliencia de cliente): direcciones HTTP de los otros nodos del clúster,
// derivadas de PEERS (mismo host:puerto que ya usa el WS inter-nodo). Se inyectan
// en /play para que un celular que pierde la conexión con ESTE nodo (se cayó o
// perdió la elección Bully) pueda reconectarse solo por cualquier otro nodo vivo,
// sin perder su sesión ni su puntaje de la partida en curso.
function siblingNodeUrls(): string[] {
  // Detras del gateway Docker el navegador solo necesita su origen actual. Si
  // el backend asignado cae, Nginx acepta la reconexion y selecciona otro.
  if (SAME_ORIGIN_GATEWAY) return [];
  const self = `http://${getLocalIP()}:${PORT}`;
  if (PUBLIC_NODE_URLS.length > 0) {
    return [...new Set(PUBLIC_NODE_URLS.map(u => u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')))];
  }
  const configured = PEER_URLS;
  const siblings = configured.map(u => u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
  return [...new Set([self, ...siblings])];
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function requestOrigin(req: IncomingMessage): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
    .split(',')[0]
    .trim();
  const candidate = forwardedHost || String(req.headers.host ?? '').trim();
  const host = candidate && !/[\\/\s]/.test(candidate)
    ? candidate
    : `${getLocalIP()}:${PORT}`;

  return `${protocol}://${host}`;
}

const httpServer = http.createServer((req, res) => {
  let urlPath = (req.url ?? '/').split('?')[0];

  const avatarMatch = urlPath.match(/^\/api\/avatar\/([0-9a-f-]+)$/i);
  if (avatarMatch) {
    if (!AVATAR_KEY_RE.test(avatarMatch[1])) {
      res.writeHead(404); res.end('Not found'); return;
    }
    void Promise.resolve(store.getAvatar(avatarMatch[1]))
      .then(avatar => {
        if (!avatar) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': avatar.mime,
          'Content-Length': avatar.data.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(avatar.data);
      })
      .catch(error => {
        console.error(`[${NODE_ID}] No se pudo leer el avatar ${avatarMatch[1]}:`, error);
        if (!res.headersSent) res.writeHead(503);
        res.end('Avatar unavailable');
      });
    return;
  }

  if (urlPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      joinUrl:       `${requestOrigin(req)}/join`,
      nodeId:        NODE_ID,
      isCoordinator: cluster.isCoordinator,
      coordinator:   cluster.coordinatorId,
      connectedPeers: cluster.getConnectedPeers(),
      persistenceReady: persistenceInitialized,
      persistenceLeader,
      clusterTerm: cluster.currentTerm,
      quorumRequired: cluster.quorumSize,
      quorumAvailable: cluster.hasQuorum,
      replicaIndex: replicaStore.index,
      replicaFile: replicaStore.filePath,
      // Réplica local (Eje 3): permite comparar seguidor vs coordinador
      phase:         game.getPhase(),
      round:         game.getCurrentRoundInfo(),
      ranking:       game.getRanking(),
      lamport:       game.clock.value,
    }));
    return;
  }

  if (urlPath === '/') urlPath = '/join';

  const pageMap: Record<string, string> = {
    '/join':   'join.html',
    '/play':   'play.html',
    '/master': 'master.html',
  };

  const htmlFile = pageMap[urlPath];
  const filePath = htmlFile
    ? path.join(PUBLIC_DIR, htmlFile)
    : path.join(PUBLIC_DIR, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    let body: Buffer | string = data;
    if (htmlFile === 'play.html' || htmlFile === 'master.html') {
      // Eje 4: la lista de nodos viaja embebida en el HTML (no por WS), para que
      // ya esté disponible ANTES de que el nodo actual se caiga. También se usa
      // en /master: si el nodo al que está pegado el proyector muere, la
      // pantalla pública no puede quedarse congelada.
      const nodesScript = `<script>window.SILUNET_NODES = ${JSON.stringify(siblingNodeUrls())};</script>\n`;
      body = data.toString('utf8').replace('</head>', `${nodesScript}</head>`);
    }
    const cacheControl = ext === '.html'
      ? 'no-store'
      : ext === '.js' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(body);
  });
});

// ── WebSocket helpers ─────────────────────────────────────────────────────────

interface ClientMeta {
  connectionId: string;
  connectedAt: number;
  playerId?: string;
  role: 'player' | 'master' | 'unknown';
  lastSeen?: number; // Eje 4: último heartbeat recibido de este cliente
  lastPingAt?: number;
  nick?: string;
  telemetry?: BrowserTelemetry;
  joinInFlight?: boolean;
  // El celular tiene el monitor distribuido abierto (ver MONITOR_SUBSCRIBE).
  monitorSubscribed?: boolean;
  p2pPeerId?: string;
  p2pRole?: 'player' | 'master';
  p2pNick?: string;
  heartbeatDeadline?: ReturnType<typeof setTimeout>;
}

const clients = new Map<WebSocket, ClientMeta>();
const VERSIONED_ACTIONS = new Set<string>([
  'GUESS', 'REQUEST_HINT', 'START_GAME', 'END_GAME', 'STACK_ACTION', 'CAST_VOTE',
]);

// La replica avanza con cada broadcast. Entre el ultimo mensaje que recibe el
// navegador y su accion pueden confirmarse algunos commits (especialmente a
// traves del gateway/tunel). Una ventana pequena conserva el cerco contra
// acciones realmente antiguas sin rechazar votos o respuestas por una carrera
// normal de red.
const MAX_ACTION_VERSION_LAG = 8;

function actionVersionIsAcceptable(received: number | null, expected: number): boolean {
  return received == null
    || (Number.isSafeInteger(received) && received <= expected && expected - received <= MAX_ACTION_VERSION_LAG);
}

function validateClientState(ws: WebSocket, msg: C2S): boolean {
  if (!VERSIONED_ACTIONS.has(msg.type)) return true;
  if (!cluster.hasQuorum) {
    send(ws, { type: 'ERROR', message: 'El clúster no tiene mayoría; la jugada no fue aplicada.' });
    return false;
  }
  const received = msg.stateVersion == null ? null : Number(msg.stateVersion);
  const expected = replicaStore.index;
  const versionMatches = actionVersionIsAcceptable(received, expected);
  if (versionMatches && (!cluster.isCoordinator || game.acceptAction(msg.actionId))) return true;
  if (versionMatches) {
    send(ws, { type: 'ERROR', message: 'La jugada duplicada ya habia sido procesada.' });
    return false;
  }

  send(ws, { type: 'STATE_STALE', expectedVersion: expected, receivedVersion: received ?? -1 });
  const round = game.getCurrentRoundInfo();
  if (round) send(ws, { type: 'ROUND_START', ...round });
  send(ws, { type: 'RANKING', entries: game.getRanking(), final: game.getPhase() === 'gameEnd' });
  const stack = game.stackState();
  if (stack) send(ws, { type: 'STACK_STATE', state: stack });
  return false;
}

function armClientHeartbeat(ws: WebSocket, meta: ClientMeta): void {
  if (meta.heartbeatDeadline) clearTimeout(meta.heartbeatDeadline);
  const lastSeen = meta.lastSeen ?? meta.connectedAt;
  const remaining = Math.max(1, MONITOR_CLIENT_TIMEOUT_MS - (Date.now() - lastSeen));
  meta.heartbeatDeadline = setTimeout(() => {
    const age = Date.now() - (meta.lastSeen ?? meta.connectedAt);
    if (age < MONITOR_CLIENT_TIMEOUT_MS) {
      armClientHeartbeat(ws, meta);
      return;
    }
    console.log(`[${NODE_ID}] [WARN] Cliente ${meta.playerId ?? meta.connectionId} sin latido (${age}ms) -> baja`);
    ws.terminate();
  }, remaining);
}

function finiteMetric(value: unknown, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(max, Math.round(numeric))) : 0;
}

function sanitizeBrowserTelemetry(value: BrowserTelemetry | undefined): BrowserTelemetry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const leaderId = typeof value.leaderId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value.leaderId)
    ? value.leaderId
    : null;
  const serverRttMs = Number.isFinite(Number(value.serverRttMs))
    ? finiteMetric(value.serverRttMs, 30_000)
    : undefined;
  return {
    serverRttMs,
    openPeers: finiteMetric(value.openPeers, 20),
    openPlayerPeers: finiteMetric(value.openPlayerPeers, 20),
    knownPlayers: finiteMetric(value.knownPlayers, 20),
    meshReady: value.meshReady === true,
    failoverActive: value.failoverActive === true,
    serverAlive: value.serverAlive !== false,
    leaderId,
    stateVersion: finiteMetric(value.stateVersion, Number.MAX_SAFE_INTEGER),
    offlineAssetsReady: value.offlineAssetsReady === true,
  };
}

function monitorParticipant(meta: ClientMeta, now = Date.now()): MonitorParticipant | null {
  if (meta.role === 'unknown') return null;
  const lastSeenAt = meta.lastPingAt ?? meta.lastSeen ?? meta.connectedAt;
  const heartbeatAgeMs = Math.max(0, now - lastSeenAt);
  return {
    connectionId: meta.connectionId,
    role: meta.role,
    nick: meta.nick || meta.p2pNick || (meta.role === 'master' ? 'Master' : 'Jugador'),
    playerId: meta.playerId,
    p2pPeerId: meta.p2pPeerId,
    nodeId: NODE_ID,
    connectedAt: meta.connectedAt,
    lastSeenAt,
    heartbeatAgeMs,
    status: monitoring.statusForAge(heartbeatAgeMs),
    telemetry: meta.telemetry,
  };
}

function localMonitorParticipants(now = Date.now()): MonitorParticipant[] {
  const participants: MonitorParticipant[] = [];
  for (const meta of clients.values()) {
    const participant = monitorParticipant(meta, now);
    if (participant) participants.push(participant);
  }
  return participants;
}

// ── Eje 4 (capa navegador): anfitrión de la sala ─────────────────────────────
//
// El clúster ya elegía coordinador entre NODOS, pero el permiso para arrancar
// una partida seguía siendo un rol FIJO del navegador: solo /master. Si esa
// pantalla se cerraba —o caía el nodo donde vivía— el juego quedaba muerto en
// 'gameEnd' con los celulares conectados y nadie con permiso de continuar.
//
// Ahora el coordinador vigila cuántas pantallas maestras siguen vivas en todo
// el clúster (dato que ya viaja en los reportes del monitor distribuido). Si no
// queda ninguna, promueve a un jugador a ANFITRIÓN y difunde el rol; ese celular
// puede iniciar la siguiente partida. Cuando vuelve una /master, el anfitrión se
// retira solo. Mismo ciclo que el Matón entre nodos, un piso más arriba.
function mastersOnlineNow(now = Date.now()): number {
  return monitoring.mastersOnline(localMonitorParticipants(now), now);
}

function refreshHost(now = Date.now()): void {
  if (!cluster.isCoordinator) return;
  const masterOnline = mastersOnlineNow(now) > 0;
  game.setHost(masterOnline ? null : game.pickHostCandidate(), masterOnline);
}

/** ¿Este navegador puede arrancar o cortar una partida? */
function canControlGame(meta: ClientMeta): boolean {
  if (meta.role === 'master') return true;
  const hostId = game.getHostId();
  return !!hostId && meta.playerId === hostId;
}

// Id de conexión único por cliente (jugador o master) — incluye NODE_ID para
// evitar colisiones entre nodos; se usa para enrutar respuestas puntuales
// (N_SEND_TO) de vuelta a la conexión exacta que las pidió.
function genConnId(): string {
  return `${NODE_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

function send(ws: WebSocket, msg: S2C) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const enriched = msg.stateVersion == null
    ? { ...msg, stateVersion: replicaStore.index, lamport: msg.lamport ?? game.clock.value }
    : msg;
  ws.send(JSON.stringify(enriched));
}

function broadcastToLocalClients(msg: S2C) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendToLocalPlayer(playerId: string, msg: S2C): boolean {
  for (const [ws, meta] of clients) {
    if ((meta.playerId === playerId || meta.connectionId === playerId) && ws.readyState === WebSocket.OPEN) {
      send(ws, msg);
      return true;
    }
  }
  return false;
}

function validateForwardedAction(
  msg: { originNode: string; actionId?: string; stateVersion?: number },
  targetId: string,
): boolean {
  const received = msg.stateVersion == null ? null : Number(msg.stateVersion);
  const expected = replicaStore.index;
  const versionMatches = actionVersionIsAcceptable(received, expected);
  if (versionMatches && game.acceptAction(msg.actionId)) return true;

  cluster.sendToPeer(msg.originNode, {
    type: 'N_SEND_TO',
    playerId: targetId,
    payload: versionMatches
      ? { type: 'ERROR', message: 'La jugada duplicada ya habia sido procesada.' }
      : { type: 'STATE_STALE', expectedVersion: expected, receivedVersion: received ?? -1 },
    lamport: game.clock.tick(),
  });
  return false;
}

function p2pRoster(): P2PPeerDescriptor[] {
  const peers: P2PPeerDescriptor[] = [];
  for (const [ws, meta] of clients) {
    if (!meta.p2pPeerId || !meta.p2pRole || ws.readyState !== WebSocket.OPEN) continue;
    peers.push({
      peerId: meta.p2pPeerId,
      role: meta.p2pRole,
      playerId: meta.playerId,
      nick: meta.p2pNick,
    });
  }
  return peers.sort((a, b) => a.peerId.localeCompare(b.peerId));
}

function broadcastP2PRoster(): void {
  const peers = p2pRoster();
  for (const [ws, meta] of clients) {
    if (!meta.p2pPeerId || ws.readyState !== WebSocket.OPEN) continue;
    send(ws, { type: 'P2P_PEERS', selfId: meta.p2pPeerId, peers });
  }
}

function sendP2PRoster(ws: WebSocket, meta: ClientMeta): void {
  if (!meta.p2pPeerId || ws.readyState !== WebSocket.OPEN) return;
  send(ws, { type: 'P2P_PEERS', selfId: meta.p2pPeerId, peers: p2pRoster() });
}

let p2pSnapshotRevision = 0;

// Munición del motor P2P (Eje 4). Un lote de palabras extra que viaja con cada
// snapshot para que el líder de la malla pueda arrancar una partida NUEVA si
// este servidor desaparece: el banco de palabras vive aquí, no en el celular.
// Se genera UNA vez y se mantiene estable a propósito — si cambiara con cada
// envío, los celulares no terminarían nunca de precachear sus imágenes.
const P2P_SPARE_ROUNDS = 8;
let p2pSpareRounds: WordEntry[] = getRandomRounds(P2P_SPARE_ROUNDS);

function sendP2PSnapshot(ws: WebSocket): void {
  send(ws, {
    type: 'P2P_SNAPSHOT',
    revision: p2pSnapshotRevision,
    snapshot: game.snapshot(),
    spare: p2pSpareRounds,
  });
}

function broadcastP2PSnapshot(): void {
  p2pSnapshotRevision++;
  const payload: S2C = {
    type: 'P2P_SNAPSHOT',
    revision: p2pSnapshotRevision,
    snapshot: game.snapshot(),
    spare: p2pSpareRounds,
  };
  for (const [ws, meta] of clients) {
    if (meta.p2pPeerId && ws.readyState === WebSocket.OPEN) send(ws, payload);
  }
}

// Eje 4: empuja la salud del clúster a las pantallas maestras locales (sin polling).
function sendClusterState() {
  const { nodes, electionInProgress } = cluster.clusterState();
  const msg: S2C = { type: 'CLUSTER_STATE', nodes, electionInProgress };
  const data = JSON.stringify(msg);
  for (const [ws, meta] of clients) {
    if (meta.role === 'master' && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Eje 4: el anfitrión vigente para un navegador recién llegado. Un seguidor
// puede responderlo solo: `hostId` viaja replicado dentro del snapshot.
function sendHostState(ws: WebSocket): void {
  send(ws, game.hostState(mastersOnlineNow() > 0));
}

function monitorPayload(now = Date.now()): S2C {
  const clusterHealth = cluster.monitoringState(now);
  return {
    type: 'DISTRIBUTED_MONITOR',
    snapshot: monitoring.snapshot({
      localParticipants: localMonitorParticipants(now),
      clusterNodes: clusterHealth.nodes,
      coordinatorId: cluster.coordinatorId,
      electionInProgress: clusterHealth.electionInProgress,
      nodeTimeoutMs: clusterHealth.timeoutMs,
      now,
    }),
  };
}

/**
 * La pantalla maestra recibe el monitor siempre; un celular, solo mientras
 * tenga el panel ABIERTO (MONITOR_SUBSCRIBE). El snapshot lleva a todos los
 * participantes del clúster: empujárselo a veinte celulares que no lo están
 * mirando es gastar el Wi-Fi de la feria en nada. La suscripción —no la
 * cadencia— es lo que controla ese costo.
 */
function sendDistributedMonitor(now = Date.now(), includeSubscribers = false): void {
  const data = JSON.stringify(monitorPayload(now));
  for (const [ws, meta] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (meta.role === 'master' || (includeSubscribers && meta.monitorSubscribed)) ws.send(data);
  }
}

// ── Difusión del juego → clientes locales + peers (Eje 1 inter-nodo) ─────────

interface PendingReplicaCommit {
  acknowledgements: Set<string>;
  resolve: (index: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReplicaCandidate {
  leaderId: string;
  term: number;
  index: number;
  snapshot: GameSnapshot;
}

interface PendingStateSync { responses: ReplicaCandidate[]; }

const pendingReplicaCommits = new Map<string, PendingReplicaCommit>();
const pendingStateSync = new Map<string, PendingStateSync>();
let replicationQueue: Promise<void> = Promise.resolve();

function commitKey(term: number, index: number): string { return `${term}:${index}`; }

/** Persiste localmente y exige ACK durable de una mayoría antes de confirmar. */
async function commitSnapshot(snapshot: GameSnapshot): Promise<number> {
  if (!cluster.isCoordinator) throw new Error('El nodo ya no es coordinador');
  if (!cluster.hasQuorum) throw new Error(`Sin quorum (${cluster.quorumSize} replicas requeridas)`);

  const term = cluster.currentTerm;
  const index = replicaStore.index + 1;
  await replicaStore.commit({ leaderId: NODE_ID, term, index, snapshot });
  if (cluster.quorumSize === 1) return index;

  return new Promise<number>((resolve, reject) => {
    const key = commitKey(term, index);
    const pending: PendingReplicaCommit = {
      acknowledgements: new Set([NODE_ID]),
      resolve,
      reject,
      timer: setTimeout(() => {
        pendingReplicaCommits.delete(key);
        reject(new Error(`Replica ${index} no alcanzo quorum en ${REPLICA_COMMIT_TIMEOUT_MS} ms`));
      }, REPLICA_COMMIT_TIMEOUT_MS),
    };
    pendingReplicaCommits.set(key, pending);
    cluster.broadcastToPeers({
      type: 'N_REPLICATE', leaderId: NODE_ID, term, index, snapshot,
      lamport: game.clock.tick(),
    });
  });
}

function queueReplication(snapshot: GameSnapshot, afterCommit?: (index: number) => void): void {
  const work = async () => {
    try {
      const index = await commitSnapshot(snapshot);
      afterCommit?.(index);
    } catch (error) {
      console.error(`[${NODE_ID}] [QUORUM] Estado no confirmado:`, error);
      game.suspend();
    }
  };
  replicationQueue = replicationQueue.then(work, work);
}

function broadcastCommitted(msg: S2C, index: number): void {
  const versioned = { ...msg, stateVersion: index, lamport: game.clock.tick() } as S2C;
  broadcastToLocalClients(versioned);
  cluster.broadcastToPeers({
    type: 'N_BROADCAST', payload: versioned, lamport: game.clock.tick(),
  });
}

game.on('broadcast', (msg: S2C) => {
  if (!cluster.isCoordinator) return;
  if (msg.type === 'ENGINE_STATE' || msg.type === 'MUTEX_QUEUED') {
    broadcastCommitted(msg, replicaStore.index);
    return;
  }
  queueReplication(game.snapshot(), index => broadcastCommitted(msg, index));
});

// Cambios privados también quedan persistidos en las réplicas de backend.
game.on('state_changed', () => {
  if (cluster.isCoordinator) queueReplication(game.snapshot());
});

function hintPayload(playerId: string): S2C {
  const result = game.requestHint(playerId);
  return { type: 'HINT_RESULT', ...result };
}

function parseCustomAvatar(dataUrl: string): Buffer | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > 300_000) return null;
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const data = Buffer.from(match[1], 'base64');
  if (data.length < 4 || data.length > MAX_CUSTOM_AVATAR_BYTES) return null;
  // JPEG: SOI FF D8 y marcador posterior FF. No se aceptan SVG ni tipos activos.
  if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return null;
  return data;
}

// v2 + Eje 4: resuelve una identidad de JOIN en el coordinador.
//
// Primero intenta una RECONEXIÓN EN VIVO: si el token que trae el celular ya
// tiene un jugador desconectado en la partida en curso, lo retoma desde memoria
// (que se replica entre nodos vía N_REPLICATE) SIN tocar la base de datos. Esto
// Esto evita depender de la base durante una reconexión a mitad de ronda. Solo
// cuando no hay una partida en curso con ese token se consulta o crea la
// identidad persistente en la fuente compartida.
async function resolveJoin(playerId: string, nick: string, token: string | null, originNode: string, avatarId?: number) {
  // Un celular reintenta JOIN mientras termina la elección. Si el primer
  // intento ya creó esta sesión, responder con ella en lugar de reiniciar su
  // jugador o tocar nuevamente la base.
  const activeSession = game.getPlayer(playerId);
  if (activeSession?.token) {
    return {
      player: activeSession,
      token: activeSession.token,
      returning: true,
      reconnected: true,
      avatarId: activeSession.avatarId ?? 0,
      avatarKey: activeSession.avatarKey,
    };
  }
  if (token && game.wasConnected(token)) {
    const player = game.addPlayer(playerId, nick, token, originNode, avatarId);
    // La reconexión en vivo nunca espera a PostgreSQL. El jugador recupera su
    // puntaje desde la réplica y la identidad se sincroniza en segundo plano.
    void Promise.resolve(store.updateIdentity(token, nick, avatarId)).catch(error => {
      console.warn(`[${NODE_ID}] Identidad ${token} pendiente de sincronizar:`, error);
    });
    return { player, token, returning: true, reconnected: true, avatarId: player.avatarId ?? 0, avatarKey: player.avatarKey };
  }
  const id     = await store.findOrCreatePlayer(token, nick, avatarId);
  const player = game.addPlayer(playerId, id.nick, id.token, originNode, id.avatarId, id.avatarKey);
  return { player, token: id.token, returning: id.returning, reconnected: false, avatarId: id.avatarId, avatarKey: id.avatarKey };
}

const forwardedJoinsInFlight = new Set<string>();

// ── v2: persistencia al cerrar la partida (Paso 3) ───────────────────────────
// Game emite 'game_over' en el nodo que controla la partida. Solo el COORDINADOR
// escribe la historia (Eje 4: la persistencia depende de quién fue electo líder).
const pendingGameResults = new Map<string, GameOverResult>();
let persistenceRetryRunning = false;

async function persistGameResult(result: GameOverResult): Promise<void> {
  pendingGameResults.set(result.gameId, result);
  if (!cluster.isCoordinator || !persistenceLeader) return;
  try {
    const saved = await store.saveGameResult(result);
    pendingGameResults.delete(result.gameId);
    console.log(`[${NODE_ID}] [DB] "${saved.name}" persistida (partida ${saved.number}, ${saved.savedPlayers} jugadores)`);
  } catch (error) {
    console.error(`[${NODE_ID}] No se pudo persistir la partida ${result.gameId}; se reintentará:`, error);
  }
}

game.on('game_over', (result: GameOverResult) => void persistGameResult(result));

// Eje 4 — historial de lo jugado SIN servidor.
//
// El líder de la malla P2P sube aquí la partida que se jugó mientras el clúster
// estaba caído. No es estado vivo (eso lo manda el servidor sin negociar): es un
// hecho cerrado que solo falta escribir. Se deduplica por gameId porque el
// celular reintenta hasta que alguien le confirme, y porque cualquier peer de la
// malla podría subir el mismo resultado.
const persistedGameIds = new Set<string>();

function acceptOfflineResult(result: GameOverResult): void {
  if (!result?.gameId || persistedGameIds.has(result.gameId) || pendingGameResults.has(result.gameId)) return;
  if (!Array.isArray(result.standings) || result.standings.length === 0) return;
  persistedGameIds.add(result.gameId);
  console.log(`[${NODE_ID}] [DB] Partida jugada en malla P2P recibida (${result.gameId}), ${result.standings.length} jugadores`);
  void persistGameResult(result);
}

setInterval(async () => {
  if (!cluster.isCoordinator || !persistenceLeader || persistenceRetryRunning || pendingGameResults.size === 0) return;
  persistenceRetryRunning = true;
  try {
    for (const result of pendingGameResults.values()) await persistGameResult(result);
  } finally {
    persistenceRetryRunning = false;
  }
}, 3000);

const LEADER_CLAIM_ATTEMPTS = 8;
const LEADER_CLAIM_DELAY_MS = 1000;
let leadershipMaintenanceRunning = false;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensurePersistenceInitialized(): Promise<boolean> {
  if (persistenceInitialized) return true;
  try {
    await store.init();
    persistenceInitialized = true;
    console.log(`[${NODE_ID}] [OK] Persistencia ${store.mode} disponible`);
    return true;
  } catch (error) {
    persistenceInitialized = false;
    persistenceLeader = false;
    console.error(`[${NODE_ID}] Persistencia temporalmente no disponible; el juego seguirá sin historial:`, error);
    return false;
  }
}

async function withExclusiveLeadershipOperation<T>(work: () => Promise<T>): Promise<T> {
  while (leadershipMaintenanceRunning) await delay(25);
  leadershipMaintenanceRunning = true;
  try {
    return await work();
  } finally {
    leadershipMaintenanceRunning = false;
  }
}

async function acquirePersistenceLeadership(attempts = LEADER_CLAIM_ATTEMPTS): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!cluster.isCoordinator) {
      persistenceLeader = false;
      return false;
    }
    try {
      if (!await ensurePersistenceInitialized()) {
        if (attempt < attempts) await delay(LEADER_CLAIM_DELAY_MS);
        continue;
      }
      if (await store.claimLeadership()) {
        persistenceLeader = true;
        console.log(`[${NODE_ID}] [OK] Concesión de escritura ${store.mode} adquirida`);
        return true;
      }
    } catch (error) {
      persistenceLeader = false;
      console.error(`[${NODE_ID}] Error al solicitar la concesión de escritura:`, error);
    }
    if (attempt < attempts) await delay(LEADER_CLAIM_DELAY_MS);
  }
  return false;
}

async function synchronizeReplicaBeforeLeadership(): Promise<void> {
  const requestId = `${NODE_ID}-${cluster.currentTerm}-${Date.now()}`;
  const local = replicaStore.replica;
  const sync: PendingStateSync = {
    responses: local ? [{
      leaderId: local.leaderId,
      term: local.term,
      index: local.index,
      snapshot: local.snapshot,
    }] : [],
  };
  pendingStateSync.set(requestId, sync);
  cluster.broadcastToPeers({
    type: 'N_STATE_REQUEST', nodeId: NODE_ID, requestId, lamport: game.clock.tick(),
  });
  await delay(REPLICA_SYNC_WINDOW_MS);
  pendingStateSync.delete(requestId);

  const newest = sync.responses.sort((a, b) => b.term - a.term || b.index - a.index)[0];
  if (!newest) return;
  await replicaStore.commit({
    leaderId: NODE_ID,
    term: cluster.currentTerm,
    index: Math.max(1, newest.index),
    snapshot: newest.snapshot,
  });
  game.restore(newest.snapshot);
  console.log(`[${NODE_ID}] [REPLICA] Recuperada version ${newest.index} antes de asumir liderazgo`);
}

let coordinatorActivationInFlight = false;

async function activateCoordinator(): Promise<void> {
  if (coordinatorActivationInFlight) return;
  coordinatorActivationInFlight = true;
  try {
  console.log(`[${NODE_ID}] [COORDINATOR] Coordinador electo; recuperando réplica durable`);
  game.suspend();
  if (!cluster.hasQuorum) {
    console.warn(`[${NODE_ID}] Sin quorum: el nodo no ejecutará jugadas ni timers`);
    return;
  }
  await synchronizeReplicaBeforeLeadership();
  if (!cluster.isCoordinator || !cluster.hasQuorum) {
    console.log(`[${NODE_ID}] Activación cancelada: cambió el término o se perdió quorum`);
    return;
  }
  // Sella el estado recuperado con el término nuevo antes de reanudar timers.
  await commitSnapshot(game.snapshot());
  game.pruneToLivingNodes([NODE_ID, ...cluster.getConnectedPeers()]);
  game.resume();
  console.log(`[${NODE_ID}] [OK] Partida reanudada desde disco con quorum`);

  const acquired = await withExclusiveLeadershipOperation(() => acquirePersistenceLeadership());
  if (!acquired) {
    console.warn(`[${NODE_ID}] Sin concesión de escritura; la partida continúa y el resultado queda pendiente`);
  }
  } catch (error) {
    console.warn(`[${NODE_ID}] Activación de coordinador cancelada:`, error);
    game.suspend();
  } finally {
    coordinatorActivationInFlight = false;
  }
}

setInterval(async () => {
  if (!cluster.isCoordinator || leadershipMaintenanceRunning) return;
  try {
    await withExclusiveLeadershipOperation(async () => {
      const renewed = await store.renewLeadership();
      persistenceLeader = renewed;
      if (!renewed) {
        console.warn(`[${NODE_ID}] Se perdió la concesión de escritura; intentando recuperarla`);
        await acquirePersistenceLeadership(1);
      }
    });
  } catch (error) {
    persistenceLeader = false;
    console.error(`[${NODE_ID}] No se pudo renovar la concesión de escritura:`, error);
  }
}, 2000);

// ── Mensajes entre nodos ──────────────────────────────────────────────────────

cluster.on('peer_message', async (msg: N2N, fromPeerId: string) => {
  try {
  switch (msg.type) {

    // Seguidor recibe broadcast del coordinador → entregar a clientes locales
    case 'N_BROADCAST':
      broadcastToLocalClients(msg.payload);
      break;

    // El seguidor fuerza el snapshot a SU disco antes de responder. El líder
    // no lo mostrará a los celulares hasta reunir una mayoría de estos ACK.
    case 'N_REPLICATE': {
      if (msg.term !== cluster.currentTerm || msg.leaderId !== cluster.coordinatorId) return;
      await replicaStore.commit({
        leaderId: msg.leaderId,
        term: msg.term,
        index: msg.index,
        snapshot: msg.snapshot,
      });
      if (!cluster.isCoordinator) game.restore(msg.snapshot);
      cluster.sendToPeer(fromPeerId, {
        type: 'N_REPLICATE_ACK', nodeId: NODE_ID, term: msg.term,
        index: msg.index, lamport: game.clock.tick(),
      });
      break;
    }

    case 'N_REPLICATE_ACK': {
      if (!cluster.isCoordinator || msg.term !== cluster.currentTerm) return;
      const key = commitKey(msg.term, msg.index);
      const pending = pendingReplicaCommits.get(key);
      if (!pending) return;
      pending.acknowledgements.add(msg.nodeId);
      if (pending.acknowledgements.size >= cluster.quorumSize) {
        clearTimeout(pending.timer);
        pendingReplicaCommits.delete(key);
        pending.resolve(msg.index);
      }
      break;
    }

    case 'N_STATE_REQUEST': {
      const replica = replicaStore.replica;
      cluster.sendToPeer(fromPeerId, {
        type: 'N_STATE_RESPONSE', nodeId: NODE_ID, requestId: msg.requestId,
        leaderId: replica?.leaderId ?? '', term: replica?.term ?? 0,
        index: replica?.index ?? 0, snapshot: replica?.snapshot ?? null,
        lamport: game.clock.tick(),
      });
      break;
    }

    case 'N_STATE_RESPONSE': {
      const sync = pendingStateSync.get(msg.requestId);
      if (sync && msg.snapshot) {
        sync.responses.push({
          leaderId: msg.leaderId,
          term: msg.term,
          index: msg.index,
          snapshot: msg.snapshot,
        });
      }
      break;
    }

    // Cada nodo comparte la salud de sus navegadores locales. Cualquier nodo
    // puede agregarla y mostrársela a un master conectado a él.
    case 'N_MONITOR_REPORT':
      monitoring.acceptRemoteReport(msg.report, fromPeerId);
      sendDistributedMonitor();
      break;

    // Coordinador → seguidor: enviar a un jugador específico en ese nodo
    case 'N_SEND_TO':
      sendToLocalPlayer(msg.playerId, msg.payload);
      break;

    // Seguidor reenvía JOIN de un jugador al coordinador
    case 'N_FORWARD_JOIN': {
      if (!cluster.isCoordinator) return;
      if (forwardedJoinsInFlight.has(msg.playerId)) return;
      forwardedJoinsInFlight.add(msg.playerId);
      let resolved;
      try {
        resolved = await resolveJoin(msg.playerId, msg.nick, msg.token, msg.originNode, msg.avatarId);
      } finally {
        forwardedJoinsInFlight.delete(msg.playerId);
      }
      const { player, token: playerToken, returning, reconnected, avatarId, avatarKey } = resolved;
      // WELCOME → solo al jugador que se unió, en su nodo de origen
      cluster.sendToPeer(msg.originNode, {
        type:     'N_SEND_TO',
        playerId: msg.playerId,
        payload:  { type: 'WELCOME', playerId: player.id, nick: player.nick, playerCount: game.getPlayerCount(), token: playerToken, returning, score: player.score, reconnected, avatarId, avatarKey },
        lamport:  game.clock.tick(),
      });
      // Si hay ronda en curso, sincronizar estado al nuevo jugador
      const roundInfo = game.getCurrentRoundInfo();
      if (roundInfo) {
        cluster.sendToPeer(msg.originNode, {
          type:     'N_SEND_TO',
          playerId: msg.playerId,
          payload:  { type: 'ROUND_START', ...roundInfo },
          lamport:  game.clock.tick(),
        });
      }
      const stack = game.stackState();
      if (stack) {
        cluster.sendToPeer(msg.originNode, {
          type: 'N_SEND_TO',
          playerId: msg.playerId,
          payload: { type: 'STACK_STATE', state: stack },
          lamport: game.clock.tick(),
        });
      }
      break;
    }

    // Seguidor reenvía GUESS al coordinador (Eje 2: Lamport del cliente incluido)
    case 'N_FORWARD_GUESS': {
      if (!cluster.isCoordinator) return;
      if (!validateForwardedAction(msg, msg.playerId)) return;
      const result = await game.handleGuess(msg.playerId, msg.word, msg.lamport);
      // Solo respuestas negativas van de vuelta al jugador; las positivas se broadcast
      if (result === 'wrong' || result === 'already_solved') {
        cluster.sendToPeer(msg.originNode, {
          type:     'N_SEND_TO',
          playerId: msg.playerId,
          payload:  { type: result === 'wrong' ? 'WRONG_ANSWER' : 'ALREADY_SOLVED' },
          lamport:  game.clock.tick(),
        });
      }
      break;
    }

    case 'N_FORWARD_HINT': {
      if (!cluster.isCoordinator) return;
      if (!validateForwardedAction(msg, msg.playerId)) return;
      cluster.sendToPeer(msg.originNode, {
        type:     'N_SEND_TO',
        playerId: msg.playerId,
        payload:  hintPayload(msg.playerId),
        lamport:  game.clock.tick(),
      });
      break;
    }

    // Seguidor reenvía START_GAME del master
    case 'N_FORWARD_START':
      if (!cluster.isCoordinator) return;
      if (!validateForwardedAction(msg, msg.requesterId)) return;
      game.startGame(msg.totalRounds ?? 8, msg.mode ?? 'clasico');
      break;

    // Seguidor reenvía el END_GAME del master
    case 'N_FORWARD_END_GAME':
      if (!cluster.isCoordinator) return;
      if (!validateForwardedAction(msg, msg.requesterId)) return;
      game.clock.update(msg.lamport);
      game.endGameNow();
      break;

    case 'N_FORWARD_STACK_ACTION':
      if (!cluster.isCoordinator) return;
      if (!validateForwardedAction(msg, msg.playerId)) return;
      game.clock.update(msg.lamport);
      game.stackAction(msg.playerId, msg.action);
      break;
    // Seguidor reenvía el voto (categoría o dificultad) de su jugador al coordinador
    case 'N_FORWARD_VOTE':
      if (!cluster.isCoordinator) return;
      if (!validateForwardedAction(msg, msg.playerId)) return;
      game.castVote(msg.playerId, msg.kind, msg.option);
      break;

    case 'N_FORWARD_SET_NICK': {
      if (!cluster.isCoordinator) return;
      const player = game.getPlayer(msg.playerId);
      const nick = msg.nick.trim().slice(0, 20);
      if (!player || player.token !== msg.token || !nick) {
        cluster.sendToPeer(msg.originNode, {
          type: 'N_SEND_TO', playerId: msg.playerId,
          payload: { type: 'ERROR', message: 'No se pudo actualizar el nombre.' },
          lamport: game.clock.tick(),
        });
        return;
      }
      await store.updateIdentity(msg.token, nick);
      cluster.sendToPeer(msg.originNode, {
        type: 'N_SEND_TO', playerId: msg.playerId,
        payload: { type: 'IDENTITY_UPDATED', nick },
        lamport: game.clock.tick(),
      });
      game.setPlayerNick(msg.playerId, nick);
      break;
    }

    // Seguidor reenvía el cambio de avatar de su jugador al coordinador
    case 'N_FORWARD_SET_AVATAR':
      if (!cluster.isCoordinator) return;
      await store.setAvatar(msg.token, msg.avatarId);
      game.setPlayerAvatar(msg.playerId, msg.avatarId);
      cluster.sendToPeer(msg.originNode, {
        type: 'N_SEND_TO', playerId: msg.playerId,
        payload: { type: 'AVATAR_UPDATED', avatarId: msg.avatarId, avatarKey: null },
        lamport: game.clock.tick(),
      });
      break;

    case 'N_FORWARD_CUSTOM_AVATAR': {
      if (!cluster.isCoordinator) return;
      const data = parseCustomAvatar(msg.dataUrl);
      if (!data) {
        cluster.sendToPeer(msg.originNode, {
          type: 'N_SEND_TO', playerId: msg.playerId,
          payload: { type: 'ERROR', message: 'La foto no es válida o supera 200 KB.' },
          lamport: game.clock.tick(),
        });
        return;
      }
      const avatarKey = await store.setCustomAvatar(msg.token, 'image/jpeg', data);
      if (!avatarKey) throw new Error('La identidad del jugador no existe');
      game.setPlayerCustomAvatar(msg.playerId, avatarKey);
      cluster.sendToPeer(msg.originNode, {
        type: 'N_SEND_TO', playerId: msg.playerId,
        payload: { type: 'AVATAR_UPDATED', avatarId: game.getPlayer(msg.playerId)?.avatarId ?? 0, avatarKey },
        lamport: game.clock.tick(),
      });
      break;
    }

    // v2: seguidor pidió un perfil → el coordinador lo lee de su DB y lo devuelve
    case 'N_FORWARD_PROFILE': {
      if (!cluster.isCoordinator) return;
      cluster.sendToPeer(msg.originNode, {
        type:     'N_SEND_TO',
        playerId: msg.playerId,
        payload:  { type: 'PROFILE', profile: await store.getProfile(msg.token) },
        lamport:  game.clock.tick(),
      });
      break;
    }

    // v2.1: la pantalla maestra de un seguidor pidió el salón de la fama
    case 'N_FORWARD_HALL_OF_FAME': {
      if (!cluster.isCoordinator) return;
      const [top, recentGames] = await Promise.all([
        store.getHallOfFame(10),
        store.getRecentGames(6),
      ]);
      cluster.sendToPeer(msg.originNode, {
        type:     'N_SEND_TO',
        playerId: msg.requesterId,
        payload:  { type: 'HALL_OF_FAME', top, recentGames },
        lamport:  game.clock.tick(),
      });
      break;
    }

    // Un seguidor recibió del líder P2P una partida jugada sin servidor
    case 'N_FORWARD_OFFLINE_RESULT':
      if (!cluster.isCoordinator) return;
      acceptOfflineResult(msg.result);
      break;

    // Seguidor notifica que un jugador se desconectó
    case 'N_PLAYER_LEFT':
      if (!cluster.isCoordinator) return;
      game.removePlayer(msg.playerId);
      break;
  }
  } catch (error) {
    console.error(`[${NODE_ID}] Falló el mensaje ${msg.type} recibido de ${fromPeerId}:`, error);
  }
});

cluster.on('peer_connected',    (id: string) => console.log(`[${NODE_ID}] [OK] Peer listo: ${id}`));
cluster.on('peer_disconnected', (id: string) => console.log(`[${NODE_ID}] [DOWN] Peer caído: ${id}`));
cluster.on('peer_timeout',      (id: string) => console.log(`[${NODE_ID}] [WARN] Heartbeat perdido de ${id} (Eje 4)`));

cluster.on('quorum_changed', (available: boolean) => {
  console.log(`[${NODE_ID}] [QUORUM] ${available ? 'disponible' : 'perdido'} (${cluster.quorumSize} requeridos)`);
  if (!available) {
    game.suspend();
    for (const [key, pending] of pendingReplicaCommits) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Quorum perdido durante el commit'));
      pendingReplicaCommits.delete(key);
    }
  } else if (cluster.isCoordinator) {
    void activateCoordinator();
  }
  sendClusterState();
});
cluster.on('quorum_lost', () => game.suspend());

// Eje 4: cuando el coordinador (el que sea, ahora o tras un failover) pierde un
// nodo, cualquier jugador cuyo WebSocket vivía ahí queda "fantasma" (ver
// Player.originNode / Game.pruneToLivingNodes) -> hay que soltarlo para que su
// propia reconexión (mismo token, por cualquier nodo vivo) lo encuentre y le
// devuelva el puntaje, en vez de crearle un jugador duplicado desde cero.
cluster.on('peer_disconnected', () => {
  if (cluster.isCoordinator) game.pruneToLivingNodes([NODE_ID, ...cluster.getConnectedPeers()]);
});

// Eje 4: este nodo ganó la elección Bully → asume el control de la partida.
cluster.on('became_coordinator', () => void activateCoordinator());
cluster.on('coordinator_changed', (id: string) => {
  if (id !== NODE_ID) persistenceLeader = false;
  console.log(`[${NODE_ID}] Coordinador actual: ${id}`);
});

// Eje 4: cualquier cambio de topología o de coordinador se empuja al master.
// election_started avisa el arranque de una elección Bully (panel didáctico);
// coordinator_changed ya cubre el cierre (queda un coordinador nuevo).
cluster.on('peer_connected',     () => sendClusterState());
cluster.on('peer_disconnected',  () => sendClusterState());
cluster.on('election_started',   () => sendClusterState());
cluster.on('coordinator_changed', () => sendClusterState());

// Eje 2 + Eje 3: pulso periódico del motor distribuido para el panel
// didáctico de /master (reloj de Lamport + cola del candado). Solo lo emite
// el coordinador, que es quien tiene el estado autoritativo.
const ENGINE_STATE_INTERVAL_MS = 800;
setInterval(() => {
  if (cluster.isCoordinator) game.broadcastEngineState();
}, ENGINE_STATE_INTERVAL_MS);

// Observabilidad distribuida: cada nodo publica sus clientes locales y arma
// una vista global para cualquier /master, aunque esté conectado a un seguidor.
// Un celular con el panel abierto recibe la misma vista, al mismo ritmo.
setInterval(() => {
  const now = Date.now();
  // Eje 4: barrido periódico del anfitrión. Cubre lo que ningún evento local
  // avisa —el master vivía en un nodo que se cayó entero, o este nodo acaba de
  // ganar la elección Bully y hereda una sala sin mando.
  refreshHost(now);
  const report = monitoring.localReport(localMonitorParticipants(now), now);
  cluster.broadcastToPeers({
    type: 'N_MONITOR_REPORT',
    report,
    lamport: game.clock.value,
  });
  // Este es el único punto que alimenta a los celulares suscritos: los envíos
  // por reporte de peer van solo al master. Va al mismo pulso que el heartbeat
  // (1 s) porque a menos ritmo el snapshot envejece y el propio latido del
  // celular se pinta como "retrasado" siendo mentira.
  sendDistributedMonitor(now, true);
}, MONITOR_HEARTBEAT_INTERVAL_MS);

// ── Conexiones WebSocket de clientes ─────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, maxPayload: 512 * 1024 });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  // Las conexiones entre nodos se identifican por el header x-silunet-peer
  if (req.headers['x-silunet-peer']) {
    cluster.handleIncomingPeer(ws);
    return;
  }

  const connectedAt = Date.now();
  const initialMeta: ClientMeta = {
    connectionId: genConnId(),
    connectedAt,
    role: 'unknown',
    lastSeen: connectedAt,
  };
  clients.set(ws, initialMeta);
  armClientHeartbeat(ws, initialMeta);

  ws.on('message', async (raw) => {
    let msg: C2S;
    try { msg = JSON.parse(raw.toString()) as C2S; }
    catch { return; }

    const client = clients.get(ws)!;
    client.lastSeen = Date.now(); // Eje 4: cualquier mensaje (incl. PING) cuenta como latido
    armClientHeartbeat(ws, client);

    try {
    if (!validateClientState(ws, msg)) return;
    switch (msg.type) {

      case 'PING': {
        // Un corte fisico de Wi-Fi puede dejar el WebSocket del navegador en
        // OPEN durante minutos. El PONG permite que el cliente detecte ese
        // socket fantasma con un timeout corto y rote hacia otra replica.
        client.lastPingAt = Date.now();
        client.telemetry = sanitizeBrowserTelemetry(msg.telemetry);
        send(ws, {
          type: 'PONG',
          ts: Date.now(),
          clientTs: Number.isFinite(Number(msg.sentAt)) ? Number(msg.sentAt) : undefined,
        });
        // Tambien repara carreras de senalizacion: si un DataChannel inicial
        // fallo, el siguiente roster permite reconstruirlo sin recargar.
        sendP2PRoster(ws, client);
        break;
      }

      case 'JOIN': {
        if (client.joinInFlight) return;
        client.joinInFlight = true;
        try {
        const nick = (msg.nick ?? '').trim().slice(0, 20);
        if (!nick) { send(ws, { type: 'ERROR', message: 'Nick inválido' }); return; }
        client.nick = nick;

        const token    = msg.token ?? null; // v2: identidad persistente del celular
        const existingSession = client.playerId ? game.getPlayer(client.playerId) : undefined;
        const reconnecting = !!(token && game.wasConnected(token));
        if (!existingSession && !reconnecting && game.getPlayerCount() >= MAX_PLAYERS) {
          send(ws, { type: 'ERROR', message: `Sala llena: máximo ${MAX_PLAYERS} jugadores para mantener una partida estable.` });
          return;
        }
        const playerId = client.playerId ?? genConnId();
        client.playerId = playerId;
        client.role     = 'player';

        if (cluster.isCoordinator) {
          const { player, token: playerToken, returning, reconnected, avatarId, avatarKey } = await resolveJoin(playerId, nick, token, NODE_ID, msg.avatarId);
          send(ws, { type: 'WELCOME', playerId, nick: player.nick, playerCount: game.getPlayerCount(), token: playerToken, returning, score: player.score, reconnected, avatarId, avatarKey });
          const roundInfo = game.getCurrentRoundInfo();
          if (roundInfo) send(ws, { type: 'ROUND_START', ...roundInfo });
          const stack = game.stackState();
          if (stack) send(ws, { type: 'STACK_STATE', state: stack });
          // Eje 4: entró un candidato a anfitrión. Si la sala estaba sin
          // pantalla maestra y sin nadie al mando, este celular puede serlo.
          refreshHost();
        } else {
          // Seguidor: reenviar al coordinador (incluido el token); la respuesta llega como N_SEND_TO
          cluster.sendToCoordinator({
            type:       'N_FORWARD_JOIN',
            playerId,
            nick,
            token,
            avatarId:   msg.avatarId,
            originNode: NODE_ID,
            lamport:    game.clock.tick(),
          });
        }
        } finally {
          client.joinInFlight = false;
        }
        // Eje 4: quién manda ahora mismo en la sala. Va después del WELCOME
        // para que el celular ya conozca su propio playerId al recibirlo.
        sendHostState(ws);
        break;
      }

      case 'SET_NICK': {
        if (!client.playerId || client.role !== 'player' || !msg.token) return;
        const nick = msg.nick.trim().slice(0, 20);
        if (!nick) { send(ws, { type: 'ERROR', message: 'Escribe un nombre válido.' }); break; }
        client.nick = nick;
        client.p2pNick = nick;
        if (cluster.isCoordinator) {
          const player = game.getPlayer(client.playerId);
          if (!player || player.token !== msg.token) {
            send(ws, { type: 'ERROR', message: 'No se pudo verificar tu identidad.' });
            break;
          }
          await store.updateIdentity(msg.token, nick);
          send(ws, { type: 'IDENTITY_UPDATED', nick });
          game.setPlayerNick(client.playerId, nick);
        } else {
          cluster.sendToCoordinator({
            type: 'N_FORWARD_SET_NICK',
            playerId: client.playerId,
            token: msg.token,
            nick,
            originNode: NODE_ID,
            lamport: game.clock.tick(),
          });
        }
        break;
      }

      // Cambio de avatar desde el modal de perfil. La DB la tiene el coordinador
      // (misma regla que GET_PROFILE), pero el estado en vivo también hay que
      // actualizarlo para que el ranking lo refleje al instante.
      case 'SET_AVATAR': {
        if (!client.playerId || client.role !== 'player') return;
        const clean = normalizeAvatarId(msg.avatarId);
        if (clean === null || !msg.token) return;
        if (cluster.isCoordinator) {
          await store.setAvatar(msg.token, clean);
          game.setPlayerAvatar(client.playerId, clean);
          send(ws, { type: 'AVATAR_UPDATED', avatarId: clean, avatarKey: null });
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_SET_AVATAR',
            playerId:   client.playerId,
            token:      msg.token,
            avatarId:   clean,
            originNode: NODE_ID,
            lamport:    game.clock.tick(),
          });
        }
        break;
      }

      case 'SET_CUSTOM_AVATAR': {
        if (!client.playerId || client.role !== 'player' || !msg.token) return;
        if (cluster.isCoordinator) {
          const data = parseCustomAvatar(msg.dataUrl);
          if (!data) {
            send(ws, { type: 'ERROR', message: 'La foto no es válida o supera 200 KB.' });
            return;
          }
          const avatarKey = await store.setCustomAvatar(msg.token, 'image/jpeg', data);
          if (!avatarKey) throw new Error('La identidad del jugador no existe');
          game.setPlayerCustomAvatar(client.playerId, avatarKey);
          send(ws, { type: 'AVATAR_UPDATED', avatarId: game.getPlayer(client.playerId)?.avatarId ?? 0, avatarKey });
        } else {
          cluster.sendToCoordinator({
            type: 'N_FORWARD_CUSTOM_AVATAR',
            playerId: client.playerId,
            token: msg.token,
            dataUrl: msg.dataUrl,
            originNode: NODE_ID,
            lamport: game.clock.tick(),
          });
        }
        break;
      }

      case 'MASTER_JOIN': {
        client.role     = 'master';
        client.nick     = 'Master';
        client.playerId = genConnId(); // v2.1: para poder enrutarle el HALL_OF_FAME si es seguidor
        sendClusterState(); // Eje 4: salud del clúster al instante
        sendDistributedMonitor();
        // Eje 4: volvió una pantalla maestra -> el anfitrión de emergencia se
        // retira (refreshHost lo pone en null y lo difunde).
        refreshHost();
        sendHostState(ws);
        if (cluster.isCoordinator) {
          send(ws, { type: 'PLAYER_COUNT', count: game.getPlayerCount() });
          if (game.getPhase() !== 'waiting') {
            send(ws, { type: 'RANKING', entries: game.getRanking(), final: false });
          }
          // Un master que llega (o recarga) a mitad de partida debe ver la ronda
          // en curso, no la pantalla de espera: se le manda el estado actual.
          const roundInfo = game.getCurrentRoundInfo();
          if (roundInfo) send(ws, { type: 'ROUND_START', ...roundInfo });
          const reloj = game.sharedClockState();
          if (reloj) send(ws, { type: 'SHARED_CLOCK', ...reloj });
          const stack = game.stackState();
          if (stack) send(ws, { type: 'STACK_STATE', state: stack });
        }
        // En seguidor, el master recibirá actualizaciones vía los próximos N_BROADCAST
        break;
      }

      case 'P2P_REGISTER': {
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(msg.peerId)) return;
        if (msg.role === 'player' && (!client.playerId || client.role !== 'player')) return;
        if (msg.role === 'master' && client.role !== 'master') return;
        const duplicate = [...clients.entries()].find(([otherWs, meta]) =>
          otherWs !== ws && meta.p2pPeerId === msg.peerId && otherWs.readyState === WebSocket.OPEN
        );
        if (duplicate) {
          send(ws, { type: 'ERROR', message: 'Identidad P2P duplicada. Recarga la página.' });
          return;
        }
        client.p2pPeerId = msg.peerId;
        client.p2pRole = msg.role;
        client.p2pNick = msg.nick?.trim().slice(0, 20);
        if (client.p2pNick) client.nick = client.p2pNick;
        broadcastP2PRoster();
        sendP2PSnapshot(ws);
        break;
      }

      case 'P2P_SIGNAL': {
        if (!client.p2pPeerId) return;
        for (const [targetWs, targetMeta] of clients) {
          if (targetMeta.p2pPeerId !== msg.target) continue;
          send(targetWs, { type: 'P2P_SIGNAL', source: client.p2pPeerId, data: msg.data });
          break;
        }
        break;
      }

      case 'GUESS': {
        if (!client.playerId) return;
        if (cluster.isCoordinator) {
          const result = await game.handleGuess(client.playerId, msg.word ?? '', msg.lamport ?? 0);
          if (result === 'already_solved') send(ws, { type: 'ALREADY_SOLVED' });
          else if (result === 'wrong')     send(ws, { type: 'WRONG_ANSWER' });
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_GUESS',
            playerId:   client.playerId,
            word:       msg.word ?? '',
            originNode: NODE_ID,
            actionId:   msg.actionId,
            stateVersion: msg.stateVersion,
            lamport:    msg.lamport ?? game.clock.tick(),
          });
        }
        break;
      }

      case 'STACK_ACTION': {
        if (client.role === 'player' && client.playerId) {
          if (cluster.isCoordinator) {
            game.stackAction(client.playerId, msg.action);
          } else {
            cluster.sendToCoordinator({
              type: 'N_FORWARD_STACK_ACTION',
              playerId: client.playerId,
              action: msg.action,
              originNode: NODE_ID,
              actionId: msg.actionId,
              stateVersion: msg.stateVersion,
              lamport: msg.lamport ?? game.clock.tick(),
            });
          }
        }
        // /master es SOLO LECTURA (CLAUDE.md): no pilota. Antes reenviaba la
        // acción con la identidad del piloto, así que cualquiera que abriera
        // /master —que no pide autenticación— movía la pieza del jugador y
        // ambas entradas competían.
        break;
      }
      case 'REQUEST_HINT': {
        if (!client.playerId || client.role !== 'player') return;
        if (cluster.isCoordinator) {
          send(ws, hintPayload(client.playerId));
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_HINT',
            playerId:   client.playerId,
            originNode: NODE_ID,
            actionId:   msg.actionId,
            stateVersion: msg.stateVersion,
            lamport:    msg.lamport ?? game.clock.tick(),
          });
        }
        break;
      }

      case 'START_GAME': {
        // Eje 4: la pantalla maestra siempre; un jugador, solo mientras sea el
        // anfitrión electo (es decir, cuando no queda ninguna /master viva).
        if (!canControlGame(client)) return;
        if (cluster.isCoordinator) {
          game.startGame(msg.totalRounds ?? 8, msg.mode ?? 'clasico');
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_START',
            totalRounds: msg.totalRounds ?? 8,
            mode:       msg.mode ?? 'clasico',
            requesterId: client.connectionId,
            originNode: NODE_ID,
            actionId:   msg.actionId,
            stateVersion: msg.stateVersion,
            lamport:    msg.lamport ?? game.clock.tick(),
          });
        }
        break;
      }

      // El master corta la partida antes de tiempo. Mismo camino que START_GAME:
      // si este nodo no es el coordinador, se reenvía y decide allá.
      case 'END_GAME': {
        if (!canControlGame(client)) return;
        if (cluster.isCoordinator) {
          game.endGameNow();
        } else {
          cluster.sendToCoordinator({
            type:    'N_FORWARD_END_GAME',
            requesterId: client.connectionId,
            originNode: NODE_ID,
            actionId: msg.actionId,
            stateVersion: msg.stateVersion,
            lamport: msg.lamport ?? game.clock.tick(),
          });
        }
        break;
      }

      // Votación de categoría/dificultad: un voto de cada por jugador, se puede
      // cambiar mientras dure la ventana. No necesita respuesta puntual: el
      // conteo actualizado llega a todos por broadcast.
      case 'CAST_VOTE': {
        if (!client.playerId || client.role !== 'player') return;
        const kind = msg.kind === 'difficulty' ? 'difficulty' : 'category';
        if (cluster.isCoordinator) {
          game.castVote(client.playerId, kind, msg.option ?? '');
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_VOTE',
            playerId:   client.playerId,
            kind,
            option:     msg.option ?? '',
            originNode: NODE_ID,
            actionId:   msg.actionId,
            stateVersion: msg.stateVersion,
            lamport:    msg.lamport ?? game.clock.tick(),
          });
        }
        break;
      }

      // v2: el celular pide su perfil. La DB la tiene el coordinador; el seguidor
      // reenvía y la respuesta vuelve por N_SEND_TO. Es una lectura puntual: NUNCA
      // ocurre dentro del flujo de un GUESS (la partida en vivo no toca la DB).
      case 'GET_PROFILE': {
        const token = msg.token;
        if (!token) { send(ws, { type: 'PROFILE', profile: null }); break; }
        if (cluster.isCoordinator) {
          send(ws, { type: 'PROFILE', profile: await store.getProfile(token) });
        } else if (client.playerId) {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_PROFILE',
            playerId:   client.playerId,
            token,
            originNode: NODE_ID,
            lamport:    game.clock.tick(),
          });
        }
        break;
      }

      // v2.1: la pantalla maestra pide el salón de la fama (histórico de TODAS
      // las Casa Abierta jugadas). Misma mecánica que GET_PROFILE: lectura
      // puntual, solo la DB del coordinador es la fuente de verdad.
      // El celular abrió o cerró el monitor distribuido. Al abrirlo se le
      // responde al instante para que no vea el panel vacío hasta el próximo
      // pulso; al cerrarlo deja de recibir snapshots.
      // Solo el coordinador escribe la historia; un seguidor reenvía.
      case 'OFFLINE_RESULT': {
        if (client.role !== 'player') return;
        if (cluster.isCoordinator) {
          acceptOfflineResult(msg.result);
        } else {
          cluster.sendToCoordinator({
            type:    'N_FORWARD_OFFLINE_RESULT',
            result:  msg.result,
            lamport: game.clock.tick(),
          });
        }
        break;
      }

      case 'MONITOR_SUBSCRIBE': {
        if (client.role === 'unknown') return;
        client.monitorSubscribed = msg.active === true;
        if (client.monitorSubscribed) send(ws, monitorPayload());
        break;
      }

      case 'GET_HALL_OF_FAME': {
        if (cluster.isCoordinator) {
          const [top, recentGames] = await Promise.all([
            store.getHallOfFame(10),
            store.getRecentGames(6),
          ]);
          send(ws, { type: 'HALL_OF_FAME', top, recentGames });
        } else if (client.playerId) {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_HALL_OF_FAME',
            requesterId: client.playerId,
            originNode: NODE_ID,
            lamport:    game.clock.tick(),
          });
        }
        break;
      }
    }
    } catch (error) {
      console.error(`[${NODE_ID}] Falló el mensaje ${msg.type} del cliente:`, error);
      send(ws, { type: 'ERROR', message: 'No se pudo completar la operación. Intenta nuevamente.' });
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.heartbeatDeadline) clearTimeout(client.heartbeatDeadline);
    const disconnected = client ? monitorParticipant(client) : null;
    if (disconnected) monitoring.rememberDisconnected(disconnected);
    // role==='player': masters también tienen playerId (v2.1, para enrutar
    // HALL_OF_FAME) pero nunca se registraron en game.players -> nada que soltar.
    if (client?.role === 'player' && client.playerId) {
      if (cluster.isCoordinator) {
        game.removePlayer(client.playerId);
      } else {
        cluster.sendToCoordinator({
          type:     'N_PLAYER_LEFT',
          playerId: client.playerId,
          lamport:  game.clock.tick(),
        });
      }
    }
    const hadP2PIdentity = !!client?.p2pPeerId;
    clients.delete(ws);
    if (hadP2PIdentity) broadcastP2PRoster();
    // Eje 4: se fue el anfitrión, o se fue la última pantalla maestra. En
    // ambos casos hay que reelegir para que la sala no quede sin mando.
    // (Si la baja fue de un master remoto, el barrido periódico lo cubre.)
    refreshHost();
  });
});

// ── Arranque ──────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const initialized = await ensurePersistenceInitialized();
  if (cluster.isCoordinator && initialized) {
    const acquired = await withExclusiveLeadershipOperation(() => acquirePersistenceLeadership());
    if (!acquired) {
      console.warn(`[${NODE_ID}] El coordinador inicial arrancará sin persistencia; se recuperará automáticamente`);
    }
  } else if (cluster.isCoordinator) {
    console.warn(`[${NODE_ID}] El coordinador inicial arrancará sin PostgreSQL; el juego permanece disponible`);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    const ip   = getLocalIP();
    const role = cluster.isCoordinator ? 'COORDINADOR' : 'SEGUIDOR';
    console.log(`\n[${NODE_ID}] ══════════════════════════════════════`);
    console.log(`[${NODE_ID}]  ${role} | Puerto ${PORT} | DB ${store.mode.toUpperCase()}`);
    if (PEER_URLS.length > 0) console.log(`[${NODE_ID}]  Peers: ${PEER_URLS.join(', ')}`);
    console.log(`[${NODE_ID}]  Pantalla maestra: http://localhost:${PORT}/master`);
    console.log(`[${NODE_ID}]  URL celulares:    http://${ip}:${PORT}/join`);
    console.log(`[${NODE_ID}] ══════════════════════════════════════\n`);
  });

  setTimeout(() => cluster.connectToPeers(), 500);
}

void bootstrap().catch(async error => {
  console.error(`[${NODE_ID}] No se pudo iniciar SiluNet:`, error);
  await Promise.resolve(store.close()).catch(() => undefined);
  process.exit(1);
});
