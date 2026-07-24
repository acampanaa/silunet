#!/usr/bin/env node
/**
 * V&V — bot de concurrencia (Eje 2 + Eje 3).
 *
 * Levanta un clúster real de 3 nodos, conecta N jugadores repartidos entre
 * los 3 nodos y hace que TODOS acierten "a la vez". Verifica en el sistema
 * real (no mockeado) tres invariantes que el CLAUDE.md exige que se cumplan:
 *
 *   1. El marcador final queda ordenado estrictamente por timestamp Lamport
 *      (Eje 2) — no por el orden de llegada a la red ni por qué nodo procesó
 *      primero.
 *   2. La posición que el servidor anuncia EN VIVO al momento del acierto
 *      (bajo el candado del Eje 3) coincide con la posición final tras
 *      ordenar por Lamport. Si no coincidieran, el candado y el reloj lógico
 *      estarían desincronizados.
 *   3. El puntaje de cada quien corresponde exactamente a la fórmula de
 *      game.ts aplicada a su posición lógica (no al tiempo de respuesta).
 *
 * Uso: npm run vv:concurrencia   (requiere `npm run build` primero)
 */
const path = require('path');
const assert = require('assert');
const {
  sleep, cleanDbs, spawnCluster, stopCluster, waitForClusterReady,
  waitForEvent, Client,
} = require('./lib');
const { WORD_BANK } = require(path.join(__dirname, '..', 'dist', 'wordBank.js'));

const NODES = [
  { id: 'vv1', port: 4101, coordinatorId: 'vv1', peers: 'ws://localhost:4102,ws://localhost:4103' },
  { id: 'vv2', port: 4102, coordinatorId: 'vv1', peers: 'ws://localhost:4101,ws://localhost:4103' },
  { id: 'vv3', port: 4103, coordinatorId: 'vv1', peers: 'ws://localhost:4101,ws://localhost:4102' },
];
const N_BOTS = 7; // más que nodos*2 -> fuerza colas reales en el candado del Eje 3
const POINTS_TOP = 1000;
const POINTS_BASE = 100;

function log(...args) { console.log('[vv-concurrencia]', ...args); }

function matchesPattern(word, pattern) {
  if (word.length !== pattern.length) return false;
  for (let i = 0; i < word.length; i++) {
    if (pattern[i] !== '_' && pattern[i] !== word[i]) return false;
  }
  return true;
}

/**
 * Los bots no reciben la palabra: la resuelven igual que un jugador curioso
 * miraría la silueta y las letras reveladas, filtrando el MISMO banco de
 * palabras que usa el servidor (dist/wordBank.js) por categoría, longitud y
 * las letras que se van revelando. No es un atajo de test: es lo mínimo que
 * necesita cualquier bot honesto para poder acertar de verdad.
 */
function resolveWord(observer, category, hiddenLen) {
  let candidates = WORD_BANK.filter(w => w.category === category && w.word.length === hiddenLen);
  if (candidates.length === 1) return Promise.resolve(candidates[0].word);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      observer.off('TICK', onTick);
      reject(new Error(`ambiguo: ${candidates.length} palabras candidatas y no se resolvió a tiempo`));
    }, 15000);
    function onTick(msg) {
      const pattern = msg.hiddenWord.replace(/ /g, '');
      const next = candidates.filter(w => matchesPattern(w.word, pattern));
      if (next.length > 0) candidates = next;
      if (candidates.length === 1) {
        clearTimeout(timer);
        observer.off('TICK', onTick);
        resolve(candidates[0].word);
      }
    }
    observer.on('TICK', onTick);
  });
}

