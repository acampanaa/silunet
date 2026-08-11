#!/usr/bin/env node
/**
 * V&V — bot de latencia y tiempos de respuesta (apartado 4.5 de la guía).
 *
 * Las otras dos suites miden tiempos de RECUPERACIÓN (cuánto tarda una
 * elección Bully). Esta mide el otro lado: cuánto tarda el sistema en
 * responder durante una partida normal.
 *
 * Mide tres cosas sobre un clúster real de 3 nodos:
 *
 *   1. Ida y vuelta de un intento — desde que el celular manda GUESS hasta que
 *      recibe la respuesta. Se usan intentos deliberadamente equivocados: hacen
 *      exactamente el mismo recorrido que uno correcto pero no alteran el
 *      marcador, así la medición no interfiere con la partida.
 *
 *   2. Coordinador contra seguidor — la medición que importa en un sistema
 *      distribuido. Un jugador conectado a un SEGUIDOR paga un salto extra: su
 *      intento se reenvía al coordinador (N_FORWARD_GUESS), se resuelve allí y
 *      la respuesta vuelve. Esta suite cuantifica ese sobrecosto.
 *
 *   3. Propagación del broadcast — cuánto se separan en el tiempo las llegadas
 *      de un MISMO evento a jugadores conectados a nodos distintos. Es la
 *      sincronización entre nodos medida en milisegundos.
 *
 * Uso: npm run vv:latencia   (requiere `npm run build` primero)
 */
const assert = require('assert');
const {
  sleep, cleanDbs, spawnCluster, stopCluster, fetchInfo, waitForClusterReady,
  waitForEvent, Client,
} = require('./lib');

const NODES = [
  { id: 'lat1', port: 4201, coordinatorId: 'lat1', peers: 'ws://localhost:4202,ws://localhost:4203' },
  { id: 'lat2', port: 4202, coordinatorId: 'lat1', peers: 'ws://localhost:4201,ws://localhost:4203' },
  { id: 'lat3', port: 4203, coordinatorId: 'lat1', peers: 'ws://localhost:4201,ws://localhost:4202' },
];

const MUESTRAS_POR_BOT = 25;   // suficientes para un p95 con sentido
const PAUSA_ENTRE_INTENTOS = 60;

// El juego va por rondas de 24 s: cualquier respuesta por debajo de 100 ms es
// imperceptible para el público. Los topes son holgados para no volver la
// prueba frágil en una máquina cargada.
const TOPE_P95_MS = 500;
const TOPE_PROPAGACION_MS = 500;
const TOPE_HTTP_MS = 1000;

function log(...args) { console.log('[vv-latencia]', ...args); }

/** Devuelve mediana, p95 y máximo de una lista de milisegundos. */
function resumir(muestras) {
  const orden = [...muestras].sort((a, b) => a - b);
  const en = p => orden[Math.min(orden.length - 1, Math.floor(orden.length * p))];
  const media = orden.reduce((t, v) => t + v, 0) / orden.length;
  return { n: orden.length, media, p50: en(0.5), p95: en(0.95), max: orden[orden.length - 1] };
}

function formatear(nombre, r) {
  return `${nombre.padEnd(28)} n=${String(r.n).padStart(3)}  `
    + `media ${r.media.toFixed(1)}ms  p50 ${r.p50}ms  p95 ${r.p95}ms  máx ${r.max}ms`;
}

/**
 * Mide el viaje completo de un intento equivocado: GUESS -> WRONG_ANSWER.
 * Recorre cliente -> nodo -> (si es seguidor) coordinador -> nodo -> cliente.
 */
async function medirIdaYVuelta(bot, muestras) {
  const tiempos = [];
  for (let i = 0; i < muestras; i++) {
    const respuesta = waitForEvent(bot, 'WRONG_ANSWER', 5000);
    const t0 = Date.now();
    bot.send({ type: 'GUESS', guess: `zzlatencia${i}`, l: bot.tick() });
    await respuesta;
    tiempos.push(Date.now() - t0);
    await sleep(PAUSA_ENTRE_INTENTOS);
  }
  return tiempos;
}

/**
 * Mide cuánto se separan las llegadas de un mismo TICK a bots de nodos
 * distintos. Todos los clientes reciben el mismo TICK con el mismo timeLeft,
 * así que ese valor sirve para emparejar la llegada en cada bot.
 */
function medirPropagacion(bots, segundos) {
  return new Promise(resolve => {
    const llegadas = new Map(); // timeLeft -> [instantes]
    const oyentes = bots.map(bot => {
      const oyente = msg => {
        const lista = llegadas.get(msg.timeLeft) ?? [];
        lista.push(Date.now());
        llegadas.set(msg.timeLeft, lista);
      };
      bot.on('TICK', oyente);
      return { bot, oyente };
    });

    setTimeout(() => {
      for (const { bot, oyente } of oyentes) bot.off('TICK', oyente);
      const dispersiones = [];
      for (const [, instantes] of llegadas) {
        // Solo sirven los ticks que alcanzaron a TODOS los bots.
        if (instantes.length === bots.length) {
          dispersiones.push(Math.max(...instantes) - Math.min(...instantes));
        }
      }
      resolve(dispersiones);
    }, segundos * 1000);
  });
}

