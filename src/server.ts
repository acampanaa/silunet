import http              from 'http';
import fs                from 'fs';
import path              from 'path';
import os                from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Game }          from './game';
import { Cluster }       from './cluster';
import { Store }         from './db';
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

// v2: persistencia de identidad e historia. Cada nodo abre su propio archivo
// (para que un seguidor promovido por Bully tenga un Store listo), pero SOLO el
// coordinador resuelve identidad y escribe. La partida en vivo nunca lee de aquí.
const store = new Store(path.join(__dirname, '..', 'data', `silunet-${NODE_ID}.db`));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
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

// ── HTTP ──────────────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  let urlPath = (req.url ?? '/').split('?')[0];

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
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket helpers ─────────────────────────────────────────────────────────

interface ClientMeta {
  playerId?: string;
  role: 'player' | 'master' | 'unknown';
  lastSeen?: number; // Eje 4: último heartbeat recibido de este cliente
}

const clients = new Map<WebSocket, ClientMeta>();

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
  const msg: S2C = { type: 'CLUSTER_STATE', nodes: cluster.clusterState().nodes };
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

// ── v2: persistencia al cerrar la partida (Paso 3) ───────────────────────────
// Game emite 'game_over' en el nodo que controla la partida. Solo el COORDINADOR
// escribe la historia (Eje 4: la persistencia depende de quién fue electo líder).
game.on('game_over', (result: GameOverResult) => {
  if (!cluster.isCoordinator) return;
  const nombre    = `Casa Abierta #${store.countPartidas() + 1}`;
  const partidaId = store.createPartida(nombre, result.totalRounds);
  let guardados = 0;
  for (const s of result.standings) {
    if (!s.token) continue; // jugador sin identidad persistente → no se historia
    store.recordParticipacion(partidaId, {
      token:   s.token,
      puntos:  s.score,
      puesto:  s.position,
      medalla: s.medalla,
    });
    guardados++;
  }
  console.log(`[${NODE_ID}] 💾 "${nombre}" persistida (partida #${partidaId}, ${guardados} jugadores)`);
});

// ── Mensajes entre nodos ──────────────────────────────────────────────────────