async function run() {
  cleanDbs(NODES.map(n => n.id));
  const procs = spawnCluster(NODES, { verbose: process.env.VV_VERBOSE === '1' });
  let failed = false;

  try {
    await waitForClusterReady(NODES[0].port, NODES.length - 1);
    log(`clúster de ${NODES.length} nodos arriba`);

    // Reparte los bots entre los 3 nodos para que las respuestas concurrentes
    // lleguen por caminos distintos (local en el coordinador + N_FORWARD_GUESS
    // desde los seguidores) — si solo pegaran a un nodo no se probaría nada
    // del Eje 1 inter-nodo.
    const bots = [];
    for (let i = 0; i < N_BOTS; i++) {
      const node = NODES[i % NODES.length];
      bots.push(new Client(node.port));
    }
    await Promise.all(bots.map(b => b.connect()));
    bots.forEach((b, i) => b.send({ type: 'JOIN', nick: `bot${i + 1}` }));
    await Promise.all(bots.map(b => waitForEvent(b, 'WELCOME', 5000)));
    log(`${bots.length} bots conectados, repartidos en los ${NODES.length} nodos`);

    const master = new Client(NODES[0].port);
    await master.connect();
    master.send({ type: 'MASTER_JOIN' });
    const roundStartPromise = waitForEvent(bots[0], 'ROUND_START', 5000);
    master.send({ type: 'START_GAME', totalRounds: 1 });
    const roundStart = await roundStartPromise;
    const hiddenLen = roundStart.hiddenWord.replace(/ /g, '').length;
    log(`ronda arrancada — categoría "${roundStart.category}", palabra de ${hiddenLen} letras`);

    const word = await resolveWord(bots[0], roundStart.category, hiddenLen);
    log(`palabra resuelta a partir del banco real: ${word}`);

    // Observador único para el orden en vivo: CORRECT_ANSWER y ROUND_END se
    // difunden a TODOS los clientes (Eje 1), así que basta escuchar en un bot
    // para ver el mismo stream global que verían los demás.
    const liveOrder = [];
    bots[0].on('CORRECT_ANSWER', msg => liveOrder.push({ nick: msg.nick, position: msg.position, lamport: msg.lamport }));
    if (process.env.VV_VERBOSE === '1') bots[0].on('TICK', msg => log(`  tick: ${msg.timeLeft}s`));
    const roundEndPromise = waitForEvent(bots[0], 'ROUND_END', 35000);

    // Disparo "simultáneo": todos los envíos se encolan en el mismo tick del
    // event loop, pero viajan por 3 conexiones TCP a 3 procesos distintos —
    // el orden de llegada real al coordinador queda fuera de nuestro control,
    // que es justamente lo que se quiere ejercitar.
    await Promise.all(bots.map(b => Promise.resolve().then(() => b.send({ type: 'GUESS', word, lamport: b.tick() }))));
    log(`${bots.length} bots enviaron su acierto concurrentemente`);

    const roundEnd = await roundEndPromise;
    const solvers = roundEnd.solvers;

    assert.strictEqual(solvers.length, bots.length,
      `se esperaba que los ${bots.length} bots acertaran, llegaron ${solvers.length}`);
    log('✓ todos los bots quedaron registrados como aciertos (sin pérdidas del candado)');

    for (let i = 1; i < solvers.length; i++) {
      assert.ok(solvers[i].lamport > solvers[i - 1].lamport,
        `orden de Lamport violado en posición ${i + 1}: ${JSON.stringify(solvers)}`);
    }
    log('✓ el ranking final está ordenado estrictamente por timestamp Lamport (Eje 2)');

    for (const entry of liveOrder) {
      const final = solvers.find(s => s.nick === entry.nick);
      assert.ok(final, `${entry.nick} anunció acierto en vivo pero no aparece en ROUND_END`);
      assert.strictEqual(final.position, entry.position,
        `${entry.nick}: posición anunciada en vivo (${entry.position}) != posición final por Lamport (${final.position})`);
    }
    log('✓ la posición anunciada en vivo coincide con la posición final (Eje 2 + Eje 3 consistentes)');

    const N = solvers.length;
    for (const s of solvers) {
      const expected = Math.round(POINTS_BASE + (POINTS_TOP - POINTS_BASE) * (1 - (s.position - 1) / N));
      assert.strictEqual(s.points, expected,
        `${s.nick}: puntos=${s.points}, esperados=${expected} según su posición lógica`);
    }
    log('✓ el puntaje corresponde a la posición lógica de llegada, no al tiempo de red');

    const nicks = solvers.map(s => s.nick);
    assert.strictEqual(new Set(nicks).size, nicks.length, 'hay nicks duplicados en el ranking final');
    log('✓ sin jugadores duplicados');

    log('TODO OK — el orden lógico de Lamport se respeta bajo concurrencia real multi-nodo');
  } catch (err) {
    failed = true;
    console.error('[vv-concurrencia] ✗ FALLÓ:', err.message);
  } finally {
    stopCluster(procs);
    await sleep(300); // deja que los procesos suelten los puertos
  }

  process.exit(failed ? 1 : 0);
}

run();
