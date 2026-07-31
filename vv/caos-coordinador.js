#!/usr/bin/env node
/**
 * V&V — prueba de caos (Eje 4).
 *
 * Levanta un clúster real de 3 nodos, arranca una partida y va matando al
 * coordinador vigente dos veces seguidas (hasta quedar con un solo nodo vivo)
 * mientras una "pantalla maestra" y dos "celulares" reconectan solos — la
 * MISMA lógica que corre en public/master.html y public/play.html, no un
 * doble de prueba. Verifica, contra el sistema real:
 *
 *   1. Cada caída dispara una elección Bully que termina en un coordinador
 *      DISTINTO al que murió, dentro de un tiempo acotado.
 *   2. La partida nunca se congela: siempre vuelve a llegar un TICK o
 *      ROUND_START poco después de cada caída (no hace falta esperar a que
 *      alguien pierda la partida para notar que se trabó).
 *   3. Los "celulares" que se cayeron con su nodo reconectan por otro nodo
 *      vivo y NO terminan duplicados en el marcador final (el bug real que
 *      encontramos al construir la reconexión del Eje 4).
 *
 * Uso: npm run vv:caos   (requiere `npm run build` primero; tarda ~2-3 min
 * porque deja correr varias rondas reales de 24s para tener margen de sobra
 * entre cada caída).
 */
const assert = require('assert');
const {
  sleep, cleanDbs, spawnCluster, stopCluster, waitForClusterReady,
  waitForEvent, ReconnectingClient,
} = require('./lib');

const NODES = [
  { id: 'ch1', port: 4201, coordinatorId: 'ch1', peers: 'ws://localhost:4202,ws://localhost:4203' },
  { id: 'ch2', port: 4202, coordinatorId: 'ch1', peers: 'ws://localhost:4201,ws://localhost:4203' },
  { id: 'ch3', port: 4203, coordinatorId: 'ch1', peers: 'ws://localhost:4201,ws://localhost:4202' },
];
const NODE_WS_URLS = NODES.map(n => `ws://localhost:${n.port}`);
const TOTAL_ROUNDS = 5;               // margen de sobra para 2 caídas + asentamiento
// VV_MODE=relajo prueba el modo del reloj comunitario, cuyo camino de failover
// es distinto: el reloj y el contador de despejadas viajan en el snapshot, así
// que un coordinador promovido debe continuar la cuenta, no reiniciarla.
const MODE = process.env.VV_MODE === 'relajo' ? 'relajo' : 'clasico';
const CONTINUITY_TIMEOUT_MS = 12000;  // cuánto puede tardar como máximo en volver a haber señal de vida
const COORD_CONFIRM_TIMEOUT_MS = 12000;
const GAME_END_TIMEOUT_MS = 180000;
const RELOJ_INICIAL = 45;   // debe coincidir con RELAJO_START_SECONDS de game.ts

const procById = new Map();
function log(...args) { console.log('[vv-caos]', ...args); }

/** Mata el proceso del nodo `id` como lo haría un apagón real (no un cierre prolijo). */
function killNode(id) {
  const proc = procById.get(id);
  log(`[KILL] matando nodo ${id} (pid ${proc.pid})`);
  proc.kill('SIGKILL');
}