cluster.on('peer_message', async (msg: N2N, fromPeerId: string) => {
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
      // v2: resolver identidad persistente en la DB del coordinador
      const id = store.findOrCreatePlayer(msg.token, msg.nick);
      const player = game.addPlayer(msg.playerId, id.nick, id.token);
      // WELCOME → solo al jugador que se unió, en su nodo de origen
      cluster.sendToPeer(msg.originNode, {
        type:     'N_SEND_TO',
        playerId: msg.playerId,
        payload:  { type: 'WELCOME', playerId: player.id, nick: player.nick, playerCount: game.getPlayerCount(), token: id.token, returning: id.returning },
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

    // Seguidor reenvía START_GAME del master
    case 'N_FORWARD_START':
      if (!cluster.isCoordinator) return;
      game.startGame(msg.totalRounds ?? 10);
      break;

    // v2: seguidor pidió un perfil → el coordinador lo lee de su DB y lo devuelve
    case 'N_FORWARD_PROFILE': {
      if (!cluster.isCoordinator) return;
      cluster.sendToPeer(msg.originNode, {
        type:     'N_SEND_TO',
        playerId: msg.playerId,
        payload:  { type: 'PROFILE', profile: store.getProfile(msg.token) },
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
});

cluster.on('peer_connected',    (id: string) => console.log(`[${NODE_ID}] ✓ Peer listo: ${id}`));
cluster.on('peer_disconnected', (id: string) => console.log(`[${NODE_ID}] ✗ Peer caído: ${id}`));
cluster.on('peer_timeout',      (id: string) => console.log(`[${NODE_ID}] ⚠ Heartbeat perdido de ${id} (Eje 4)`));

// Eje 4: este nodo ganó la elección Bully → asume el control de la partida.
cluster.on('became_coordinator', () => {
  console.log(`[${NODE_ID}] ★ Asumo coordinación: reanudo la partida desde la réplica`);
  game.resume();
});
cluster.on('coordinator_changed', (id: string) => console.log(`[${NODE_ID}] Coordinador actual: ${id}`));

// Eje 4: cualquier cambio de topología o de coordinador se empuja al master.
cluster.on('peer_connected',     () => sendClusterState());
cluster.on('peer_disconnected',  () => sendClusterState());
cluster.on('coordinator_changed', () => sendClusterState());

// ── Conexiones WebSocket de clientes ─────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

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

    switch (msg.type) {

      case 'JOIN': {
        const nick = (msg.nick ?? '').trim().slice(0, 20);
        if (!nick) { send(ws, { type: 'ERROR', message: 'Nick inválido' }); return; }

        // PlayerId incluye nodeId para evitar colisiones entre nodos
        const playerId = `${NODE_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const token    = msg.token ?? null; // v2: identidad persistente del celular
        client.playerId = playerId;
        client.role     = 'player';

        if (cluster.isCoordinator) {
          // v2: el coordinador resuelve la identidad contra su DB (Eje 4: solo él escribe)
          const id = store.findOrCreatePlayer(token, nick);
          game.addPlayer(playerId, id.nick, id.token);
          send(ws, { type: 'WELCOME', playerId, nick: id.nick, playerCount: game.getPlayerCount(), token: id.token, returning: id.returning });
          const roundInfo = game.getCurrentRoundInfo();
          if (roundInfo) send(ws, { type: 'ROUND_START', ...roundInfo });
        } else {
          // Seguidor: reenviar al coordinador (incluido el token); la respuesta llega como N_SEND_TO
          cluster.sendToCoordinator({
            type:       'N_FORWARD_JOIN',
            playerId,
            nick,
            token,
            originNode: NODE_ID,
            lamport:    game.clock.tick(),
          });
        }
        break;
      }

      case 'MASTER_JOIN': {
        client.role = 'master';
        sendClusterState(); // Eje 4: salud del clúster al instante
        if (cluster.isCoordinator) {
          send(ws, { type: 'PLAYER_COUNT', count: game.getPlayerCount() });
          if (game.getPhase() !== 'waiting') {
            send(ws, { type: 'RANKING', entries: game.getRanking(), final: false });
          }
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

      case 'START_GAME': {
        if (client.role !== 'master') return;
        if (cluster.isCoordinator) {
          game.startGame(msg.totalRounds ?? 10);
        } else {
          cluster.sendToCoordinator({
            type:       'N_FORWARD_START',
            totalRounds: msg.totalRounds ?? 10,
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
          send(ws, { type: 'PROFILE', profile: store.getProfile(token) });
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
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.playerId) {
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
      console.log(`[${NODE_ID}] ⚠ Cliente ${meta.playerId} sin latido (${now - meta.lastSeen}ms) -> baja`);
      ws.terminate(); // dispara 'close' -> removePlayer / N_PLAYER_LEFT + PLAYER_LEFT
    }
  }
}, 500);

httpServer.listen(PORT, '0.0.0.0', () => {
  const ip   = getLocalIP();
  const role = cluster.isCoordinator ? 'COORDINADOR' : 'SEGUIDOR';
  console.log(`\n[${NODE_ID}] ══════════════════════════════════════`);
  console.log(`[${NODE_ID}]  ${role} | Puerto ${PORT}`);
  if (PEER_URLS.length > 0) console.log(`[${NODE_ID}]  Peers: ${PEER_URLS.join(', ')}`);
  console.log(`[${NODE_ID}]  Pantalla maestra: http://localhost:${PORT}/master`);
  console.log(`[${NODE_ID}]  URL celulares:    http://${ip}:${PORT}/join`);
  console.log(`[${NODE_ID}] ══════════════════════════════════════\n`);
});

// Conectar a los peers después de que el servidor HTTP esté listo
setTimeout(() => cluster.connectToPeers(), 500);
