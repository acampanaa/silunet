import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Perfil, PerfilReciente, HallOfFameEntry, RecentGame } from './types';

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
  avatarId: number;
  returning: boolean; // true = ya existía (token reconocido) → "¡Hola de nuevo!"
}

// Debe coincidir con la cantidad de avatares de public/avatars.js. Solo viaja
// el índice por la red; el dibujo lo arma el cliente.
export const AVATAR_COUNT = 12;

/**
 * Devuelve un índice de avatar válido, o `null` si no vino ninguno (para poder
 * distinguir "no lo mandó" de "eligió el 0" y no pisar el que ya tenía).
 */
export function normalizeAvatarId(id: unknown): number | null {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0 || n >= AVATAR_COUNT) return null;
  return n;
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

    // Avatar del jugador. Va como ALTER separado (y no dentro del CREATE de
    // arriba) para que las DB creadas por v2 —que ya tienen jugadores sin esta
    // columna— sigan abriendo sin borrarse.
    this.addColumnIfMissing('jugadores', 'avatar_id', 'INTEGER NOT NULL DEFAULT 0');
  }

  /** SQLite no tiene "ADD COLUMN IF NOT EXISTS": hay que mirar el pragma. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some(c => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * Identidad persistente. Si el celular trae un token reconocido, devuelve su
   * jugador (returning=true) y refresca el nick si lo cambió. Si no trae token o
   * no se reconoce, crea un jugador nuevo y genera un token para que el celular
   * lo guarde en localStorage.
   */
  findOrCreatePlayer(token: string | null, nick: string, avatarId?: number): JugadorIdentidad {
    const cleanNick = nick.trim().slice(0, 20) || 'Anónimo';
    // El avatar puede no venir (cliente viejo, o reconexión que no lo reenvía):
    // en ese caso se conserva el que ya tenía guardado en vez de pisarlo con 0.
    const cleanAvatar = normalizeAvatarId(avatarId);

    if (token) {
      const row = this.db.prepare('SELECT id, nick, avatar_id FROM jugadores WHERE token = ?').get(token) as
        | { id: number; nick: string; avatar_id: number }
        | undefined;
      if (row) {
        const nextAvatar = cleanAvatar ?? row.avatar_id;
        if (row.nick !== cleanNick || nextAvatar !== row.avatar_id) {
          this.db
            .prepare('UPDATE jugadores SET nick = ?, avatar_id = ? WHERE id = ?')
            .run(cleanNick, nextAvatar, row.id);
        }
        return { token, nick: cleanNick, avatarId: nextAvatar, returning: true };
      }
    }

    const newToken = randomUUID();
    const newAvatar = cleanAvatar ?? 0;
    this.db
      .prepare('INSERT INTO jugadores (token, nick, avatar_id, creado_en) VALUES (?, ?, ?, ?)')
      .run(newToken, cleanNick, newAvatar, new Date().toISOString());
    return { token: newToken, nick: cleanNick, avatarId: newAvatar, returning: false };
  }

  /** Cambia solo el avatar de una identidad ya existente. */
  setAvatar(token: string, avatarId: number): number | null {
    const clean = normalizeAvatarId(avatarId) ?? 0;
    const info = this.db.prepare('UPDATE jugadores SET avatar_id = ? WHERE token = ?').run(clean, token);
    return info.changes > 0 ? clean : null;
  }

  /**
   * Refresca nick/avatar de una identidad ya conocida, sin crearla.
   *
   * Hace falta en la RECONEXIÓN EN VIVO (ver resolveJoin): ese camino retoma al
   * jugador desde memoria y no pasa por findOrCreatePlayer, así que sin esto un
   * cambio de avatar hecho al reconectarse se veía en el ranking pero nunca
   * llegaba a la DB — y el perfil seguía mostrando el anterior.
   *
   * Si el token no existe en la DB de ESTE nodo (caso failover: cada nodo tiene
   * su propio archivo SQLite), no hace nada. Es lo correcto: no queremos
   * inventar una identidad a medias en un nodo que nunca vio a este jugador.
   */
  updateIdentity(token: string, nick: string, avatarId?: number): void {
    const cleanNick   = nick.trim().slice(0, 20) || 'Anónimo';
    const cleanAvatar = normalizeAvatarId(avatarId);
    if (cleanAvatar === null) {
      this.db.prepare('UPDATE jugadores SET nick = ? WHERE token = ?').run(cleanNick, token);
    } else {
      this.db
        .prepare('UPDATE jugadores SET nick = ?, avatar_id = ? WHERE token = ?')
        .run(cleanNick, cleanAvatar, token);
    }
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
      .prepare('SELECT id, nick, avatar_id, creado_en FROM jugadores WHERE token = ?')
      .get(token) as { id: number; nick: string; avatar_id: number; creado_en: string } | undefined;
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
      avatarId: jugador.avatar_id,
      creadoEn: jugador.creado_en,
      partidasJugadas: agg.jugadas,
      partidasGanadas: agg.ganadas,
      puntosAcumulados: agg.puntos,
      medallas: { oro: agg.oro, plata: agg.plata, bronce: agg.bronce },
      recientes,
    };
  }

  /**
   * v2.1 — "Salón de la fama": ranking acumulado de TODAS las Casa Abierta
   * jugadas hasta ahora (no solo la partida en curso). Reusa exactamente las
   * mismas tablas del historial de perfil, solo que agregado por jugador en
   * vez de filtrado por token.
   */
  getHallOfFame(limit = 10): HallOfFameEntry[] {
    return this.db
      .prepare(
        `SELECT
           j.nick                                                       AS nick,
           j.avatar_id                                                  AS avatarId,
           COUNT(*)                                                     AS partidasJugadas,
           COALESCE(SUM(pt.puntos), 0)                                  AS puntosAcumulados,
           COALESCE(SUM(CASE WHEN pt.medalla = 'oro'    THEN 1 ELSE 0 END), 0) AS oro,
           COALESCE(SUM(CASE WHEN pt.medalla = 'plata'  THEN 1 ELSE 0 END), 0) AS plata,
           COALESCE(SUM(CASE WHEN pt.medalla = 'bronce' THEN 1 ELSE 0 END), 0) AS bronce
         FROM participaciones pt
         JOIN jugadores j ON j.id = pt.jugador_id
         GROUP BY pt.jugador_id
         ORDER BY puntosAcumulados DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as HallOfFameEntry[];
  }

  /** Últimas partidas jugadas (Casa Abierta #N), con quién ganó cada una. */
  getRecentGames(limit = 6): RecentGame[] {
    return this.db
      .prepare(
        `SELECT
           pa.nombre                            AS nombre,
           pa.jugada_en                         AS jugadaEn,
           pa.total_rondas                      AS totalRondas,
           (SELECT j.nick FROM participaciones pt
              JOIN jugadores j ON j.id = pt.jugador_id
              WHERE pt.partida_id = pa.id AND pt.puesto = 1
              LIMIT 1)                          AS ganador
         FROM partidas pa
         ORDER BY pa.id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as RecentGame[];
  }

  close(): void {
    this.db.close();
  }
}
