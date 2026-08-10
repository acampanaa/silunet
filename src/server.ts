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
import { S2C, C2S, N2N, GameOverResult } from './types';

// ── Configuración por instancia ───────────────────────────────────────────────
const NODE_ID        = process.env.NODE_ID        ?? 'node1';
const PORT           = parseInt(process.env.PORT  ?? '3001', 10);
const COORDINATOR_ID = process.env.COORDINATOR_ID ?? 'node1';
const PEER_URLS      = (process.env.PEERS ?? '').split(',').filter(Boolean);

// El Game corre en todos los nodos pero solo el coordinador lo controla.
// El reloj Lamport es compartido entre game y cluster (mismo objeto).
const game    = new Game();
const cluster = new Cluster(NODE_ID, COORDINATOR_ID, game.clock, PEER_URLS);

// Persistencia de identidad e historia. En despliegue, todos los nodos apuntan
// a la misma instancia PostgreSQL; SQLite solo conserva el flujo de desarrollo.
// El coordinador resuelve identidad y escribe. La partida en vivo nunca lee aquí.
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOW_SQLITE_CLUSTER = process.env.ALLOW_SQLITE_CLUSTER === '1';
const store: PersistenceStore = DATABASE_URL
  ? new PostgresStore(DATABASE_URL, NODE_ID)
  : new Store(path.join(__dirname, '..', 'data', `silunet-${NODE_ID}.db`));

if (!DATABASE_URL && PEER_URLS.length > 0 && ALLOW_SQLITE_CLUSTER) {
  console.warn(`[${NODE_ID}] [WARN] DATABASE_URL ausente: SQLite es solo para desarrollo; el historial NO será consistente entre nodos.`);
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
  const self      = `http://${getLocalIP()}:${PORT}`;
  const siblings  = PEER_URLS.map(u => u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
  return [self, ...siblings];
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

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
      joinUrl:       `http://${getLocalIP()}:${PORT}/join`,
      nodeId:        NODE_ID,
      isCoordinator: cluster.isCoordinator,
      coordinator:   cluster.coordinatorId,
      connectedPeers: cluster.getConnectedPeers(),
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
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  });
});

// ── WebSocket helpers ─────────────────────────────────────────────────────────

interface ClientMeta {
  playerId?: string;
  role: 'player' | 'master' | 'unknown';
  lastSeen?: number; // Eje 4: último heartbeat recibido de este cliente
}

const clients = new Map<WebSocket, ClientMeta>();

