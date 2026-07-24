/**
 * Eje 3 — Exclusión Mutua Centralizada (candado lógico / token con cola FIFO).
 *
 * El coordinador es el único que muta el marcador compartido. Para que ese
 * acceso esté SERIALIZADO de forma explícita —y no dependa implícitamente del
 * bucle de eventos de Node— toda secuencia lectura-modificación-escritura del
 * marcador se ejecuta dentro de runExclusive():
 *
 *   - quien encuentra el token libre entra de inmediato;
 *   - si está tomado, el solicitante espera en una cola FIFO;
 *   - al liberarse, el token se entrega al siguiente en orden de llegada.
 *
 * Así, cuando dos aciertos concurrentes (p.ej. de jugadores en nodos distintos)
 * llegan al coordinador, sus actualizaciones del marcador no se entrelazan: se
 * procesan una a una, en orden, sin perder ni duplicar puntajes.
 *
 * Extiende EventEmitter solo para que el panel didáctico de /master pueda
 * mostrar en vivo el momento exacto en que dos aciertos concurrentes chocan
 * contra el candado — el resto de la clase no depende de esto en nada.
 */
import { EventEmitter } from 'events';

export class Mutex extends EventEmitter {
  private locked = false;
  private queue: Array<() => void> = [];

  constructor(private readonly name = 'recurso') { super(); }

  private acquire(owner: string): Promise<void> {
    return new Promise(resolve => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        console.log(`[Eje 3] '${this.name}' ocupado -> '${owner}' encolado (FIFO, ${this.queue.length + 1} en espera)`);
        this.emit('queued', this.queue.length + 1);
        this.queue.push(resolve);
      }
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();          // entrega el token al siguiente de la cola
    else this.locked = false;  // nadie espera: el recurso queda libre
  }

  /** Ejecuta `fn` en exclusión mutua sobre el recurso. */
  async runExclusive<T>(owner: string, fn: () => T): Promise<T> {
    await this.acquire(owner);
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  get waiting(): number { return this.queue.length; }
}
