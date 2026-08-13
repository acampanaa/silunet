/**
 * Pruebas unitarias de Silunet — 12 pruebas sobre los tres módulos donde vive
 * la lógica cuyo fallo arruinaría una partida:
 *
 *   lamport.ts   ordena los aciertos entre nodos
 *   mutex.ts     evita que dos aciertos simultáneos se pisen
 *   wordBank.ts  elige las palabras de cada ronda
 *
 * Ejecutar con:  npm run test:unit
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LamportClock } from '../../src/lamport';
import { Mutex } from '../../src/mutex';
import { classicRoundSeconds } from '../../src/game';
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