/** Mide el tiempo de respuesta del endpoint HTTP de estado. */
async function medirHttp(port, muestras) {
  const tiempos = [];
  for (let i = 0; i < muestras; i++) {
    const t0 = Date.now();
    await fetchInfo(port);
    tiempos.push(Date.now() - t0);
    await sleep(30);
  }
  return tiempos;
}

async function main() {
  cleanDbs(NODES.map(n => n.id));
  const procesos = spawnCluster(NODES);
  const bots = [];
  let master;

  try {
    await Promise.all(NODES.map(n => waitForClusterReady(n.port, 2)));
    log('clúster de 3 nodos arriba');

    const info = await fetchInfo(NODES[0].port);
    const coordinador = info.coordinator;
    log(`coordinador = ${coordinador}`);

    // Un bot por nodo: así se puede comparar el que está en el coordinador
    // contra los que están en seguidores.
    for (const nodo of NODES) {
      const bot = new Client(nodo.port);
      await bot.connect();
      bot.nodo = nodo.id;
      bot.esCoordinador = nodo.id === coordinador;
      bots.push(bot);
    }
    bots.forEach((b, i) => b.send({ type: 'JOIN', nick: `lat${i + 1}` }));
    await Promise.all(bots.map(b => waitForEvent(b, 'WELCOME', 5000)));
    log(`3 bots conectados, uno por nodo`);

    master = new Client(NODES[0].port);
    await master.connect();
    master.send({ type: 'MASTER_JOIN' });

    // START_GAME abre la ventana de votación; la ronda real llega después.
    const rondaLista = waitForEvent(bots[0], 'ROUND_START', 25000);
    master.send({ type: 'START_GAME', totalRounds: 1 });
    await rondaLista;
    log('ronda en curso — midiendo');

    // ---- 1 y 2: ida y vuelta, separando coordinador de seguidores ----------
    const porBot = await Promise.all(
      bots.map(bot => medirIdaYVuelta(bot, MUESTRAS_POR_BOT)),
    );

    const enCoordinador = [];
    const enSeguidor = [];
    bots.forEach((bot, i) => {
      (bot.esCoordinador ? enCoordinador : enSeguidor).push(...porBot[i]);
    });

    const todos = resumir([...enCoordinador, ...enSeguidor]);
    const coord = resumir(enCoordinador);
    const seguidor = resumir(enSeguidor);

    log('');
    log('IDA Y VUELTA DE UN INTENTO (GUESS -> respuesta)');
    log('  ' + formatear('todos los jugadores', todos));
    log('  ' + formatear('en el coordinador', coord));
    log('  ' + formatear('en un seguidor', seguidor));
    const sobrecosto = seguidor.p50 - coord.p50;
    log(`  sobrecosto del salto extra al coordinador: ${sobrecosto >= 0 ? '+' : ''}${sobrecosto} ms (mediana)`);

    // ---- 3: propagación del broadcast entre nodos --------------------------
    log('');
    log('PROPAGACIÓN DEL BROADCAST entre nodos (mismo evento, 3 nodos)');
    const dispersiones = await medirPropagacion(bots, 6);
    assert.ok(dispersiones.length > 0, 'no se capturó ningún evento común a los 3 nodos');
    const propagacion = resumir(dispersiones);
    log('  ' + formatear('dispersión entre nodos', propagacion));

    // ---- 4: tiempo de respuesta HTTP --------------------------------------
    log('');
    log('TIEMPO DE RESPUESTA HTTP (/api/info)');
    const http = resumir(await medirHttp(NODES[0].port, 20));
    log('  ' + formatear('estado del clúster', http));

    // ---- criterios de aceptación ------------------------------------------
    log('');
    assert.ok(todos.p95 < TOPE_P95_MS,
      `el p95 de ida y vuelta (${todos.p95}ms) supera el tope de ${TOPE_P95_MS}ms`);
    log(`[OK] el p95 de ida y vuelta es ${todos.p95}ms, por debajo del tope de ${TOPE_P95_MS}ms`);

    assert.ok(propagacion.p95 < TOPE_PROPAGACION_MS,
      `la dispersión entre nodos (${propagacion.p95}ms) supera el tope de ${TOPE_PROPAGACION_MS}ms`);
    log(`[OK] un mismo evento llega a los 3 nodos con ${propagacion.p95}ms de diferencia (p95)`);

    assert.ok(http.p95 < TOPE_HTTP_MS,
      `el p95 de /api/info (${http.p95}ms) supera el tope de ${TOPE_HTTP_MS}ms`);
    log(`[OK] /api/info responde en ${http.p95}ms (p95)`);

    assert.ok(seguidor.p50 >= coord.p50 - 5,
      'un seguidor no debería responder más rápido que el coordinador; revise la medición');
    log(`[OK] el salto extra del seguidor al coordinador cuesta ${sobrecosto} ms de mediana`);

    log('');
    log('TODO OK — el sistema responde muy por debajo del umbral perceptible '
      + `(la ronda dura 24 s y la respuesta mediana es de ${todos.p50} ms)`);
  } finally {
    for (const bot of bots) bot.close();
    if (master) master.close();
    await sleep(300);
    stopCluster(procesos);
    cleanDbs(NODES.map(n => n.id));
  }
}

main().catch(error => {
  console.error('[vv-latencia] FALLÓ:', error.message);
  process.exit(1);
});
