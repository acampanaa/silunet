/**
 * Pruebas unitarias de Silunet sobre los módulos donde vive
 * la lógica cuyo fallo arruinaría una partida:
 *
 *   lamport.ts   ordena los aciertos entre nodos
 *   mutex.ts     evita que dos aciertos simultáneos se pisen
 *   wordBank.ts  elige las palabras de cada ronda
 *
 * Ejecutar con:  npm run test:unit
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { LamportClock } from '../../src/lamport';
import { Mutex } from '../../src/mutex';
import { Game, classicRoundSeconds } from '../../src/game';
import { DistributedMonitoring } from '../../src/monitoring';
import { ReplicaStore } from '../../src/replicaStore';
import { MonitorParticipant, S2C } from '../../src/types';
import {
  DIFFICULTIES,
  DIFFICULTY_LABEL,
  MAX_ROUNDS,
  WORD_BANK,
  difficultyOf,
  getCategoryCounts,
  getMixedQueue,
  getRandomRounds,
} from '../../src/wordBank';

describe('Réplica durable del backend', () => {
  test('sobrevive al reinicio y cerca términos antiguos', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silunet-replica-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const snapshot = new Game().snapshot();

    const firstProcess = new ReplicaStore('node2', 'test-cluster', directory);
    firstProcess.commit({ leaderId: 'node1', term: 4, index: 21, snapshot });

    const restartedProcess = new ReplicaStore('node2', 'test-cluster', directory);
    const loaded = restartedProcess.load();
    assert.equal(loaded?.index, 21);
    assert.equal(loaded?.term, 4);
    assert.equal(loaded?.snapshot.phase, 'waiting');

    restartedProcess.commit({ leaderId: 'lider-viejo', term: 3, index: 99, snapshot });
    assert.equal(restartedProcess.index, 21, 'un líder cercado no pisa el término vigente');
  });
});


// El reloj de Lamport permite saber qué acierto ocurrió antes que otro sin
// mirar la hora del celular: cada nodo lleva su contador y lo sincroniza.
describe('Reloj de Lamport', () => {

  test('cada evento propio suma uno al reloj', () => {
    const reloj = new LamportClock();

    assert.equal(reloj.value, 0);
    assert.equal(reloj.tick(), 1);
    assert.equal(reloj.tick(), 2);
  });

  test('al recibir un mensaje el reloj se sincroniza y nunca retrocede', () => {
    const reloj = new LamportClock();

    // Llega un mensaje de un nodo que va por el evento 8: se adopta el 8 y se
    // suma 1 por haberlo recibido.
    assert.equal(reloj.update(8), 9);
    // Llega uno viejo, del evento 3: el reloj avanza igual, no vuelve atrás.
    assert.equal(reloj.update(3), 10);
  });

  test('fusionar una réplica adopta el valor más alto sin contar un evento', () => {
    const reloj = new LamportClock();

    // merge() lo usa un nodo que se vuelve coordinador y hereda el estado.
    reloj.merge(12);
    assert.equal(reloj.value, 12);
    reloj.merge(4);
    assert.equal(reloj.value, 12);
  });
});


// Cuando dos jugadores aciertan a la vez desde nodos distintos, sus puntajes
// no se pueden sumar al mismo tiempo. El candado los pone en fila.
describe('Candado del marcador', () => {

  test('las tareas que llegan juntas se atienden en orden de llegada', async () => {
    const candado = new Mutex('marcador');
    const ejecutadas: string[] = [];
    const avisos: number[] = [];
    candado.on('queued', cantidad => avisos.push(cantidad));

    // Se lanzan sin esperar entre ellas: así llegan "al mismo tiempo".
    const a = candado.runExclusive('A', () => { ejecutadas.push('A'); });
    const b = candado.runExclusive('B', () => { ejecutadas.push('B'); });
    const c = candado.runExclusive('C', () => { ejecutadas.push('C'); });

    // A entró; B y C esperan. Este aviso es el que /master muestra en vivo.
    assert.equal(candado.waiting, 2);
    assert.deepEqual(avisos, [1, 2]);

    await Promise.all([a, b, c]);
    assert.deepEqual(ejecutadas, ['A', 'B', 'C']);
  });

  test('si una tarea falla, el candado queda libre para la siguiente', async () => {
    const candado = new Mutex();

    await assert.rejects(
      candado.runExclusive('fallida', () => { throw new Error('fallo controlado'); }),
      /fallo controlado/,
    );

    assert.equal(await candado.runExclusive('siguiente', () => 42), 42);
    assert.equal(candado.waiting, 0);
  });
});

describe('Monitor distribuido', () => {
  const participant = (overrides: Partial<MonitorParticipant> = {}): MonitorParticipant => ({
    connectionId: 'node1-connection',
    role: 'player',
    nick: 'Ana',
    playerId: 'player-1',
    p2pPeerId: 'p_ana12345',
    nodeId: 'node1',
    connectedAt: 100,
    lastSeenAt: 9_800,
    heartbeatAgeMs: 200,
    status: 'healthy',
    ...overrides,
  });

  test('clasifica el estado a partir de la edad del heartbeat', () => {
    const monitor = new DistributedMonitoring('node1');
    assert.equal(monitor.statusForAge(200), 'healthy');
    assert.equal(monitor.statusForAge(1_500), 'warning');
    assert.equal(monitor.statusForAge(2_000), 'offline');
  });

  test('agrega participantes de nodos distintos y cuenta sus roles', () => {
    const monitor = new DistributedMonitoring('node1');
    monitor.acceptRemoteReport({
      nodeId: 'node2',
      generatedAt: 10_000,
      participants: [participant({
        connectionId: 'node2-master',
        role: 'master',
        nick: 'Master',
        playerId: 'master-1',
        p2pPeerId: 'p_master123',
        nodeId: 'node2',
      })],
    }, 'node2', 10_000);

    const snapshot = monitor.snapshot({
      localParticipants: [participant()],
      clusterNodes: [
        { id: 'node1', up: true, isCoordinator: true, heartbeatAgeMs: 0 },
        { id: 'node2', up: true, isCoordinator: false, heartbeatAgeMs: 100 },
      ],
      coordinatorId: 'node1',
      electionInProgress: false,
      nodeTimeoutMs: 2_500,
      now: 10_000,
    });

    assert.equal(snapshot.participants.length, 2);
    assert.deepEqual(
      snapshot.nodes.map(node => [node.id, node.players, node.masters]),
      [['node1', 1, 0], ['node2', 0, 1]],
    );
  });

  // Eje 4: es el dato con el que el coordinador decide si hace falta promover
  // a un jugador a anfitrión de la sala.
  test('cuenta las pantallas maestras vivas de todo el clúster', () => {
    const monitor = new DistributedMonitoring('node1');
    monitor.acceptRemoteReport({
      nodeId: 'node2',
      generatedAt: 10_000,
      participants: [participant({ role: 'master', nodeId: 'node2', connectionId: 'node2-master', p2pPeerId: 'p_master123' })],
    }, 'node2', 10_000);

    assert.equal(monitor.mastersOnline([participant()], 10_000), 1);
  });

  test('una maestra deja de contar cuando su nodo dejó de reportar', () => {
    const monitor = new DistributedMonitoring('node1');
    monitor.acceptRemoteReport({
      nodeId: 'node2',
      generatedAt: 10_000,
      participants: [participant({ role: 'master', nodeId: 'node2', connectionId: 'node2-master', p2pPeerId: 'p_master123' })],
    }, 'node2', 10_000);

    // El nodo de la maestra se cayó entero: su reporte queda viejo y no puede
    // seguir sosteniendo que hay alguien al mando.
    assert.equal(monitor.mastersOnline([participant()], 14_000), 0);
  });

  test('retiene temporalmente una desconexión para que el master pueda verla', () => {
    const monitor = new DistributedMonitoring('node1');
    monitor.rememberDisconnected(participant(), 10_000);

    const report = monitor.localReport([], 10_500);
    assert.equal(report.participants.length, 1);
    assert.equal(report.participants[0].status, 'offline');
    assert.equal(report.participants[0].disconnectedAt, 10_000);
  });
});


// Eje 4 (capa navegador): si se cierra la pantalla maestra —o cae el nodo
// donde vivía— la sala no puede quedarse sin nadie con permiso de continuar.
// El coordinador promueve a un jugador a ANFITRIÓN con el mismo criterio del
// Matón (gana el id más alto) y la misma regla de estabilidad.
describe('Anfitrión de la sala', () => {
  const salaCon = (...ids: string[]) => {
    const juego = new Game();
    for (const id of ids) juego.addPlayer(id, `jugador-${id}`, undefined, 'node1');
    return juego;
  };

  test('sin jugadores conectados no hay a quién promover', () => {
    assert.equal(new Game().pickHostCandidate(), null);
  });

  test('gana el id más alto, igual que el Matón entre nodos', () => {
    assert.equal(salaCon('node1-a', 'node1-c', 'node1-b').pickHostCandidate(), 'node1-c');
  });

  test('el anfitrión vigente no es destronado porque entre alguien mayor', () => {
    const juego = salaCon('node1-a', 'node1-b');
    juego.setHost(juego.pickHostCandidate(), false);
    assert.equal(juego.getHostId(), 'node1-b');

    juego.addPlayer('node1-z', 'tardón', undefined, 'node1');
    assert.equal(juego.pickHostCandidate(), 'node1-b');
  });

  test('si el anfitrión se va, la sala reelige sola', () => {
    const juego = salaCon('node1-a', 'node1-b');
    juego.setHost(juego.pickHostCandidate(), false);

    juego.removePlayer('node1-b');
    assert.equal(juego.pickHostCandidate(), 'node1-a');
  });

  test('difunde el cambio una sola vez y se retira cuando vuelve la maestra', () => {
    const juego = salaCon('node1-a');
    const difundidos: Array<{ hostId: string | null; masterOnline: boolean }> = [];
    juego.on('broadcast', (msg: S2C) => {
      if (msg.type === 'HOST_CHANGED') difundidos.push({ hostId: msg.hostId, masterOnline: msg.masterOnline });
    });

    assert.equal(juego.setHost('node1-a', false), true);
    assert.equal(juego.setHost('node1-a', false), false); // ya estaba: no repite
    assert.equal(juego.setHost(null, true), true);        // volvió la /master

    assert.deepEqual(difundidos, [
      { hostId: 'node1-a', masterOnline: false },
      { hostId: null, masterOnline: true },
    ]);
  });

  test('el anfitrión sobrevive al cambio de coordinador', () => {
    const coordinador = salaCon('node1-a', 'node1-b');
    coordinador.setHost(coordinador.pickHostCandidate(), false);

    // Un seguidor absorbe la réplica y luego gana la elección Bully: tiene que
    // saber quién puede continuar la partida.
    const seguidor = new Game();
    seguidor.restore(coordinador.snapshot());
    assert.equal(seguidor.getHostId(), 'node1-b');
  });
});


// getRandomRounds() elige las palabras de una partida del modo Clásico.
describe('Armado de una partida', () => {

  test('el modo clásico reduce progresivamente el tiempo hasta cinco segundos', () => {
    const tiempos = Array.from({ length: MAX_ROUNDS }, (_, wordsPassed) =>
      classicRoundSeconds(wordsPassed),
    );

    assert.deepEqual(tiempos, [25, 22, 19, 16, 13, 10, 7, 5]);
    assert.equal(classicRoundSeconds(MAX_ROUNDS), 5);
  });

  test('una partida no supera el máximo de rondas ni repite palabras', () => {
    // Aunque se pidan 1000, el tope manda.
    const partida = getRandomRounds(1000);

    assert.equal(partida.length, MAX_ROUNDS);
    assert.equal(new Set(partida.map(r => r.word)).size, partida.length);
  });

  test('se puede pedir una categoría, y si no existe la partida se arma igual', () => {
    const categoria = getCategoryCounts()[0].name;

    const conCategoria = getRandomRounds(6, [categoria]);
    assert.equal(conCategoria.length, 6);
    assert.ok(conCategoria.every(r => r.category === categoria));

    // Sin este respaldo, un error de tipeo dejaría al público sin jugar.
    assert.equal(getRandomRounds(4, ['Categoría inexistente']).length, 4);
  });

  test('se puede pedir una dificultad, y se completa con los niveles vecinos', () => {
    assert.ok(getRandomRounds(5, undefined, 'facil').every(r => r.difficulty === 'facil'));

    // Se piden todas las de una categoría en "difícil": no alcanzan, así que
    // completa con las vecinas en vez de devolver menos rondas.
    const categoria = getCategoryCounts()[0].name;
    const cuantas = WORD_BANK.filter(p => p.category === categoria).length;
    const partida = getRandomRounds(cuantas, [categoria], 'dificil');

    assert.equal(partida.length, Math.min(cuantas, MAX_ROUNDS));
    assert.ok(partida.every(r => r.category === categoria));
  });

  test('la partida siguiente no repite las palabras de la anterior', () => {
    const categoria = getCategoryCounts().find(c => c.count >= MAX_ROUNDS * 2)?.name;
    assert.ok(categoria, 'Hace falta una categoría con al menos dos partidas completas');

    const usadas = getRandomRounds(MAX_ROUNDS, [categoria]).map(r => r.word);
    const siguiente = getRandomRounds(MAX_ROUNDS, [categoria], undefined, usadas);

    assert.ok(siguiente.every(r => !usadas.includes(r.word)));
  });
});

// difficultyOf() clasifica por largo de palabra y getMixedQueue() arma la cola
// del modo Relajo. Son las dos piezas del banco que no pasan por getRandomRounds().
describe('Banco de palabras', () => {

  test('la dificultad se calcula por el largo y la cola no supera el banco', () => {
    assert.equal(difficultyOf('PILA'), 'facil');          // hasta 5 letras
    assert.equal(difficultyOf('ROUTER'), 'intermedio');   // de 6 a 8
    assert.equal(difficultyOf('MICROCHIP'), 'dificil');   // 9 o más
    assert.deepEqual(DIFFICULTIES, ['facil', 'intermedio', 'dificil']);
    assert.deepEqual(Object.keys(DIFFICULTY_LABEL), DIFFICULTIES);

    // Aunque se pidan más palabras de las que hay, nunca devuelve repetidas.
    assert.equal(getMixedQueue(WORD_BANK.length + 50).length, WORD_BANK.length);
  });
});
