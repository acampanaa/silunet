import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';
import {
  PersistenceStore,
  JugadorIdentidad,
  SavedGame,
  StoredAvatar,
  normalizeAvatarId,
} from './db';
import { GameOverResult, HallOfFameEntry, Perfil, PerfilReciente, RecentGame } from './types';

const CLUSTER_ID = process.env.CLUSTER_ID ?? 'silunet-main';
const LEASE_SECONDS = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanNick(nick: string): string {
  return nick.trim().slice(0, 20) || 'Anónimo';
}

function cleanLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(value) || 1));
}

/**
 * Persistencia compartida y consistente para todos los nodos.
 *
 * Las lecturas pueden ejecutarse desde cualquier nodo. Las escrituras toman un
 * bloqueo corto sobre la fila de liderazgo y verifican node_id + term + lease;
 * así un coordinador antiguo no puede escribir después de un split-brain.
 */
export class PostgresStore implements PersistenceStore {
  readonly mode = 'postgres' as const;
  private readonly pool: Pool;
  private currentTerm: number | null = null;

  constructor(connectionString: string, private readonly nodeId: string) {
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_SIZE ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 7_000,
      application_name: `silunet-${nodeId}`,
      options: '-c statement_timeout=10000',
    });
    this.pool.on('error', err => console.error(`[${this.nodeId}] PostgreSQL pool:`, err.message));
  }

  async init(): Promise<void> {
    const schemaPath = path.join(__dirname, '..', 'BDD.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');
    const client = await this.pool.connect();
    try {
      // Los nodos suelen arrancar a la vez. El bloqueo de sesión serializa el
      // DDL para evitar carreras entre CREATE TABLE/INDEX concurrentes.
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${CLUSTER_ID}:schema`]);
      await client.query(schema);
      await client.query('SELECT 1');
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${CLUSTER_ID}:schema`]).catch(() => undefined);
      client.release();
    }
  }

  async claimLeadership(): Promise<boolean> {
    await this.pool.query(
      `INSERT INTO cluster_leader (cluster_id, node_id, term, lease_until)
       VALUES ($1, '', 0, '-infinity')
       ON CONFLICT (cluster_id) DO NOTHING`,
      [CLUSTER_ID],
    );
    const result = await this.pool.query<{ term: string }>(
      `UPDATE cluster_leader
          SET node_id = $2,
              term = term + 1,
              lease_until = clock_timestamp() + ($3 * interval '1 second'),
              updated_at = clock_timestamp()
        WHERE cluster_id = $1
          AND (lease_until < clock_timestamp() OR node_id = $2)
      RETURNING term::text`,
      [CLUSTER_ID, this.nodeId, LEASE_SECONDS],
    );
    if (result.rowCount !== 1) return false;
    this.currentTerm = Number(result.rows[0].term);
    return true;
  }

  async renewLeadership(): Promise<boolean> {
    if (this.currentTerm === null) return false;
    const result = await this.pool.query(
      `UPDATE cluster_leader
          SET lease_until = clock_timestamp() + ($4 * interval '1 second'),
              updated_at = clock_timestamp()
        WHERE cluster_id = $1 AND node_id = $2 AND term = $3`,
      [CLUSTER_ID, this.nodeId, this.currentTerm, LEASE_SECONDS],
    );
    if (result.rowCount !== 1) this.currentTerm = null;
    return result.rowCount === 1;
  }

  private async assertLeadership(client: PoolClient): Promise<void> {
    if (this.currentTerm === null) throw new Error('Este nodo no posee una concesión PostgreSQL de escritura');
    const result = await client.query<{ valid: boolean }>(
      `SELECT node_id = $2 AND term = $3 AND lease_until >= clock_timestamp() AS valid
         FROM cluster_leader
        WHERE cluster_id = $1
        FOR UPDATE`,
      [CLUSTER_ID, this.nodeId, this.currentTerm],
    );
    if (result.rowCount !== 1 || !result.rows[0].valid) {
      this.currentTerm = null;
      throw new Error('Concesión PostgreSQL vencida o reemplazada por otro coordinador');
    }
  }

  private async writeTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLeadership(client);
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findOrCreatePlayer(token: string | null, nick: string, avatarId?: number): Promise<JugadorIdentidad> {
    const nextNick = cleanNick(nick);
    const requestedAvatar = normalizeAvatarId(avatarId);
    return this.writeTransaction(async client => {
      if (token && UUID_RE.test(token)) {
        const existing = await client.query<{ token: string; avatar_id: number; avatar_key: string | null }>(
          'SELECT token::text, avatar_id, avatar_key::text FROM jugadores WHERE token = $1::uuid',
          [token],
        );
        if (existing.rowCount === 1) {
          const nextAvatar = requestedAvatar ?? existing.rows[0].avatar_id;
          await client.query(
            'UPDATE jugadores SET nick = $2, avatar_id = $3 WHERE token = $1::uuid',
            [token, nextNick, nextAvatar],
          );
          return {
            token,
            nick: nextNick,
            avatarId: nextAvatar,
            avatarKey: existing.rows[0].avatar_key ?? undefined,
            returning: true,
          };
        }
      }

      const newToken = randomUUID();
      const newAvatar = requestedAvatar ?? 0;
      await client.query(
        `INSERT INTO jugadores (token, nick, avatar_id)
         VALUES ($1::uuid, $2, $3)`,
        [newToken, nextNick, newAvatar],
      );
      return { token: newToken, nick: nextNick, avatarId: newAvatar, returning: false };
    });
  }

  async setAvatar(token: string, avatarId: number): Promise<number | null> {
    if (!UUID_RE.test(token)) return null;
    const clean = normalizeAvatarId(avatarId) ?? 0;
    return this.writeTransaction(async client => {
      const result = await client.query(
        `UPDATE jugadores
            SET avatar_id = $2, avatar_key = NULL, avatar_mime = NULL, avatar_data = NULL
          WHERE token = $1::uuid`,
        [token, clean],
      );
      return result.rowCount === 1 ? clean : null;
    });
  }

  async setCustomAvatar(token: string, mime: 'image/jpeg', data: Buffer): Promise<string | null> {
    if (!UUID_RE.test(token)) return null;
    const key = randomUUID();
    return this.writeTransaction(async client => {
      const result = await client.query<{ avatar_key: string }>(
        `UPDATE jugadores
            SET avatar_key = $2::uuid, avatar_mime = $3, avatar_data = $4
          WHERE token = $1::uuid
        RETURNING avatar_key::text`,
        [token, key, mime, data],
      );
      return result.rowCount === 1 ? result.rows[0].avatar_key : null;
    });
  }

  async getAvatar(key: string): Promise<StoredAvatar | null> {
    if (!UUID_RE.test(key)) return null;
    const result = await this.pool.query<{ avatar_mime: string; avatar_data: Buffer }>(
      `SELECT avatar_mime, avatar_data
         FROM jugadores
        WHERE avatar_key = $1::uuid AND avatar_data IS NOT NULL`,
      [key],
    );
    if (result.rowCount !== 1 || result.rows[0].avatar_mime !== 'image/jpeg') return null;
    return { mime: 'image/jpeg', data: result.rows[0].avatar_data };
  }

  async updateIdentity(token: string, nick: string, avatarId?: number): Promise<void> {
    if (!UUID_RE.test(token)) return;
    const nextNick = cleanNick(nick);
    const nextAvatar = normalizeAvatarId(avatarId);
    await this.writeTransaction(async client => {
      if (nextAvatar === null) {
        await client.query('UPDATE jugadores SET nick = $2 WHERE token = $1::uuid', [token, nextNick]);
      } else {
        await client.query(
          'UPDATE jugadores SET nick = $2, avatar_id = $3 WHERE token = $1::uuid',
          [token, nextNick, nextAvatar],
        );
      }
    });
  }

  async saveGameResult(result: GameOverResult): Promise<SavedGame> {
    const standings = result.standings
      .filter(s => !!s.token && UUID_RE.test(s.token!))
      .sort((a, b) => a.token!.localeCompare(b.token!));

    return this.writeTransaction(async client => {
      const tokens = standings.map(s => s.token!);
      if (tokens.length > 0) {
        const known = await client.query<{ token: string }>(
          'SELECT token::text FROM jugadores WHERE token = ANY($1::uuid[])',
          [tokens],
        );
        if (known.rowCount !== tokens.length) {
          throw new Error('No se puede cerrar la partida: falta una identidad persistente en PostgreSQL');
        }
      }

      await client.query(
        `INSERT INTO partidas (id, nombre, total_rondas)
         VALUES ($1::uuid, 'Casa Abierta', $2)
         ON CONFLICT (id) DO NOTHING`,
        [result.gameId, result.totalRounds],
      );
      const gameRow = await client.query<{ numero: string; nombre: string }>(
        `UPDATE partidas
            SET nombre = 'Casa Abierta #' || numero::text
          WHERE id = $1::uuid
        RETURNING numero::text, nombre`,
        [result.gameId],
      );
      if (gameRow.rowCount !== 1) throw new Error('No se pudo confirmar la partida en PostgreSQL');

      if (standings.length > 0) {
        const params: unknown[] = [];
        const values = standings.map((standing, index) => {
          const base = index * 5;
          params.push(result.gameId, standing.token!, standing.score, standing.position, standing.medalla);
          return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5})`;
        });
        await client.query(
          `INSERT INTO participaciones (partida_id, jugador_token, puntos, puesto, medalla)
           VALUES ${values.join(', ')}
           ON CONFLICT (partida_id, jugador_token) DO UPDATE
             SET puntos = EXCLUDED.puntos,
                 puesto = EXCLUDED.puesto,
                 medalla = EXCLUDED.medalla`,
          params,
        );
      }

      return {
        name: gameRow.rows[0].nombre,
        number: Number(gameRow.rows[0].numero),
        savedPlayers: standings.length,
      };
    });
  }

  async getProfile(token: string): Promise<Perfil | null> {
    if (!UUID_RE.test(token)) return null;
    const player = await this.pool.query<{
      nick: string; avatar_id: number; avatar_key: string | null; creado_en: Date;
      jugadas: string; ganadas: string; puntos: string; oro: string; plata: string; bronce: string;
    }>(
      `SELECT j.nick, j.avatar_id, j.avatar_key::text, j.creado_en,
              COUNT(pt.partida_id)::text AS jugadas,
              COUNT(*) FILTER (WHERE pt.puesto = 1)::text AS ganadas,
              COALESCE(SUM(pt.puntos), 0)::text AS puntos,
              COUNT(*) FILTER (WHERE pt.medalla = 'oro')::text AS oro,
              COUNT(*) FILTER (WHERE pt.medalla = 'plata')::text AS plata,
              COUNT(*) FILTER (WHERE pt.medalla = 'bronce')::text AS bronce
         FROM jugadores j
         LEFT JOIN participaciones pt ON pt.jugador_token = j.token
        WHERE j.token = $1::uuid
        GROUP BY j.token`,
      [token],
    );
    if (player.rowCount !== 1) return null;

    const recent = await this.pool.query<PerfilReciente>(
      `SELECT pa.nombre AS partida, pt.puesto, pt.puntos, pt.medalla
         FROM participaciones pt
         JOIN partidas pa ON pa.id = pt.partida_id
        WHERE pt.jugador_token = $1::uuid
        ORDER BY pa.numero DESC
        LIMIT 5`,
      [token],
    );
    const row = player.rows[0];
    return {
      nick: row.nick,
      avatarId: row.avatar_id,
      avatarKey: row.avatar_key ?? undefined,
      creadoEn: row.creado_en.toISOString(),
      partidasJugadas: Number(row.jugadas),
      partidasGanadas: Number(row.ganadas),
      puntosAcumulados: Number(row.puntos),
      medallas: { oro: Number(row.oro), plata: Number(row.plata), bronce: Number(row.bronce) },
      recientes: recent.rows,
    };
  }

  async getHallOfFame(limit = 10): Promise<HallOfFameEntry[]> {
    const result = await this.pool.query<{
      nick: string; avatar_id: number; avatar_key: string | null; partidas_jugadas: string; puntos_acumulados: string;
      oro: string; plata: string; bronce: string;
    }>(
      `SELECT j.nick, j.avatar_id, j.avatar_key::text,
              COUNT(*)::text AS partidas_jugadas,
              COALESCE(SUM(pt.puntos), 0)::text AS puntos_acumulados,
              COUNT(*) FILTER (WHERE pt.medalla = 'oro')::text AS oro,
              COUNT(*) FILTER (WHERE pt.medalla = 'plata')::text AS plata,
              COUNT(*) FILTER (WHERE pt.medalla = 'bronce')::text AS bronce
         FROM participaciones pt
         JOIN jugadores j ON j.token = pt.jugador_token
        GROUP BY j.token
        ORDER BY SUM(pt.puntos) DESC, j.nick ASC
        LIMIT $1`,
      [cleanLimit(limit, 100)],
    );
    return result.rows.map(row => ({
      nick: row.nick,
      avatarId: row.avatar_id,
      avatarKey: row.avatar_key ?? undefined,
      partidasJugadas: Number(row.partidas_jugadas),
      puntosAcumulados: Number(row.puntos_acumulados),
      oro: Number(row.oro),
      plata: Number(row.plata),
      bronce: Number(row.bronce),
    }));
  }

  async getRecentGames(limit = 6): Promise<RecentGame[]> {
    const result = await this.pool.query<{
      nombre: string; jugada_en: Date; total_rondas: number; ganador: string | null;
    }>(
      `SELECT pa.nombre, pa.jugada_en, pa.total_rondas,
              winner.nick AS ganador
         FROM partidas pa
         LEFT JOIN participaciones first_place
           ON first_place.partida_id = pa.id AND first_place.puesto = 1
         LEFT JOIN jugadores winner ON winner.token = first_place.jugador_token
        ORDER BY pa.numero DESC
        LIMIT $1`,
      [cleanLimit(limit, 100)],
    );
    return result.rows.map(row => ({
      nombre: row.nombre,
      jugadaEn: row.jugada_en.toISOString(),
      totalRondas: row.total_rondas,
      ganador: row.ganador,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
