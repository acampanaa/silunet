(function () {
  'use strict';

  const STATUS_LABEL = {
    healthy: 'Saludable',
    warning: 'Latido retrasado',
    offline: 'Desconectado',
  };
  const TIME_FORMATTER = new Intl.DateTimeFormat('es-EC', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function duration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return Math.round(value) + ' ms';
    if (value < 10000) return (value / 1000).toFixed(1).replace('.0', '') + ' s';
    return Math.round(value / 1000) + ' s';
  }

  function time(value) {
    if (!value) return '—';
    return TIME_FORMATTER.format(new Date(value));
  }

  function shortId(value) {
    const text = String(value || '');
    if (!text) return '—';
    return text.length <= 16 ? text : text.slice(0, 7) + '…' + text.slice(-5);
  }

  function initials(name, role) {
    if (role === 'master') return 'M';
    return String(name || 'J').trim().slice(0, 1).toUpperCase();
  }

  class DistributedMonitor {
    constructor(options) {
      this.getP2P = options.getP2P || function () { return null; };
      // El celular se suscribe al abrir y se da de baja al cerrar: el master,
      // que recibe el monitor siempre, simplemente no pasa este callback.
      this.onVisibility = options.onVisibility || function () {};
      this.snapshot = null;
      this.filter = 'all';
      this.expanded = new Set();
      this.lastFocus = null;

      this.overlay = document.getElementById('monitor-overlay');
      this.panel = this.overlay.querySelector('.monitor-panel');
      this.trigger = document.getElementById('monitor-trigger');
      this.content = document.getElementById('monitor-content');
      this.updated = document.getElementById('monitor-updated');

      this.trigger.addEventListener('click', () => this.open());
      document.getElementById('monitor-close').addEventListener('click', () => this.close());
      document.getElementById('monitor-backdrop').addEventListener('click', () => this.close());
      this.overlay.addEventListener('keydown', event => this.handleKeydown(event));
      this.content.addEventListener('click', event => {
        const button = event.target.closest('.monitor-card-main');
        if (!button) return;
        const key = button.dataset.monitorKey;
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.render();
      });
      document.querySelectorAll('[data-monitor-filter]').forEach(button => {
        button.addEventListener('click', () => {
          this.filter = button.dataset.monitorFilter;
          document.querySelectorAll('[data-monitor-filter]').forEach(tab => {
            const selected = tab === button;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
          });
          this.render();
        });
      });

      this.timer = setInterval(() => this.tick(), 500);
    }

    update(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.participants) || !Array.isArray(snapshot.nodes)) return;
      this.snapshot = snapshot;
      this.render();
    }

    open() {
      this.lastFocus = document.activeElement;
      this.overlay.classList.add('open');
      this.overlay.setAttribute('aria-hidden', 'false');
      this.trigger.setAttribute('aria-expanded', 'true');
      this.onVisibility(true);
      this.render();
      requestAnimationFrame(() => this.panel.focus());
    }

    close() {
      this.overlay.classList.remove('open');
      this.overlay.setAttribute('aria-hidden', 'true');
      this.trigger.setAttribute('aria-expanded', 'false');
      this.onVisibility(false);
      if (this.lastFocus && typeof this.lastFocus.focus === 'function') this.lastFocus.focus();
    }

    handleKeydown(event) {
      if (event.key === 'Escape') {
        this.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...this.overlay.querySelectorAll(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )].filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    tick() {
      this.updateTrigger();
      if (this.overlay.classList.contains('open')) this.render();
    }

    materialize() {
      const now = Date.now();
      const source = this.snapshot || {
        generatedAt: now,
        coordinatorId: '—',
        electionInProgress: false,
        participants: [],
        nodes: [],
        thresholds: { clientTimeoutMs: 2000, peerTimeoutMs: 3500, nodeTimeoutMs: 2500 },
      };
      const snapshotAge = Math.max(0, now - source.generatedAt);
      const participants = source.participants.map(item => ({
        ...item,
        telemetry: item.telemetry ? { ...item.telemetry } : undefined,
        heartbeatAgeMs: Math.max(0, (Number(item.heartbeatAgeMs) || 0) + snapshotAge),
      }));
      const nodes = source.nodes.map(item => ({ ...item }));
      const p2p = this.getP2P();
      const peerTimeout = source.thresholds?.peerTimeoutMs || 3500;
      const failover = p2p?.failoverActive === true;

      if (p2p) {
        const own = participants.find(item => item.p2pPeerId === p2p.peerId);
        if (own) {
          own.telemetry = p2p.telemetry();
          if (failover) {
            own.heartbeatAgeMs = 0;
            own.status = 'healthy';
          }
        } else if (p2p.peerId) {
          participants.push({
            connectionId: p2p.peerId,
            role: p2p.role === 'player' ? 'player' : 'master',
            nick: p2p.nick || (p2p.role === 'player' ? 'Jugador local' : 'Master'),
            playerId: p2p.playerId || undefined,
            p2pPeerId: p2p.peerId,
            nodeId: failover ? 'malla P2P' : 'nodo local',
            connectedAt: now,
            lastSeenAt: now,
            heartbeatAgeMs: 0,
            status: 'healthy',
            telemetry: p2p.telemetry(),
          });
        }

        for (const [peerId, info] of p2p.known || []) {
          const peer = p2p.peers.get(peerId);
          const age = peer ? Math.max(0, now - peer.lastSeen) : peerTimeout + 1;
          const open = peer?.dc?.readyState === 'open';
          const status = !open || age > peerTimeout
            ? 'offline'
            : age > 1250 ? 'warning' : 'healthy';
          let participant = participants.find(item => item.p2pPeerId === peerId);
          if (!participant) {
            participant = {
              connectionId: peerId,
              role: info.role === 'master' ? 'master' : 'player',
              nick: info.nick || (info.role === 'master' ? 'Master' : 'Jugador P2P'),
              playerId: info.playerId || undefined,
              p2pPeerId: peerId,
              nodeId: failover ? 'malla P2P' : 'nodo remoto',
              connectedAt: peer?.createdAt || now,
              lastSeenAt: peer?.lastSeen || now - age,
              heartbeatAgeMs: age,
              status,
            };
            participants.push(participant);
          }
          if (failover) {
            participant.heartbeatAgeMs = age;
            participant.lastSeenAt = peer?.lastSeen || participant.lastSeenAt;
            participant.status = status;
          }
          participant.telemetry = {
            ...(participant.telemetry || {}),
            serverAlive: peer?.serverAlive !== false,
            leaderId: p2p.leaderId,
            failoverActive: failover,
          };
        }
      }

      for (const participant of participants) {
        if (participant.disconnectedAt) participant.status = 'offline';
        else if (!failover) {
          participant.status = participant.heartbeatAgeMs >= (source.thresholds?.clientTimeoutMs || 2000)
            ? 'offline'
            : participant.heartbeatAgeMs >= 1250 ? 'warning' : 'healthy';
        }
      }

      if (failover) nodes.forEach(node => { node.up = false; });
      return { ...source, participants, nodes, failover, now };
    }

    updateTrigger() {
      const data = this.materialize();
      const active = data.participants.filter(item => item.status !== 'offline').length;
      const alerts = data.participants.some(item => item.status !== 'healthy')
        || data.nodes.some(node => !node.up);
      document.getElementById('monitor-trigger-count').textContent =
        active + '/' + data.participants.length;
      this.trigger.classList.toggle('has-alert', alerts);
      this.trigger.setAttribute(
        'aria-label',
        'Abrir monitor distribuido: ' + active + ' de ' + data.participants.length + ' participantes activos'
      );
    }

    render() {
      const focusedKey = document.activeElement?.dataset?.monitorKey;
      const data = this.materialize();
      const participants = data.participants;
      const active = participants.filter(item => item.status !== 'offline');
      const upNodes = data.nodes.filter(node => node.up);
      const rtts = active.map(item => finite(item.telemetry?.serverRttMs)).filter(value => value != null);
      const averageRtt = rtts.length ? Math.round(rtts.reduce((sum, value) => sum + value, 0) / rtts.length) : null;

      this.setStat('monitor-stat-clients', active.length + '/' + participants.length, active.length === participants.length ? 'ok' : 'warn');
      this.setStat('monitor-stat-nodes', upNodes.length + '/' + data.nodes.length, upNodes.length === data.nodes.length ? 'ok' : 'warn');
      this.setStat('monitor-stat-rtt', averageRtt == null ? '—' : averageRtt + ' ms', averageRtt != null && averageRtt > 300 ? 'warn' : 'ok');
      this.setStat('monitor-stat-route', data.failover ? 'WebRTC P2P' : 'WebSocket', data.failover ? 'warn' : 'ok');
      this.updated.textContent = this.snapshot
        ? 'reporte ' + time(this.snapshot.generatedAt) + ' · hace ' + duration(data.now - this.snapshot.generatedAt)
        : 'vista P2P local';

      const sections = [];
      if (this.filter === 'all' || this.filter === 'nodes') {
        sections.push(this.nodeSection(data));
      }
      if (this.filter !== 'nodes') {
        const visible = participants.filter(item =>
          this.filter === 'all'
          || (this.filter === 'players' && item.role === 'player')
          || (this.filter === 'masters' && item.role === 'master')
        );
        sections.push(this.participantSection(visible));
      }
      this.content.innerHTML = sections.join('') || '<div class="monitor-empty">No hay elementos para este filtro.</div>';
      if (focusedKey) {
        const replacement = [...this.content.querySelectorAll('[data-monitor-key]')]
          .find(element => element.dataset.monitorKey === focusedKey);
        replacement?.focus({ preventScroll: true });
      }
      this.updateTrigger();
    }

    setStat(id, text, state) {
      const element = document.getElementById(id);
      element.textContent = text;
      element.classList.toggle('ok', state === 'ok');
      element.classList.toggle('warn', state === 'warn');
    }

    nodeSection(data) {
      const cards = data.nodes.map(node => {
        const key = 'node:' + node.id;
        const expanded = this.expanded.has(key);
        const heartbeat = node.heartbeatAgeMs == null ? 'sin señal' : duration(node.heartbeatAgeMs);
        return `
          <article class="monitor-card node ${node.up ? '' : 'offline'} ${expanded ? 'expanded' : ''}">
            <button class="monitor-card-main" type="button" data-monitor-key="${escapeHtml(key)}"
                    aria-expanded="${expanded}">
              <span class="monitor-identity">
                <span class="monitor-avatar">N</span>
                <span class="monitor-name">
                  <strong>${escapeHtml(node.id)}</strong>
                  <small><i class="monitor-status-dot ${node.up ? 'healthy' : 'offline'}"></i>${node.up ? 'Activo' : 'Sin conexión'}${node.isCoordinator ? ' · coordinador' : ''}</small>
                </span>
              </span>
              ${this.metric('Heartbeat', heartbeat)}
              ${this.metric('Clientes', node.clients)}
              ${this.metric('Rol', node.isCoordinator ? 'Coord.' : 'Réplica')}
              <span class="monitor-card-chevron" aria-hidden="true">›</span>
            </button>
            ${this.detailGrid([
              ['Nodo', node.id],
              ['Estado', node.up ? 'activo' : 'caído'],
              ['Último latido', heartbeat],
              ['Jugadores', node.players],
              ['Masters', node.masters],
              ['Timeout', duration(data.thresholds?.nodeTimeoutMs || 2500)],
            ])}
          </article>`;
      }).join('');
      return this.section('Nodos servidores', data.nodes.length, cards, 'No hay nodos reportados.');
    }

    participantSection(participants) {
      const cards = participants.map(item => {
        const key = 'client:' + (item.p2pPeerId || item.playerId || item.connectionId);
        const expanded = this.expanded.has(key);
        const telemetry = item.telemetry || {};
        const rtt = finite(telemetry.serverRttMs);
        const p2p = finite(telemetry.openPeers);
        return `
          <article class="monitor-card ${item.role} ${item.status} ${expanded ? 'expanded' : ''}">
            <button class="monitor-card-main" type="button" data-monitor-key="${escapeHtml(key)}"
                    aria-expanded="${expanded}">
              <span class="monitor-identity">
                <span class="monitor-avatar">${escapeHtml(initials(item.nick, item.role))}</span>
                <span class="monitor-name">
                  <strong>${escapeHtml(item.nick)}</strong>
                  <small><i class="monitor-status-dot ${item.status}"></i>${STATUS_LABEL[item.status]} · ${item.role === 'master' ? 'master' : 'jugador'}</small>
                </span>
              </span>
              ${this.metric('Último ping', duration(item.heartbeatAgeMs))}
              ${this.metric('RTT', rtt == null ? '—' : rtt + ' ms')}
              ${this.metric('P2P', p2p == null ? '—' : p2p + ' abiertos')}
              <span class="monitor-card-chevron" aria-hidden="true">›</span>
            </button>
            ${this.detailGrid([
              ['Nodo conectado', item.nodeId],
              ['Conexión', shortId(item.connectionId)],
              ['Player ID', shortId(item.playerId)],
              ['Peer P2P', shortId(item.p2pPeerId)],
              ['Conectado desde', time(item.connectedAt)],
              ['Último heartbeat', time(item.lastSeenAt)],
              ['Jugadores conocidos', telemetry.knownPlayers ?? '—'],
              ['Peers jugadores', telemetry.openPlayerPeers ?? '—'],
              ['Malla completa', telemetry.meshReady == null ? '—' : telemetry.meshReady ? 'sí' : 'no'],
              ['Servidor visible', telemetry.serverAlive == null ? '—' : telemetry.serverAlive ? 'sí' : 'no'],
              ['Failover', telemetry.failoverActive ? 'activo' : 'no'],
              ['Líder P2P', shortId(telemetry.leaderId)],
              ['Versión réplica', telemetry.stateVersion ?? '—'],
              ['Recursos offline', telemetry.offlineAssetsReady == null ? '—' : telemetry.offlineAssetsReady ? 'listos' : 'cargando'],
              ['Desconectado', item.disconnectedAt ? time(item.disconnectedAt) : 'no'],
            ])}
          </article>`;
      }).join('');
      return this.section('Participantes', participants.length, cards, 'No hay participantes en este filtro.');
    }

    metric(label, value) {
      return `<span class="monitor-metric"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></span>`;
    }

    detailGrid(items) {
      return '<div class="monitor-detail">' + items.map(([label, value]) =>
        `<span class="monitor-detail-item"><span>${escapeHtml(label)}</span><code title="${escapeHtml(value)}">${escapeHtml(value)}</code></span>`
      ).join('') + '</div>';
    }

    section(title, count, cards, empty) {
      return `<section class="monitor-section">
        <div class="monitor-section-head">
          <h3 class="monitor-section-title">${escapeHtml(title)}</h3>
          <span class="monitor-section-count">${count}</span>
        </div>
        <div class="monitor-list">${cards || '<div class="monitor-empty">' + escapeHtml(empty) + '</div>'}</div>
      </section>`;
    }
  }

  window.SilunetDistributedMonitor = Object.freeze({
    create: options => new DistributedMonitor(options || {}),
  });
})();
