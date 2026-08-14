import fs from 'node:fs';
import path from 'node:path';
import { GameSnapshot } from './types';

export const REPLICA_FORMAT_VERSION = 1;

export interface DurableReplica {
  formatVersion: typeof REPLICA_FORMAT_VERSION;
  clusterId: string;
  nodeId: string;
  leaderId: string;
  term: number;
  index: number;
  committedAt: number;
  snapshot: GameSnapshot;
}

function naturalNumber(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}

function isSnapshot(value: unknown): value is GameSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<GameSnapshot>;
  return typeof snapshot.phase === 'string'
    && Array.isArray(snapshot.rounds)
    && Array.isArray(snapshot.players)
    && naturalNumber(snapshot.lamport) >= 0;
}

/** Replica en disco de un backend. No depende de RAM ni del navegador. */
export class ReplicaStore {
  private current: DurableReplica | null = null;
  readonly filePath: string;

  constructor(readonly nodeId: string, readonly clusterId: string, directory: string) {
    this.filePath = path.join(directory, `${clusterId}-${nodeId}.json`);
  }

  get replica(): DurableReplica | null { return this.current; }
  get index(): number { return this.current?.index ?? 0; }
  get term(): number { return this.current?.term ?? 0; }

  load(): DurableReplica | null {
    if (!fs.existsSync(this.filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<DurableReplica>;
    if (parsed.formatVersion !== REPLICA_FORMAT_VERSION
      || parsed.clusterId !== this.clusterId
      || parsed.nodeId !== this.nodeId
      || typeof parsed.leaderId !== 'string'
      || naturalNumber(parsed.term) < 0
      || naturalNumber(parsed.index) < 0
      || naturalNumber(parsed.committedAt) < 0
      || !isSnapshot(parsed.snapshot)) {
      throw new Error(`Replica durable invalida: ${this.filePath}`);
    }
    this.current = parsed as DurableReplica;
    return this.current;
  }

  commit(input: Omit<DurableReplica, 'formatVersion' | 'clusterId' | 'nodeId' | 'committedAt'>): DurableReplica {
    if (!Number.isSafeInteger(input.term) || input.term < 0) throw new Error('Termino de replica invalido');
    if (!Number.isSafeInteger(input.index) || input.index < 1) throw new Error('Indice de replica invalido');
    if (this.current && input.term < this.current.term) return this.current;
    if (this.current && input.term === this.current.term && input.index < this.current.index) return this.current;

    const replica: DurableReplica = {
      formatVersion: REPLICA_FORMAT_VERSION,
      clusterId: this.clusterId,
      nodeId: this.nodeId,
      leaderId: input.leaderId,
      term: input.term,
      index: input.index,
      committedAt: Date.now(),
      snapshot: input.snapshot,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(replica), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, this.filePath);
    } catch {
      try { fs.unlinkSync(this.filePath); } catch { /* no existia */ }
      fs.renameSync(temporary, this.filePath);
    }
    this.current = replica;
    return replica;
  }
}