// Id de conexión único por cliente (jugador o master) — incluye NODE_ID para
// evitar colisiones entre nodos; se usa para enrutar respuestas puntuales
// (N_SEND_TO) de vuelta a la conexión exacta que las pidió.
function genConnId(): string {
  return `${NODE_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

function send(ws: WebSocket, msg: S2C) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastToLocalClients(msg: S2C) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendToLocalPlayer(playerId: string, msg: S2C): boolean {
  for (const [ws, meta] of clients) {
    if (meta.playerId === playerId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
  }
  return false;
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

// ── Difusión del juego → clientes locales + peers (Eje 1 inter-nodo) ─────────

game.on('broadcast', (msg: S2C) => {
  broadcastToLocalClients(msg);
  if (cluster.isCoordinator) {
    // Coordinador reenvía el broadcast a todos los nodos seguidores
    cluster.broadcastToPeers({
      type:    'N_BROADCAST',
      payload: msg,
      lamport: game.clock.tick(),
    });
    // Eje 3: replica el estado autoritativo completo para que cada seguidor
    // mantenga una réplica pasiva (base del failover del Paso C / Bully).
    cluster.broadcastToPeers({
      type:     'N_REPLICATE',
      snapshot: game.snapshot(),
      lamport:  game.clock.tick(),
    });
  }
});

// Los cambios privados (como usar una pista) no se difunden a todos los
// celulares, pero sí se replican para sobrevivir a un cambio de coordinador.
game.on('state_changed', () => {
  if (!cluster.isCoordinator) return;
  cluster.broadcastToPeers({
    type:     'N_REPLICATE',
    snapshot: game.snapshot(),
    lamport:  game.clock.tick(),
  });
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
  if (token && game.wasConnected(token)) {
    // La partida en vivo se retoma desde memoria (arriba), pero el nick/avatar
    // que trae el celular sí hay que persistirlos: si no, el perfil seguiría
    // mostrando los anteriores y no coincidiría con lo que se ve en el ranking.
    // No-op si la identidad todavía no existe (compatibilidad con clientes viejos).
    await store.updateIdentity(token, nick, avatarId);
    const player = game.addPlayer(playerId, nick, token, originNode, avatarId);
    return { player, token, returning: true, reconnected: true, avatarId: player.avatarId ?? 0, avatarKey: player.avatarKey };
  }
  const id     = await store.findOrCreatePlayer(token, nick, avatarId);
  const player = game.addPlayer(playerId, id.nick, id.token, originNode, id.avatarId, id.avatarKey);
  return { player, token: id.token, returning: id.returning, reconnected: false, avatarId: id.avatarId, avatarKey: id.avatarKey };
}

// ── v2: persistencia al cerrar la partida (Paso 3) ───────────────────────────
// Game emite 'game_over' en el nodo que controla la partida. Solo el COORDINADOR
// escribe la historia (Eje 4: la persistencia depende de quién fue electo líder).
const pendingGameResults = new Map<string, GameOverResult>();
let persistenceRetryRunning = false;

async function persistGameResult(result: GameOverResult): Promise<void> {
  pendingGameResults.set(result.gameId, result);
  if (!cluster.isCoordinator) return;
  try {
    const saved = await store.saveGameResult(result);
    pendingGameResults.delete(result.gameId);
    console.log(`[${NODE_ID}] [DB] "${saved.name}" persistida (partida ${saved.number}, ${saved.savedPlayers} jugadores)`);
  } catch (error) {
    console.error(`[${NODE_ID}] No se pudo persistir la partida ${result.gameId}; se reintentará:`, error);
  }
}

game.on('game_over', (result: GameOverResult) => void persistGameResult(result));

setInterval(async () => {
  if (!cluster.isCoordinator || persistenceRetryRunning || pendingGameResults.size === 0) return;
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
    if (!cluster.isCoordinator) return false;
    try {
      if (await store.claimLeadership()) {
        console.log(`[${NODE_ID}] [OK] Concesión de escritura ${store.mode} adquirida`);
        return true;
      }
    } catch (error) {
      console.error(`[${NODE_ID}] Error al solicitar la concesión de escritura:`, error);
    }
    if (attempt < attempts) await delay(LEADER_CLAIM_DELAY_MS);
  }
  return false;
}

async function activateCoordinator(): Promise<void> {
  console.log(`[${NODE_ID}] [COORDINATOR] Coordinador electo; validando la concesión de persistencia`);
  const acquired = await withExclusiveLeadershipOperation(() => acquirePersistenceLeadership());
  if (!acquired) {
    console.error(`[${NODE_ID}] No se obtuvo la concesión de escritura; la partida no se reanudará todavía`);
    return;
  }
  game.pruneToLivingNodes([NODE_ID, ...cluster.getConnectedPeers()]);
  game.resume();
}

setInterval(async () => {
  if (!cluster.isCoordinator || leadershipMaintenanceRunning) return;
  try {
    await withExclusiveLeadershipOperation(async () => {
      const renewed = await store.renewLeadership();
      if (!renewed) {
        console.warn(`[${NODE_ID}] Se perdió la concesión de escritura; intentando recuperarla`);
        await acquirePersistenceLeadership(1);
      }
    });
  } catch (error) {
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

    // Seguidor recibe el estado autoritativo → actualizar su réplica pasiva (Eje 3)
    case 'N_REPLICATE':
      if (!cluster.isCoordinator) game.restore(msg.snapshot);
      break;

    // Coordinador → seguidor: enviar a un jugador específico en ese nodo
    case 'N_SEND_TO':
      sendToLocalPlayer(msg.playerId, msg.payload);
      break;

    // Seguidor reenvía JOIN de un jugador al coordinador
    case 'N_FORWARD_JOIN': {
      if (!cluster.isCoordinator) return;
      const { player, token: playerToken, returning, reconnected, avatarId, avatarKey } = await resolveJoin(msg.playerId, msg.nick, msg.token, msg.originNode, msg.avatarId);
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
      game.startGame(msg.totalRounds ?? 8, msg.mode ?? 'clasico');
      break;

    case 'N_FORWARD_STACK_ACTION':
      if (!cluster.isCoordinator) return;
      game.clock.update(msg.lamport);
      game.stackAction(msg.playerId, msg.action);
      break;
    // Seguidor reenvía el voto (categoría o dificultad) de su jugador al coordinador
    case 'N_FORWARD_VOTE':
      if (!cluster.isCoordinator) return;
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
cluster.on('coordinator_changed', (id: string) => console.log(`[${NODE_ID}] Coordinador actual: ${id}`));

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

// ── Conexiones WebSocket de clientes ─────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, maxPayload: 512 * 1024 });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  // Las conexiones entre nodos se identifican por el header x-silunet-peer
  if (req.headers['x-silunet-peer']) {
    cluster.handleIncomingPeer(ws);
    return;
  }

  clients.set(ws, { role: 'unknown', lastSeen: Date.now() });

  ws.on('message', async (raw) => {
    let msg: C2S;
    try { msg = JSON.parse(raw.toString()) as C2S; }
    catch { return; }

    const client = clients.get(ws)!;
    client.lastSeen = Date.now(); // Eje 4: cualquier mensaje (incl. PING) cuenta como latido

    try {
    switch (msg.type) {

      case 'JOIN': {
        const nick = (msg.nick ?? '').trim().slice(0, 20);
        if (!nick) { send(ws, { type: 'ERROR', message: 'Nick inválido' }); return; }

        const playerId = genConnId();
        const token    = msg.token ?? null; // v2: identidad persistente del celular
        client.playerId = playerId;
        client.role     = 'player';

        if (cluster.isCoordinator) {
          const { player, token: playerToken, returning, reconnected, avatarId, avatarKey } = await resolveJoin(playerId, nick, token, NODE_ID, msg.avatarId);
          send(ws, { type: 'WELCOME', playerId, nick: player.nick, playerCount: game.getPlayerCount(), token: playerToken, returning, score: player.score, reconnected, avatarId, avatarKey });
          const roundInfo = game.getCurrentRoundInfo();
          if (roundInfo) send(ws, { type: 'ROUND_START', ...roundInfo });
          const stack = game.stackState();
          if (stack) send(ws, { type: 'STACK_STATE', state: stack });
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
        break;
      }

      case 'SET_NICK': {
        if (!client.playerId || client.role !== 'player' || !msg.token) return;
        const nick = msg.nick.trim().slice(0, 20);
        if (!nick) { send(ws, { type: 'ERROR', message: 'Escribe un nombre válido.' }); break; }
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
        client.playerId = genConnId(); // v2.1: para poder enrutarle el HALL_OF_FAME si es seguidor
        sendClusterState(); // Eje 4: salud del clúster al instante
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
              lamport: game.clock.tick(),
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
            lamport:    game.clock.tick(),
          });
        }
        break;
      }

      case 'START_GAME': {
        if (client.role !== 'master') return;
        if (cluster.isCoordinator) {
          game.startGame(msg.totalRounds ?? 8, msg.mode ?? 'clasico');
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_START',
            totalRounds: msg.totalRounds ?? 8,
            mode:       msg.mode ?? 'clasico',
            lamport:    game.clock.tick(),
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
            lamport:    game.clock.tick(),
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
    clients.delete(ws);
  });
});

// ── Arranque ──────────────────────────────────────────────────────────────────

// Eje 4 (clientes): cada celular late cada 1s; si un cliente-jugador deja de
// latir por más de 2s (pantalla apagada / Wi-Fi caído sin cerrar el socket),
// se le da de baja del pool, igual que un cierre de conexión.
const CLIENT_TIMEOUT_MS = 2000;
setInterval(() => {
  const now = Date.now();
  for (const [ws, meta] of clients) {
    if (meta.role === 'player' && meta.lastSeen && now - meta.lastSeen > CLIENT_TIMEOUT_MS) {
      console.log(`[${NODE_ID}] [WARN] Cliente ${meta.playerId} sin latido (${now - meta.lastSeen}ms) -> baja`);
      ws.terminate(); // dispara 'close' -> removePlayer / N_PLAYER_LEFT + PLAYER_LEFT
    }
  }
}, 500);

async function bootstrap(): Promise<void> {
  if (!DATABASE_URL && PEER_URLS.length > 0 && !ALLOW_SQLITE_CLUSTER) {
    throw new Error('Un clúster requiere DATABASE_URL compartida. ALLOW_SQLITE_CLUSTER=1 se reserva para V&V local.');
  }
  await store.init();
  const acquired = !cluster.isCoordinator
    || await withExclusiveLeadershipOperation(() => acquirePersistenceLeadership());
  if (!acquired) {
    throw new Error('El coordinador inicial no pudo adquirir la concesión de persistencia');
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