async function run() {
  const nodeIds = NODES.map(n => n.id);
  cleanDbs(nodeIds);
  const procs = spawnCluster(NODES, { verbose: process.env.VV_VERBOSE === '1' });
  procs.forEach((p, i) => procById.set(NODES[i].id, p));
  let failed = false;

  try {
    await waitForClusterReady(NODES[0].port, NODES.length - 1);
    log(`clúster de ${NODES.length} nodos arriba`);

    // ── Pantalla maestra reconectable (Eje 4, misma lógica que master.html) ──
    let clusterState = [];
    let lastLiveAt = Date.now();
    const observer = new ReconnectingClient(NODE_WS_URLS, {
      onOpen: c => c.send({ type: 'MASTER_JOIN' }),
    });
    observer.on('CLUSTER_STATE', msg => { clusterState = msg.nodes; });
    observer.on('message', msg => {
      if (['TICK', 'ROUND_START', 'ROUND_END', 'RANKING'].includes(msg.type)) lastLiveAt = Date.now();
    });
    await waitForEvent(observer, 'CLUSTER_STATE', 8000);
    log('pantalla maestra conectada y viendo el clúster');

    // ── Dos "celulares" reconectables, cada uno con su identidad persistente ──
    // (mismo patrón que public/play.html: token guardado y reenviado al
    // reconectar, para que el servidor los reconozca en vez de duplicarlos).
    function makeReconnectingPlayer(nick, startIdx) {
      let token = null;
      const c = new ReconnectingClient(NODE_WS_URLS, {
        startIdx,
        onOpen: client => client.send({ type: 'JOIN', nick, token }),
      });
      c.on('WELCOME', msg => { token = msg.token; });
      return c;
    }
    const bot1 = makeReconnectingPlayer('chaosBot1', 0); // vive en ch1 (el que matamos primero)
    const bot2 = makeReconnectingPlayer('chaosBot2', 2); // vive en ch3 (coordinador tras la 1a caída)
    await Promise.all([
      waitForEvent(bot1, 'WELCOME', 8000),
      waitForEvent(bot2, 'WELCOME', 8000),
    ]);
    log('2 celulares conectados (chaosBot1 en ch1, chaosBot2 en ch3)');

    observer.send({ type: 'START_GAME', totalRounds: TOTAL_ROUNDS, mode: MODE });
    // START_GAME abre primero la ventana de votación (categoría + dificultad);
    // ROUND_START llega recién al cerrarse, no de inmediato.
    await waitForEvent(observer, 'ROUND_START', 25000);

    // Relajo: se vigila el reloj comunitario para comprobar que un cambio de
    // coordinador NO lo reinicia (viaja replicado en el snapshot).
    let reloj = null;
    let relojAntesDeCaida = null;
    if (MODE === 'relajo') {
      observer.on('SHARED_CLOCK', msg => { reloj = msg; });
      await waitForEvent(observer, 'SHARED_CLOCK', 8000);
      log(`reloj comunitario inicial: ${reloj.secondsLeft}s`);
    }
    lastLiveAt = Date.now();
    log(MODE === 'relajo'
      ? 'partida arrancada en modo RELAJO (reloj comunitario)'
      : `partida arrancada (${TOTAL_ROUNDS} rondas)`);

    // ── Caída 1: mata al coordinador inicial (ch1) ───────────────────────────
    await sleep(6000); // deja correr la ronda un rato antes de matar nada
    killNode('ch1');
    const t1 = Date.now();

    const newCoord1 = await waitForEvent(observer, 'CLUSTER_STATE', COORD_CONFIRM_TIMEOUT_MS,
      msg => { const c = msg.nodes.find(n => n.isCoordinator); return !!c && c.id !== 'ch1' && c.up; });
    log(`[OK] elección Bully tras caída 1: nuevo coordinador = ${newCoord1.nodes.find(n => n.isCoordinator).id} (${Date.now() - t1}ms)`);

    const life1 = await waitForEvent(observer, 'message', CONTINUITY_TIMEOUT_MS,
      msg => msg.type === 'TICK' || msg.type === 'ROUND_START');
    const gap1 = Date.now() - t1;
    assert.ok(gap1 < CONTINUITY_TIMEOUT_MS, `la partida tardó demasiado en dar señal de vida tras caída 1: ${gap1}ms`);
    log(`[OK] la partida no se congeló: volvió a haber señal de vida (${life1.type}) ${gap1}ms después de matar ch1`);

    if (MODE === 'relajo') {
      relojAntesDeCaida = reloj ? reloj.secondsLeft : null;
    }

    await sleep(5000); // deja asentar reconexiones de celulares y pantalla

    if (MODE === 'relajo') {
      assert.ok(reloj, 'no llegó ningún SHARED_CLOCK tras el failover');
      // El reloj sigue corriendo (bajó) y NO se reinició a 45s.
      assert.ok(reloj.secondsLeft < RELOJ_INICIAL,
        `el reloj comunitario se reinició tras el failover (${reloj.secondsLeft}s)`);
      log(`[OK] el reloj comunitario sobrevivió al cambio de coordinador: ${relojAntesDeCaida}s -> ${reloj.secondsLeft}s (sin reiniciarse)`);
    }

    // ── Caída 2: mata al nuevo coordinador (debería ser ch3, el de mayor id) ──
    const coordToKill = clusterState.find(n => n.isCoordinator)?.id;
    assert.ok(coordToKill, 'no se pudo determinar el coordinador vigente antes de la 2a caída');
    killNode(coordToKill);
    const t2 = Date.now();

    const newCoord2 = await waitForEvent(observer, 'CLUSTER_STATE', COORD_CONFIRM_TIMEOUT_MS,
      msg => { const c = msg.nodes.find(n => n.isCoordinator); return !!c && c.id !== coordToKill && c.up; });
    const finalCoordId = newCoord2.nodes.find(n => n.isCoordinator).id;
    log(`[OK] elección Bully tras caída 2: nuevo coordinador = ${finalCoordId} (${Date.now() - t2}ms)`);
    assert.notStrictEqual(finalCoordId, 'ch1', 'ch1 sigue muerto, no puede volver a ser coordinador');
    assert.notStrictEqual(finalCoordId, coordToKill, 'el coordinador "nuevo" es el mismo que acabamos de matar');

    const life2 = await waitForEvent(observer, 'message', CONTINUITY_TIMEOUT_MS,
      msg => msg.type === 'TICK' || msg.type === 'ROUND_START');
    const gap2 = Date.now() - t2;
    assert.ok(gap2 < CONTINUITY_TIMEOUT_MS, `la partida tardó demasiado en dar señal de vida tras caída 2: ${gap2}ms`);
    log(`[OK] la partida SIGUE sin congelarse con un solo nodo vivo: señal de vida (${life2.type}) ${gap2}ms después de matar ${coordToKill}`);

    // ── Deja terminar la partida con el único nodo que queda y revisa el cierre ──
    log('esperando a que la partida termine con el único nodo sobreviviente...');
    const finalRanking = await waitForEvent(observer, 'RANKING', GAME_END_TIMEOUT_MS, msg => msg.final === true);

    const nicks = finalRanking.entries.map(e => e.nick);
    assert.strictEqual(new Set(nicks).size, nicks.length,
      `hay nicks duplicados en el marcador final tras las caídas: ${JSON.stringify(nicks)}`);
    log('[OK] sin jugadores fantasma/duplicados en el marcador final');

    for (const nick of ['chaosBot1', 'chaosBot2']) {
      assert.ok(nicks.includes(nick), `${nick} desapareció del marcador final en vez de reconectar`);
    }
    log('[OK] los dos celulares que se cayeron con su nodo reconectaron y llegaron hasta el final');

    if (process.env.VV_DATABASE_URL) {
      const persistenceDeadline = Date.now() + 10000;
      let persisted = false;
      while (!persisted && Date.now() < persistenceDeadline) {
        const response = waitForEvent(observer, 'HALL_OF_FAME', 2500).catch(() => null);
        observer.send({ type: 'GET_HALL_OF_FAME' });
        const hall = await response;
        persisted = (hall?.recentGames?.length ?? 0) === 1;
        if (!persisted) await sleep(250);
      }
      assert.ok(persisted, 'PostgreSQL no confirmó exactamente una partida tras el failover');
      log('[OK] PostgreSQL confirmó una sola partida después de los dos cambios de coordinador');
    }

    log('TODO OK — el sistema tolera perder 2 de 3 nodos (incluido el coordinador dos veces) sin congelarse ni perder identidades');
  } catch (err) {
    failed = true;
    console.error('[vv-caos] [FAIL] FALLÓ:', err.message);
  } finally {
    stopCluster(procById.size ? [...procById.values()] : []);
    await sleep(300);
  }

  process.exit(failed ? 1 : 0);
}

run();
