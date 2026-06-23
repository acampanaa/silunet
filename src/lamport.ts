/**
 * Eje 2 — Reloj de Lamport
 *
 * Reglas:
 *  - Evento interno:          tick()           → clock++
 *  - Enviar mensaje:          tick()           → clock++, adjuntar valor al mensaje
 *  - Recibir mensaje:         update(received) → clock = max(clock, received) + 1
 *
 * Esto garantiza: si A ocurrió antes que B (A → B), entonces L(A) < L(B).
 * La condición inversa no se cumple (causalidad parcial, no total), pero es
 * suficiente para ordenar aciertos de forma consistente entre nodos.
 */
export class LamportClock {
  private t = 0;

  /** Evento local — incrementa y devuelve el nuevo valor. */
  tick(): number {
    return ++this.t;
  }

  /**
   * Recepción de mensaje — sincroniza con el remitente y avanza un paso.
   * Devuelve el timestamp oficial del evento de recepción.
   */
  update(received: number): number {
    this.t = Math.max(this.t, received) + 1;
    return this.t;
  }

  get value(): number { return this.t; }
}
