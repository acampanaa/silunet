import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Perfil, PerfilReciente } from './types';

// ── v2: Persistencia (identidad e historia del jugador) ──────────────────────
//
// Esta capa NO participa de la partida en vivo. El estado vivo (ronda actual,
// marcador, coordinación entre nodos) vive en memoria + se replica entre nodos
// (Ejes 2/3/4). Aquí solo se guarda HISTORIA ya cerrada:
//   - quién es cada jugador (token persistente guardado en su propio celular),
//   - qué partidas jugó, cuántas ganó, puntos acumulados, medallas.
//
// Regla distribuida: solo el nodo COORDINADOR electo escribe. Así la persistencia
// DEPENDE de la lógica distribuida (Eje 4) en lugar de competir con ella.
// Un GUESS nunca consulta esta DB: la identidad se resuelve al unirse y el perfil
// se lee solo cuando el celular abre su pantalla de perfil.

export interface JugadorIdentidad {
  token: string;
  nick: string;
  returning: boolean; // true = ya existía (token reconocido) → "¡Hola de nuevo!"
}

export interface ResultadoParticipacion {
  token: string;
  puntos: number;
  puesto: number;            // 1 = ganó la partida
  medalla: 'oro' | 'plata' | 'bronce' | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    // Asegurar el directorio (ej. data/) antes de abrir el archivo.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;'); // escrituras rápidas y seguras
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jugadores (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        token     TEXT UNIQUE NOT NULL,
        nick      TEXT NOT NULL,
        creado_en TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS partidas (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre       TEXT NOT NULL,
        total_rondas INTEGER NOT NULL,
        jugada_en    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participaciones (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        jugador_id INTEGER NOT NULL REFERENCES jugadores(id),
        partida_id INTEGER NOT NULL REFERENCES partidas(id),
        puntos     INTEGER NOT NULL,
        puesto     INTEGER NOT NULL,
        medalla    TEXT,
        UNIQUE (jugador_id, partida_id)
      );
    `);
  }

  /**
   * Identidad persistente. Si el celular trae un token reconocido, devuelve su
   * jugador (returning=true) y refresca el nick si lo cambió. Si no trae token o
   * no se reconoce, crea un jugador nuevo y genera un token para que el celular
   * lo guarde en localStorage.
   */
  findOrCreatePlayer(token: string | null, nick: string): JugadorIdentidad {
    const cleanNick = nick.trim().slice(0, 20) || 'Anónimo';

    if (token) {
      const row = this.db.prepare('SELECT id, nick FROM jugadores WHERE token = ?').get(token) as
        | { id: number; nick: string }
        | undefined;
      if (row) {
        if (row.nick !== cleanNick) {
          this.db.prepare('UPDATE jugadores SET nick = ? WHERE id = ?').run(cleanNick, row.id);
        }
        return { token, nick: cleanNick, returning: true };
      }
    }

    const newToken = randomUUID();
    this.db
      .prepare('INSERT INTO jugadores (token, nick, creado_en) VALUES (?, ?, ?)')
      .run(newToken, cleanNick, new Date().toISOString());
    return { token: newToken, nick: cleanNick, returning: false };
  }

  /** Cuántas partidas se han guardado (para numerar la siguiente). */
  countPartidas(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM partidas').get() as { n: number };
    return row.n;
  }

  /** Registra una partida cerrada y devuelve su id (para las participaciones). */
  createPartida(nombre: string, totalRondas: number): number {
    const info = this.db
      .prepare('INSERT INTO partidas (nombre, total_rondas, jugada_en) VALUES (?, ?, ?)')
      .run(nombre, totalRondas, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  /** Guarda el resultado de un jugador en una partida ya cerrada. */
  recordParticipacion(partidaId: number, r: ResultadoParticipacion): void {
    const jugador = this.db.prepare('SELECT id FROM jugadores WHERE token = ?').get(r.token) as
      | { id: number }
      | undefined;
    if (!jugador) return; // jugador sin identidad persistente (no debería pasar)

    this.db
      .prepare(
        `INSERT OR IGNORE INTO participaciones (jugador_id, partida_id, puntos, puesto, medalla)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jugador.id, partidaId, r.puntos, r.puesto, r.medalla);
  }

  /** Perfil agregado de un jugador. Las stats se CALCULAN, no se almacenan. */
  getProfile(token: string): Perfil | null {
    const jugador = this.db
      .prepare('SELECT id, nick, creado_en FROM jugadores WHERE token = ?')
      .get(token) as { id: number; nick: string; creado_en: string } | undefined;
    if (!jugador) return null;

    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*)                                    AS jugadas,
           COALESCE(SUM(CASE WHEN puesto = 1 THEN 1 ELSE 0 END), 0) AS ganadas,
           COALESCE(SUM(puntos), 0)                    AS puntos,
           COALESCE(SUM(CASE WHEN medalla = 'oro'    THEN 1 ELSE 0 END), 0) AS oro,
           COALESCE(SUM(CASE WHEN medalla = 'plata'  THEN 1 ELSE 0 END), 0) AS plata,
           COALESCE(SUM(CASE WHEN medalla = 'bronce' THEN 1 ELSE 0 END), 0) AS bronce
         FROM participaciones WHERE jugador_id = ?`,
      )
      .get(jugador.id) as {
      jugadas: number; ganadas: number; puntos: number;
      oro: number; plata: number; bronce: number;
    };

    const recientes = this.db
      .prepare(
        `SELECT pa.nombre AS partida, pt.puesto, pt.puntos, pt.medalla
         FROM participaciones pt
         JOIN partidas pa ON pa.id = pt.partida_id
         WHERE pt.jugador_id = ?
         ORDER BY pt.id DESC
         LIMIT 5`,
      )
      .all(jugador.id) as unknown as PerfilReciente[];

    return {
      nick: jugador.nick,
      creadoEn: jugador.creado_en,
      partidasJugadas: agg.jugadas,
      partidasGanadas: agg.ganadas,
      puntosAcumulados: agg.puntos,
      medallas: { oro: agg.oro, plata: agg.plata, bronce: agg.bronce },
      recientes,
    };
  }

  close(): void {
    this.db.close();
  }
}
