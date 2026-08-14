import {
  DistributedMonitorSnapshot,
  MonitorNode,
  MonitorNodeReport,
  MonitorParticipant,
} from './types';

export const MONITOR_HEARTBEAT_INTERVAL_MS = 1000;
export const MONITOR_CLIENT_TIMEOUT_MS = 2000;
export const MONITOR_PEER_TIMEOUT_MS = 3500;
export const MONITOR_SERVER_TIMEOUT_MS = 3200;

const WARNING_AFTER_MS = 1250;
const REPORT_TIMEOUT_MS = 3000;
const DISCONNECTED_RETENTION_MS = 12_000;

interface RemoteReport {
  report: MonitorNodeReport;
  receivedAt: number;
}

interface SnapshotInput {
  localParticipants: MonitorParticipant[];
  clusterNodes: Array<{
    id: string;
    up: boolean;
    isCoordinator: boolean;
    heartbeatAgeMs: number | null;
  }>;
  coordinatorId: string;
  electionInProgress: boolean;
  nodeTimeoutMs: number;
  now?: number;
}

/**
 * Agrega la telemetria local y los reportes recibidos de los demas nodos.
 * Mantiene una ventana corta de desconectados para que una baja sea visible en
 * /master en lugar de desaparecer de la interfaz en el mismo instante.
 */
export class DistributedMonitoring {
  private readonly remoteReports = new Map<string, RemoteReport>();
  private readonly disconnected = new Map<string, MonitorParticipant>();

  constructor(readonly nodeId: string) {}

  statusForAge(ageMs: number): MonitorParticipant['status'] {
    if (ageMs >= MONITOR_CLIENT_TIMEOUT_MS) return 'offline';
    if (ageMs >= WARNING_AFTER_MS) return 'warning';
    return 'healthy';
  }

  rememberDisconnected(participant: MonitorParticipant, now = Date.now()): void {
    const key = this.identityKey(participant);
    this.disconnected.set(key, {
      ...participant,
      heartbeatAgeMs: Math.max(participant.heartbeatAgeMs, now - participant.lastSeenAt),
      status: 'offline',
      disconnectedAt: now,
    });
  }

  localReport(active: MonitorParticipant[], now = Date.now()): MonitorNodeReport {
    this.prune(now);
    const activeKeys = new Set(active.map(participant => this.identityKey(participant)));
    const retained = [...this.disconnected.entries()]
      .filter(([key]) => !activeKeys.has(key))
      .map(([, participant]) => ({
        ...participant,
        heartbeatAgeMs: Math.max(participant.heartbeatAgeMs, now - participant.lastSeenAt),
      }));
    return {
      nodeId: this.nodeId,
      generatedAt: now,
      participants: [...active, ...retained],
    };
  }

  acceptRemoteReport(report: MonitorNodeReport, fromNodeId: string, now = Date.now()): void {
    if (report.nodeId !== fromNodeId || report.nodeId === this.nodeId) return;
    this.remoteReports.set(fromNodeId, { report, receivedAt: now });
  }

  /**
   * Eje 4: cuántas pantallas maestras siguen vivas en TODO el clúster, no solo
   * en este nodo. Es el dato con el que el coordinador decide si hace falta
   * promover a un jugador a anfitrión de la sala.
   */
  mastersOnline(localParticipants: MonitorParticipant[], now = Date.now()): number {
    return this.mergeParticipants(this.allReports(localParticipants, now), now)
      .filter(participant => participant.role === 'master' && participant.status !== 'offline')
      .length;
  }

  snapshot(input: SnapshotInput): DistributedMonitorSnapshot {
    const now = input.now ?? Date.now();
    const participants = this.mergeParticipants(this.allReports(input.localParticipants, now), now);
    const counts = new Map<string, { clients: number; players: number; masters: number }>();
    for (const participant of participants) {
      if (participant.status === 'offline') continue;
      const node = counts.get(participant.nodeId) ?? { clients: 0, players: 0, masters: 0 };
      node.clients++;
      if (participant.role === 'player') node.players++;
      else node.masters++;
      counts.set(participant.nodeId, node);
    }

    const nodes: MonitorNode[] = input.clusterNodes.map(node => ({
      ...node,
      ...(counts.get(node.id) ?? { clients: 0, players: 0, masters: 0 }),
    }));

    return {
      generatedAt: now,
      coordinatorId: input.coordinatorId,
      electionInProgress: input.electionInProgress,
      participants,
      nodes,
      thresholds: {
        heartbeatIntervalMs: MONITOR_HEARTBEAT_INTERVAL_MS,
        clientTimeoutMs: MONITOR_CLIENT_TIMEOUT_MS,
        peerTimeoutMs: MONITOR_PEER_TIMEOUT_MS,
        nodeTimeoutMs: input.nodeTimeoutMs,
        serverTimeoutMs: MONITOR_SERVER_TIMEOUT_MS,
      },
    };
  }

  /** Reporte local + los recibidos de los demás nodos, listos para fusionar. */
  private allReports(localParticipants: MonitorParticipant[], now: number): RemoteReport[] {
    const reports: RemoteReport[] = [{
      report: this.localReport(localParticipants, now),
      receivedAt: now,
    }];
    for (const remote of this.remoteReports.values()) reports.push(remote);
    return reports;
  }

  private mergeParticipants(reports: RemoteReport[], now: number): MonitorParticipant[] {
    const merged = new Map<string, MonitorParticipant>();
    for (const { report, receivedAt } of reports) {
      const reportAge = Math.max(0, now - receivedAt);
      for (const source of report.participants) {
        const heartbeatAgeMs = Math.max(0, source.heartbeatAgeMs + reportAge);
        const staleReport = reportAge >= REPORT_TIMEOUT_MS;
        const participant: MonitorParticipant = {
          ...source,
          heartbeatAgeMs,
          status: source.disconnectedAt || staleReport
            ? 'offline'
            : this.statusForAge(heartbeatAgeMs),
        };
        const key = this.identityKey(participant);
        const current = merged.get(key);
        if (!current || this.isBetterCandidate(participant, current)) merged.set(key, participant);
      }
    }
    return [...merged.values()].sort((a, b) => {
      const roleOrder = a.role.localeCompare(b.role);
      return roleOrder || a.nick.localeCompare(b.nick, 'es') || a.connectionId.localeCompare(b.connectionId);
    });
  }

  private isBetterCandidate(candidate: MonitorParticipant, current: MonitorParticipant): boolean {
    if (candidate.status !== 'offline' && current.status === 'offline') return true;
    if (candidate.status === 'offline' && current.status !== 'offline') return false;
    return candidate.lastSeenAt > current.lastSeenAt;
  }

  private identityKey(participant: MonitorParticipant): string {
    return participant.p2pPeerId || participant.playerId || participant.connectionId;
  }

  private prune(now: number): void {
    for (const [key, participant] of this.disconnected) {
      if (now - (participant.disconnectedAt ?? now) > DISCONNECTED_RETENTION_MS) {
        this.disconnected.delete(key);
      }
    }
    for (const [nodeId, remote] of this.remoteReports) {
      if (now - remote.receivedAt > DISCONNECTED_RETENTION_MS) this.remoteReports.delete(nodeId);
    }
  }
}
