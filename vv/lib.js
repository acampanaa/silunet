/**
 * V&V — utilidades compartidas por los bots de tools/vv.
 *
 * Nada de esto mockea al servidor: levanta procesos reales de dist/server.js
 * (el mismo binario que corre en producción) y se conecta como clientes WS
 * reales, igual que un celular o la pantalla maestra. Solo así una verificación
 * de Lamport/exclusión-mutua/failover dice algo real sobre el sistema.
 */
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Borra las DBs de una corrida anterior para que cada prueba parta limpia. */
function cleanDbs(nodeIds) {
  for (const id of nodeIds) {
    const base = path.join(ROOT, 'data', `silunet-${id}.db`);
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(base + suffix); } catch { /* no existía, ok */ }
    }
  }
}

/**
 * Levanta un clúster de nodos reales (dist/server.js) con las mismas variables
 * de entorno que usan los scripts de scripts/*.ps1 en producción.
 * `nodes`: [{ id, port, peers: 'ws://localhost:PORT,...', coordinatorId }]
 */
function spawnCluster(nodes, { verbose = false } = {}) {
  return nodes.map(n => {
    const proc = spawn('node', ['dist/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ID: n.id,
        PORT: String(n.port),
        COORDINATOR_ID: n.coordinatorId,
        PEERS: n.peers,
      },
      stdio: verbose ? 'pipe' : 'ignore',
    });
    if (verbose) {
      proc.stdout.on('data', d => process.stdout.write(`[${n.id}] ${d}`));
      proc.stderr.on('data', d => process.stderr.write(`[${n.id}] ${d}`));
    }
    return proc;
  });
}

function stopCluster(procs) {
  for (const p of procs) {
    if (!p.killed) { try { p.kill('SIGKILL'); } catch { /* ya murió */ } }
  }
}

function fetchInfo(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/api/info`, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

/** Espera a que un nodo esté arriba y vea a todos sus peers conectados (Eje 1). */
async function waitForClusterReady(port, expectedPeers, timeoutMs = 10000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await fetchInfo(port);
      if (info.connectedPeers.length >= expectedPeers) return info;
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error(`el clúster no levantó a tiempo (puerto ${port}): ${lastErr?.message ?? 'sin respuesta'}`);
}

/** Espera un evento (o el primero que cumpla `predicate`) con timeout explícito. */
function waitForEvent(emitter, eventName, timeoutMs, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, handler);
      reject(new Error(`timeout (${timeoutMs}ms) esperando evento '${eventName}'`));
    }, timeoutMs);
    function handler(msg) {
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        emitter.off(eventName, handler);
        resolve(msg);
      }
    }
    emitter.on(eventName, handler);
  });
}

/**
 * Cliente WS mínimo (sin reconexión) — un jugador o el master de una sola
 * conexión. Emite 'message' con cada mensaje parseado y además un evento con
 * el nombre `msg.type` (p.ej. 'WELCOME', 'ROUND_START') para escuchar puntual.
 */
class Client extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.lamport = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);
      this.ws.once('open', () => {
        // Eje 4: el servidor da de baja a un jugador sin latido en 2s
        // (CLIENT_TIMEOUT_MS). Un bot que no manda PING como un celular real
        // se cae a mitad de ronda -> late igual que public/play.html.
        this._pingTimer = setInterval(() => this.send({ type: 'PING', l: this.tick() }), 1000);
        resolve(this);
      });
      this.ws.once('error', reject);
      this.ws.on('close', () => clearInterval(this._pingTimer));
      this.ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.lamport != null) this.lamport = Math.max(this.lamport, msg.lamport) + 1;
        this.emit('message', msg);
        this.emit(msg.type, msg);
      });
    });
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  tick() { return ++this.lamport; }

  close() { clearInterval(this._pingTimer); try { this.ws.close(); } catch { /* ya cerrado */ } }
}

/**
 * Cliente con reconexión automática al clúster — la MISMA lógica que ya corre
 * en public/play.html y public/master.html (Eje 4), reimplementada en Node
 * para poder probarla desde un script: reintenta el nodo actual un par de
 * veces y luego rota por `nodeUrls` hasta encontrar uno vivo.
 */
class ReconnectingClient extends EventEmitter {
  constructor(nodeUrls, { onOpen, startIdx = 0 } = {}) {
    super();
    this.nodeUrls = nodeUrls;
    this.idx = startIdx;
    this.attempt = 0;
    this.onOpenCb = onOpen;
    this.lamport = 0;
    this.destroyed = false;
    this._connect();
  }

  _connect() {
    if (this.destroyed) return;
    const url = this.nodeUrls[this.idx % this.nodeUrls.length];
    this.currentUrl = url;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.attempt = 0;
      this.emit('open', url);
      this.onOpenCb && this.onOpenCb(this);
    });

    this.ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.lamport != null) this.lamport = Math.max(this.lamport, msg.lamport) + 1;
      this.emit('message', msg);
      this.emit(msg.type, msg);
    });

    this.ws.on('close', () => {
      this.emit('close', url);
      if (this.destroyed) return;
      this.attempt++;
      if (this.attempt > 2 && this.nodeUrls.length > 1) {
        this.idx = (this.idx + 1) % this.nodeUrls.length;
        this.attempt = 0;
      }
      setTimeout(() => this._connect(), 800);
    });

    this.ws.on('error', () => { /* el 'close' se dispara igual y reintenta */ });
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  tick() { return ++this.lamport; }

  destroy() {
    this.destroyed = true;
    try { this.ws.close(); } catch { /* ya cerrado */ }
  }
}

module.exports = {
  sleep, cleanDbs, spawnCluster, stopCluster, fetchInfo, waitForClusterReady,
  waitForEvent, Client, ReconnectingClient,
};
