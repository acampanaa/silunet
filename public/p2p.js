(function () {
  'use strict';

  const HEARTBEAT_MS = 1000;
  // La autoridad vive exclusivamente en el clúster de backends. WebRTC queda
  // para telemetría/señalización, nunca para ejecutar el motor del juego.
  const BACKEND_CLUSTER_ONLY = true;
  const PEER_TIMEOUT_MS = 3500;
  const SERVER_HEARTBEAT_TIMEOUT_MS = 2000;
  const SERVER_DOWN_GRACE_MS = 1200;
  // Para VOLVER del failover se exige una ventana más larga que para entrar:
  // salir de la malla es una operación cara (se abandona el estado P2P), así
  // que un parpadeo de Wi-Fi no debe provocarla.
  const SERVER_BACK_GRACE_MS = 2500;
  const ROUND_GAP_MS = 4000;
  const MAX_SEEN_EVENTS = 500;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  const OFFLINE_RESULTS_KEY = 'silunet_offline_results';

  function readStoredResults() {
    try {
      const raw = JSON.parse(localStorage.getItem(OFFLINE_RESULTS_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      return [];
    }
  }

  function writeStoredResults(results) {
    try { localStorage.setItem(OFFLINE_RESULTS_KEY, JSON.stringify(results)); } catch (_) {}
  }

  function makeGameId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : 'p2p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function makePeerId() {
    const existing = sessionStorage.getItem('silunet_p2p_peer');
    if (existing) return existing;
    const random = crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    const id = 'p_' + random;
    sessionStorage.setItem('silunet_p2p_peer', id);
    return id;
  }

  class SilunetP2PNode {
    constructor(options) {
      this.role = options.role;
      this.peerId = makePeerId();
      this.playerId = null;
      this.nick = null;
      this.signalSend = null;
      this.onGameMessage = options.onGameMessage || function () {};
      this.onStatus = options.onStatus || function () {};

      this.peers = new Map();
      this.known = new Map();
      this.serverAlive = true;
      this.lastServerSeen = Date.now();
      this.serverRttMs = null;
      this.serverClosedAt = 0;
      // Instante desde el que el servidor volvió a dar señales ESTANDO en
      // failover. Es lo que mide la ventana de regreso.
      this.serverBackSince = 0;
      this.failoverActive = false;
      this.isolatedNotified = false;
      this.leaderId = null;
      this.state = null;
      // Palabras de reserva que manda el servidor: es lo único con lo que el
      // líder de la malla puede arrancar una partida NUEVA estando aislado.
      this.spareRounds = [];
      this.serverRevision = -1;
      this.stateVersion = 0;
      this.eventSeq = 0;
      this.lamport = 0;
      this.seenEvents = new Set();
      this.pendingActions = [];
      this.engineTimers = new Set();
      this.assetCache = new Map();
      this.assetPending = new Map();
      this.offlineAssetsReady = false;
      this.assetSetKey = '';
      this.assetBase = '';

      // Partidas jugadas SIN servidor, esperando subir al historial. Viven en
      // localStorage: si el celular se recarga antes de que vuelva el clúster,
      // el resultado no se pierde.
      this.offlineResults = readStoredResults();

      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
      this.monitorTimer = setInterval(() => this.monitor(), 500);
    }

    attachSignaling(sendFunction) {
      this.signalSend = sendFunction;
    }

    setBackendUrl(webSocketUrl) {
      this.assetBase = String(webSocketUrl || '')
        .replace(/^wss:/, 'https:')
        .replace(/^ws:/, 'http:')
        .replace(/\/$/, '');
      window.__silunetAssetBase = this.assetBase;
    }

    register(playerId, nick) {
      if (playerId) this.playerId = playerId;
      if (nick) this.nick = nick;
      this.serverOpened();
      // Cada reconexión es una oportunidad de subir lo que se jugó sin servidor.
      this.flushOfflineResults();
      this.sendSignal({
        type: 'P2P_REGISTER',
        peerId: this.peerId,
        role: this.role,
        playerId: this.playerId || undefined,
        nick: this.nick || undefined,
      });
    }

    serverOpened() {
      if (!this.failoverActive) {
        this.serverAlive = true;
        this.lastServerSeen = Date.now();
        this.serverClosedAt = 0;
      }
    }

    // La vitalidad del servidor se sigue midiendo SIEMPRE, también durante el
    // failover: si dejara de medirse (como antes), nada podría detectar que el
    // clúster volvió y el celular se quedaría en la malla P2P para siempre.
    // Que el servidor esté vivo NO significa que lo estemos usando: eso lo dice
    // `serverAlive && !failoverActive`, que es lo que viaja a los peers.
    serverHeartbeat() {
      this.lastServerSeen = Date.now();
      this.serverAlive = true;
      this.serverClosedAt = 0;
      this.isolatedNotified = false; // el servidor contesta: no estamos aislados
      if (this.failoverActive && !this.serverBackSince) this.serverBackSince = Date.now();
    }

    serverClosed() {
      this.serverAlive = false;
      this.serverBackSince = 0;
      if (!this.serverClosedAt) this.serverClosedAt = Date.now();
      if (BACKEND_CLUSTER_ONLY && !this.isolatedNotified) {
        this.isolatedNotified = true;
        this.onStatus({ type: 'no-leader', openPeers: this.openPeerIds().length });
      }
      // Ya estando en failover el aviso sobra: el banner lleva rato puesto.
      if (this.failoverActive) return;
      this.onStatus({ type: 'server-down', openPeers: this.openPeerIds().length });
    }

    handleServerMessage(msg) {
      if (!msg || typeof msg.type !== 'string') return false;
      // Cualquier mensaje autentico del servidor demuestra vida. PONG cubre
      // especialmente las fases donde el juego no esta emitiendo eventos.
      this.serverHeartbeat();
      if (msg.type === 'PONG') {
        if (Number.isFinite(Number(msg.clientTs))) {
          this.serverRttMs = Math.max(0, Math.min(30000, Date.now() - Number(msg.clientTs)));
        }
        return true;
      }
      if (msg.type === 'P2P_PEERS') {
        this.handleRoster(msg);
        return true;
      }
      if (msg.type === 'P2P_SIGNAL') {
        void this.handleSignal(msg.source, msg.data);
        return true;
      }
      if (msg.type === 'P2P_SNAPSHOT') {
        if (!this.failoverActive && msg.revision >= this.serverRevision) {
          this.serverRevision = msg.revision;
          this.stateVersion = Math.max(this.stateVersion, msg.revision);
          this.state = clone(msg.snapshot);
          // Munición para arrancar una partida nueva sin servidor.
          if (Array.isArray(msg.spare) && msg.spare.length) this.spareRounds = clone(msg.spare);
          void this.cacheSnapshotAssets(this.state);
        }
        return true;
      }
      // Mientras dura el failover el motor P2P es la ÚNICA autoridad de esta
      // pantalla. El socket puede seguir vivo (o volver antes de que se resuelva
      // el regreso) y el servidor mandaría ROUND_START, TICK, RANKING… contra el
      // mismo DOM que está pintando el líder de la malla: dos motores peleando
      // por la misma pantalla. Se descartan hasta que el regreso se confirme.
      if (this.failoverActive) return true;
      return false;
    }

    snapshotAssetUrls(snapshot) {
      if (!snapshot) return [];
      // El lote de reserva se precachea junto con la partida en curso: si el
      // servidor cae, sus imágenes ya no se pueden descargar de ningún lado.
      const entries = [...(snapshot.rounds || []), ...this.spareRounds];
      if (snapshot.round?.wordEntry) entries.push(snapshot.round.wordEntry);
      const urls = [];
      for (const entry of entries) {
        for (const url of [entry?.image, entry?.reveal]) {
          if (typeof url === 'string' && url && !url.startsWith('data:')) urls.push(url);
        }
      }
      return [...new Set(urls)].sort();
    }

    cacheSnapshotAssets(snapshot) {
      // Se cachea por URLs, no por "¿hay partida en curso?": en el lobby
      // `snapshot.rounds` está vacío pero el LOTE DE RESERVA ya llegó, y es
      // justo ahí donde puede caer el servidor. Si se espera a que arranque la
      // partida, las imágenes de la reserva no se descargan nunca.
      const urls = this.snapshotAssetUrls(snapshot);
      if (!urls.length) {
        // Todo viene embebido (siluetas SVG inline): no hay nada que bajar.
        this.assetSetKey = '';
        this.offlineAssetsReady = true;
        return Promise.resolve(true);
      }
      const key = urls.join('|');
      if (key === this.assetSetKey && this.offlineAssetsReady) return Promise.resolve(true);
      if (key !== this.assetSetKey) {
        this.assetSetKey = key;
        this.offlineAssetsReady = false;
      }
      return Promise.all(urls.map(url => this.cacheAsset(url))).then(results => {
        const ready = results.every(Boolean);
        this.offlineAssetsReady = ready;
        if (ready) {
          this.onStatus({ type: 'assets-ready', count: urls.length });
        } else {
          this.onStatus({ type: 'assets-missing', count: urls.length });
        }
        return ready;
      });
    }

    cacheAsset(url) {
      if (!url || url.startsWith('data:')) return Promise.resolve(url || null);
      if (this.assetCache.has(url)) return Promise.resolve(this.assetCache.get(url));
      if (this.assetPending.has(url)) return this.assetPending.get(url);
      const pending = fetch(url, { cache: 'force-cache' })
        .then(response => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.blob();
        })
        .then(blob => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen'));
          reader.readAsDataURL(blob);
        }))
        .then(dataUrl => {
          this.assetCache.set(url, dataUrl);
          return dataUrl;
        })
        .catch(() => null)
        .finally(() => this.assetPending.delete(url));
      this.assetPending.set(url, pending);
      return pending;
    }

    assetUrl(url) {
      const cached = this.assetCache.get(url);
      if (cached) return cached;
      if (!url) return null;
      if (/^(?:data:|blob:|https?:)/i.test(url)) return url;
      return this.assetBase ? this.assetBase + (url.startsWith('/') ? url : '/' + url) : url;
    }

    renderSilhouette(container, message) {
      if (!container) return;
      // El SVG viaja dentro del snapshot y nunca depende del host. Se conserva
      // como respaldo hasta comprobar que la imagen local puede renderizarse.
      container.innerHTML = message.svg || '';
      if (!message.image) return;
      const url = this.assetUrl(message.image);
      const renderKey = message.image + ':' + Date.now() + ':' + Math.random();
      container.dataset.silunetRender = renderKey;
      const loader = new Image();
      loader.onload = () => {
        if (container.dataset.silunetRender !== renderKey) return;
        container.innerHTML = '';
        const layer = document.createElement('span');
        layer.className = 'silueta-img';
        layer.style.setProperty('--silueta', 'url("' + url + '")');
        container.appendChild(layer);
      };
      // Si el host ya no existe, se mantiene visible el SVG embebido.
      loader.onerror = () => {};
      loader.src = url;
    }

    handleRoster(msg) {
      if (msg.selfId !== this.peerId || !Array.isArray(msg.peers)) return;
      const present = new Set();
      for (const info of msg.peers) {
        if (!info || info.peerId === this.peerId) continue;
        present.add(info.peerId);
        this.known.set(info.peerId, {
          peerId: info.peerId,
          role: info.role,
          playerId: info.playerId || null,
          nick: info.nick || null,
        });
        this.ensurePeer(info.peerId, this.peerId.localeCompare(info.peerId) > 0);
      }

      if (!this.failoverActive) {
        for (const [peerId, peer] of this.peers) {
          if (!present.has(peerId)) this.closePeer(peerId, peer);
        }
      }
      this.reportMesh();
    }

    ensurePeer(peerId, initiator) {
      const current = this.peers.get(peerId);
      if (current && !['failed', 'closed'].includes(current.pc.connectionState)) return current;
      if (current) this.closePeer(peerId, current);
      if (typeof RTCPeerConnection === 'undefined') {
        this.onStatus({ type: 'unsupported' });
        return null;
      }

      const pc = new RTCPeerConnection({ iceServers: [] });
      const peer = {
        peerId: peerId,
        pc: pc,
        dc: null,
        pendingCandidates: [],
        createdAt: Date.now(),
        lastSeen: Date.now(),
        serverAlive: true,
      };
      this.peers.set(peerId, peer);

      pc.onicecandidate = event => {
        if (event.candidate) {
          this.sendSignal({
            type: 'P2P_SIGNAL',
            target: peerId,
            data: { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate },
          });
        }
      };
      pc.ondatachannel = event => this.bindDataChannel(peer, event.channel);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.closePeer(peerId, peer);
        }
        this.reportMesh();
      };

      if (initiator) {
        const dc = pc.createDataChannel('silunet-game', { ordered: true });
        this.bindDataChannel(peer, dc);
        void pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .then(() => this.sendSignal({
            type: 'P2P_SIGNAL',
            target: peerId,
            data: { description: pc.localDescription },
          }))
          .catch(error => this.onStatus({ type: 'rtc-error', message: error.message }));
      }
      return peer;
    }

    async handleSignal(source, data) {
      if (!source || !data || typeof data !== 'object') return;
      const peer = this.ensurePeer(source, false);
      if (!peer) return;
      try {
        if (data.description) {
          await peer.pc.setRemoteDescription(data.description);
          for (const candidate of peer.pendingCandidates.splice(0)) {
            await peer.pc.addIceCandidate(candidate);
          }
          if (data.description.type === 'offer') {
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            this.sendSignal({
              type: 'P2P_SIGNAL',
              target: source,
              data: { description: peer.pc.localDescription },
            });
          }
        } else if (data.candidate) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
          else peer.pendingCandidates.push(data.candidate);
        }
      } catch (error) {
        this.onStatus({ type: 'rtc-error', peerId: source, message: error.message });
      }
    }

    bindDataChannel(peer, dc) {
      if (peer.dc && peer.dc !== dc && peer.dc.readyState !== 'closed') {
        try { dc.close(); } catch (_) {}
        return;
      }
      peer.dc = dc;
      dc.onopen = () => {
        peer.lastSeen = Date.now();
        this.sendTo(peer.peerId, this.helloMessage());
        this.sendHeartbeat();
        this.reportMesh();
      };
      dc.onmessage = event => this.handlePeerMessage(peer.peerId, event.data);
      dc.onclose = () => this.reportMesh();
      dc.onerror = () => this.reportMesh();
    }

    closePeer(peerId, expectedPeer) {
      const current = this.peers.get(peerId);
      if (!current || (expectedPeer && current !== expectedPeer)) return;
      this.peers.delete(peerId);
      try { current.dc?.close(); } catch (_) {}
      try { current.pc.close(); } catch (_) {}
      this.reportMesh();
    }

    helloMessage() {
      return {
        kind: 'HELLO',
        peerId: this.peerId,
        role: this.role,
        playerId: this.playerId,
        nick: this.nick,
        serverAlive: this.serverAlive && !this.failoverActive,
        // "Lo veo", distinto de "lo estoy usando": es lo que permite acordar
        // el regreso del failover, cuando serverAlive es false por definición.
        serverReachable: this.serverAlive,
      };
    }

    handlePeerMessage(source, raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (!msg || typeof msg.kind !== 'string') return;
      const peer = this.peers.get(source);
      if (peer) peer.lastSeen = Date.now();

      if (msg.kind === 'HELLO' || msg.kind === 'HEARTBEAT') {
        const previous = this.known.get(source) || { peerId: source };
        this.known.set(source, {
          peerId: source,
          role: msg.role || previous.role || 'player',
          playerId: msg.playerId || previous.playerId || null,
          nick: msg.nick || previous.nick || null,
        });
        if (peer) {
          peer.serverAlive = msg.serverAlive === true;
          peer.serverReachable = msg.serverReachable === true;
        }
        return;
      }

      // Un peer avisa que el clúster volvió. Solo se le cree si este celular
      // también lo está viendo: así un peer confundido no puede sacar a nadie
      // de la malla mientras el servidor sigue caído para el resto.
      if (msg.kind === 'SERVER_BACK') {
        if (this.failoverActive && this.serverAlive) this.deactivateFailover();
        return;
      }

      if (msg.kind === 'LEADER') {
        const elected = this.electedLeader();
        if (msg.leaderId === elected) this.activateFailover(elected);
        return;
      }

      if (msg.kind === 'STATE') {
        if (!this.failoverActive || source !== this.leaderId) return;
        if (Number(msg.version) <= this.stateVersion) return;
        this.stateVersion = Number(msg.version);
        this.state = clone(msg.state);
        return;
      }

      if (msg.kind === 'GAME') {
        if (!this.failoverActive || source !== this.leaderId) return;
        if (this.rememberEvent(msg.eventId) && (!msg.targetPeerId || msg.targetPeerId === this.peerId)) {
          this.onGameMessage(msg.message);
        }
        return;
      }

      if (msg.kind === 'ACTION' && this.leaderId === this.peerId) {
        this.applyAction(source, msg.action || {});
      }
    }

    rememberEvent(eventId) {
      if (!eventId || this.seenEvents.has(eventId)) return false;
      this.seenEvents.add(eventId);
      if (this.seenEvents.size > MAX_SEEN_EVENTS) {
        const oldest = this.seenEvents.values().next().value;
        this.seenEvents.delete(oldest);
      }
      return true;
    }

    sendSignal(message) {
      if (this.signalSend) this.signalSend(message);
    }

    sendTo(peerId, message) {
      const dc = this.peers.get(peerId)?.dc;
      if (!dc || dc.readyState !== 'open') return false;
      try {
        dc.send(JSON.stringify(message));
        return true;
      } catch (_) {
        return false;
      }
    }

    broadcast(message) {
      const encoded = JSON.stringify(message);
      for (const peer of this.peers.values()) {
        if (peer.dc?.readyState !== 'open') continue;
        try { peer.dc.send(encoded); } catch (_) {}
      }
    }

    openPeerIds() {
      return [...this.peers.entries()]
        .filter(([, peer]) => peer.dc?.readyState === 'open')
        .map(([peerId]) => peerId);
    }

    telemetry() {
      const knownPlayers = [...this.known.values()].filter(info => info.role === 'player').length
        + (this.role === 'player' ? 1 : 0);
      const openPlayerPeers = [...this.peers.entries()].filter(([peerId, peer]) =>
        this.known.get(peerId)?.role === 'player' && peer.dc?.readyState === 'open'
      ).length;
      const expectedPlayerPeers = knownPlayers - (this.role === 'player' ? 1 : 0);
      return {
        serverRttMs: this.serverRttMs == null ? undefined : Math.round(this.serverRttMs),
        openPeers: this.openPeerIds().length,
        openPlayerPeers: openPlayerPeers,
        knownPlayers: knownPlayers,
        meshReady: knownPlayers >= 2 && openPlayerPeers >= expectedPlayerPeers,
        failoverActive: this.failoverActive,
        serverAlive: this.serverAlive && !this.failoverActive,
        leaderId: this.leaderId,
        stateVersion: this.stateVersion,
        offlineAssetsReady: this.offlineAssetsReady,
      };
    }

    reportMesh() {
      const players = [...this.known.values()].filter(info => info.role === 'player').length
        + (this.role === 'player' ? 1 : 0);
      const openPlayerPeers = [...this.peers.entries()].filter(([peerId, peer]) =>
        this.known.get(peerId)?.role === 'player' && peer.dc?.readyState === 'open'
      ).length;
      const expectedPlayerPeers = players - (this.role === 'player' ? 1 : 0);
      this.onStatus({
        type: 'mesh',
        openPeers: this.openPeerIds().length,
        openPlayerPeers: openPlayerPeers,
        players: players,
        ready: players >= 2 && openPlayerPeers >= expectedPlayerPeers,
      });
    }

    sendHeartbeat() {
      this.broadcast({
        kind: 'HEARTBEAT',
        peerId: this.peerId,
        role: this.role,
        playerId: this.playerId,
        nick: this.nick,
        serverAlive: this.serverAlive && !this.failoverActive,
        serverReachable: this.serverAlive,
        leaderId: this.leaderId,
        stateVersion: this.stateVersion,
      });
    }

    monitor() {
      const now = Date.now();
      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastSeen > PEER_TIMEOUT_MS && peer.dc?.readyState === 'open') {
          try { peer.dc.close(); } catch (_) {}
        } else if (
          !this.failoverActive
          && peer.dc?.readyState !== 'open'
          && now - peer.createdAt > 6000
        ) {
          this.closePeer(peerId, peer);
        }
      }

      // Corre en los dos modos: es la única forma de enterarse de que el
      // servidor se calló, y también de que dejó de estarlo.
      if (this.serverAlive && now - this.lastServerSeen > SERVER_HEARTBEAT_TIMEOUT_MS) {
        this.serverClosed();
      }

      if (!this.failoverActive) {
        if (!this.serverAlive && now - this.serverClosedAt >= SERVER_DOWN_GRACE_MS) {
          if (BACKEND_CLUSTER_ONLY) {
            if (!this.isolatedNotified) {
              this.isolatedNotified = true;
              this.onStatus({ type: 'no-leader', openPeers: this.openPeerIds().length });
            }
            return;
          }
          if (this.hasServerDownMajority()) {
            this.activateFailover(this.electedLeader());
          } else if (!this.isolatedNotified) {
            // Servidor caído y NADIE con quien acordar el failover: este
            // dispositivo se quedó solo en la red. Le pasa siempre a la
            // pantalla maestra cuando se le corta el Wi-Fi a su máquina —se
            // lleva por delante el servidor y también sus canales WebRTC—, y
            // hasServerDownMajority() no puede decidir con cero reportes.
            // Sin este aviso la pantalla se congelaba muda para siempre.
            this.isolatedNotified = true;
            this.onStatus({ type: 'no-leader', openPeers: this.openPeerIds().length });
          }
        }
        return;
      }

      // Eje 4: regreso al clúster. Se exige la misma clase de acuerdo que para
      // entrar —mayoría de jugadores viendo lo mismo— para no partir la sala en
      // dos mitades, unas jugando por WebSocket y otras por WebRTC.
      if (
        this.serverAlive
        && this.serverBackSince
        && now - this.serverBackSince >= SERVER_BACK_GRACE_MS
        && this.hasServerUpMajority()
      ) {
        this.deactivateFailover();
        return;
      }

      if (!this.leaderId || !this.isEligibleAlive(this.leaderId)) {
        this.activateFailover(this.electedLeader());
      }
    }

    /**
     * ¿La mayoría de los jugadores de la malla vuelve a ver el servidor?
     *
     * Espejo de hasServerDownMajority(). Sin peers abiertos manda la propia
     * vista: un celular solo en la malla no tiene con quién acordar nada, y
     * dejarlo aislado del clúster que sí está vivo sería lo peor de las dos.
     */
    hasServerUpMajority() {
      const reports = [];
      if (this.role === 'player') reports.push(this.serverAlive === true);
      for (const [peerId, peer] of this.peers) {
        const info = this.known.get(peerId);
        if (info?.role !== 'player' || peer.dc?.readyState !== 'open') continue;
        reports.push(peer.serverReachable === true);
      }
      if (reports.length === 0) return this.serverAlive === true;
      return reports.filter(Boolean).length > reports.length / 2;
    }

    hasServerDownMajority() {
      const reports = [];
      if (this.role === 'player') reports.push(!this.serverAlive);
      for (const [peerId, peer] of this.peers) {
        const info = this.known.get(peerId);
        if (info?.role !== 'player' || peer.dc?.readyState !== 'open') continue;
        reports.push(peer.serverAlive === false);
      }
      if (reports.length === 0) return false;
      return reports.filter(Boolean).length > reports.length / 2;
    }

    isEligibleAlive(peerId) {
      if (peerId === this.peerId) return this.role === 'player';
      const peer = this.peers.get(peerId);
      const info = this.known.get(peerId);
      return info?.role === 'player'
        && peer?.dc?.readyState === 'open'
        && Date.now() - peer.lastSeen <= PEER_TIMEOUT_MS;
    }

    electedLeader() {
      const candidates = [];
      if (this.role === 'player') candidates.push(this.peerId);
      for (const peerId of this.openPeerIds()) {
        if (this.isEligibleAlive(peerId)) candidates.push(peerId);
      }
      candidates.sort();
      return candidates[candidates.length - 1] || null;
    }

    activateFailover(leaderId) {
      if (BACKEND_CLUSTER_ONLY) return;
      // Sin candidatos no hay nada que activar: este dispositivo quedó aislado
      // (típico de la pantalla maestra cuando se le corta la red: se lleva por
      // delante sus propios canales WebRTC, que iban por la misma Wi-Fi).
      // Se avisa UNA vez: monitor() reintenta cada 500 ms.
      if (!leaderId) {
        if (!this.isolatedNotified) {
          this.isolatedNotified = true;
          this.onStatus({ type: 'no-leader', openPeers: this.openPeerIds().length });
        }
        return;
      }
      this.isolatedNotified = false;
      const changed = !this.failoverActive || this.leaderId !== leaderId;
      this.failoverActive = true;
      this.serverAlive = false;
      this.serverBackSince = 0;
      this.leaderId = leaderId;
      this.stopEngine();
      if (changed) {
        this.broadcast({ kind: 'LEADER', leaderId: leaderId });
        this.onStatus({
          type: 'failover',
          leaderId: leaderId,
          isLeader: leaderId === this.peerId,
          stateAvailable: !!this.state,
        });
      }
      if (leaderId === this.peerId) {
        this.startEngine();
        this.flushActions();
      }
    }

    /**
     * Regreso al clúster (Eje 4). El servidor recupera la autoridad SIN
     * negociar: durante el corte pudo perfectamente seguir jugándose la partida
     * de verdad —lo que se cayó bien pudo ser el Wi-Fi de este celular, no el
     * clúster— así que la réplica P2P se descarta entera y se vuelve a partir
     * del snapshot autoritativo. Lo que se jugó en la malla mientras tanto no
     * se sube al servidor.
     */
    deactivateFailover() {
      if (!this.failoverActive) return;
      this.stopEngine();
      this.failoverActive = false;
      this.leaderId = null;
      this.isolatedNotified = false;
      this.serverBackSince = 0;
      this.serverClosedAt = 0;
      this.pendingActions.length = 0;
      this.seenEvents.clear();
      // Se acepta el próximo P2P_SNAPSHOT aunque nuestra versión P2P sea más
      // alta: la del servidor es la que vale, no la más avanzada.
      this.state = null;
      this.serverRevision = -1;
      this.stateVersion = 0;
      this.broadcast({ kind: 'SERVER_BACK', peerId: this.peerId });
      this.flushOfflineResults();
      this.onStatus({ type: 'server-back', subidas: this.offlineResults.length === 0 });
    }

    handlesLiveAction() {
      return !BACKEND_CLUSTER_ONLY && (this.failoverActive || !this.serverAlive);
    }

    submitAction(action) {
      if (!this.handlesLiveAction()) return false;
      const stamped = Object.assign({}, action, {
        playerId: this.playerId,
        lamport: Math.max(this.lamport, Number(action.lamport) || 0) + 1,
      });
      this.lamport = stamped.lamport;
      if (!this.leaderId) {
        this.pendingActions.push(stamped);
        return true;
      }
      if (this.leaderId === this.peerId) this.applyAction(this.peerId, stamped);
      else if (!this.sendTo(this.leaderId, { kind: 'ACTION', action: stamped })) this.pendingActions.push(stamped);
      return true;
    }

    flushActions() {
      const pending = this.pendingActions.splice(0);
      for (const action of pending) this.submitAction(action);
    }

    startEngine() {
      if (!this.state) {
        this.onStatus({ type: 'no-snapshot' });
        return;
      }
      if (this.state.mode !== 'clasico') {
        this.onStatus({ type: 'unsupported-mode', mode: this.state.mode });
        return;
      }
      this.state = clone(this.state);
      this.stateVersion = Math.max(this.stateVersion, this.serverRevision) + 1;
      this.syncState();

      if ((this.state.phase === 'playing' || this.state.phase === 'countdown') && this.state.round) {
        this.state.phase = 'playing';
        this.emitGame(this.roundStartMessage());
        this.startTicking();
      } else if (this.state.phase === 'roundEnd') {
        this.setEngineTimeout(() => this.nextRound(), 1000);
      } else if (this.state.phase === 'gameEnd') {
        this.emitRanking(true);
      } else {
        this.onStatus({ type: 'not-running', phase: this.state.phase });
      }
    }

    stopEngine() {
      for (const timer of this.engineTimers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      this.engineTimers.clear();
    }

    setEngineTimeout(fn, delay) {
      const timer = setTimeout(() => {
        this.engineTimers.delete(timer);
        if (this.leaderId === this.peerId) fn();
      }, delay);
      this.engineTimers.add(timer);
      return timer;
    }

    startTicking() {
      const timer = setInterval(() => {
        if (this.leaderId !== this.peerId || !this.state?.round || this.state.phase !== 'playing') return;
        const round = this.state.round;
        round.timeLeft = Math.max(0, round.timeLeft - 1);
        if (
          round.timeLeft > 0
          && round.timeLeft % 4 === 0
          && round.revealedCount < round.revealOrder.length
        ) {
          const index = round.revealOrder[round.revealedCount++];
          round.hiddenWord[index] = round.wordEntry.word[index];
        }
        this.emitGame({
          type: 'TICK',
          timeLeft: round.timeLeft,
          hiddenWord: round.hiddenWord.join(' '),
        });
        this.syncState();
        if (round.timeLeft <= 0) {
          clearInterval(timer);
          this.engineTimers.delete(timer);
          this.endRound();
        }
      }, 1000);
      this.engineTimers.add(timer);
    }

    roundStartMessage() {
      const round = this.state.round;
      const entry = round.wordEntry;
      return {
        type: 'ROUND_START',
        roundNumber: this.state.currentRoundIndex + 1,
        totalRounds: this.state.rounds.length,
        category: entry.category,
        svg: entry.svg,
        image: entry.image,
        hiddenWord: round.hiddenWord.join(' '),
        timeLeft: round.timeLeft,
        totalTime: round.totalTime,
      };
    }

    applyAction(sourcePeerId, action) {
      if (this.leaderId !== this.peerId || !this.state?.round || this.state.phase !== 'playing') return;
      const info = sourcePeerId === this.peerId
        ? { playerId: this.playerId, nick: this.nick, role: this.role }
        : this.known.get(sourcePeerId);
      if (!info || info.role !== 'player' || !info.playerId || info.playerId !== action.playerId) return;
      const player = this.state.players.find(item => item.id === info.playerId);
      if (!player) return;
      const round = this.state.round;

      if (action.type === 'REQUEST_HINT') {
        if (round.solvers.some(item => item.id === player.id)) {
          this.emitGame({ type: 'HINT_RESULT', status: 'unavailable' }, sourcePeerId);
          return;
        }
        const elapsed = round.totalTime - round.timeLeft;
        if (elapsed < 5) {
          this.emitGame({ type: 'HINT_RESULT', status: 'locked', secondsLeft: 5 - elapsed }, sourcePeerId);
          return;
        }
        const alreadyUsed = round.hintedPlayerIds.includes(player.id);
        if (!alreadyUsed) round.hintedPlayerIds.push(player.id);
        this.emitGame({
          type: 'HINT_RESULT',
          status: 'revealed',
          hint: round.wordEntry.hint,
          penaltyPercent: 20,
          alreadyUsed: alreadyUsed,
        }, sourcePeerId);
        this.syncState();
        return;
      }

      if (action.type !== 'GUESS') return;
      if (round.solvers.some(item => item.id === player.id)) {
        this.emitGame({ type: 'ALREADY_SOLVED' }, sourcePeerId);
        return;
      }
      this.lamport = Math.max(this.lamport, Number(action.lamport) || 0) + 1;
      if (String(action.word || '').trim().toUpperCase() !== round.wordEntry.word) {
        this.emitGame({ type: 'WRONG_ANSWER' }, sourcePeerId);
        return;
      }

      round.solvers.push({ id: player.id, lamport: this.lamport });
      this.emitGame({
        type: 'CORRECT_ANSWER',
        nick: player.nick,
        playerId: player.id,
        position: round.solvers.length,
        lamport: this.lamport,
        usedHint: round.hintedPlayerIds.includes(player.id),
      });
      this.syncState();
    }

    endRound() {
      if (!this.state?.round) return;
      this.state.phase = 'roundEnd';
      const round = this.state.round;
      const ordered = [...round.solvers].sort((a, b) => a.lamport - b.lamport);
      const count = ordered.length;
      const solvers = ordered.map((solver, index) => {
        const position = index + 1;
        const raw = Math.round(100 + 900 * (1 - (position - 1) / count));
        const usedHint = round.hintedPlayerIds.includes(solver.id);
        const points = usedHint ? Math.round(raw * 0.8) : raw;
        const player = this.state.players.find(item => item.id === solver.id);
        if (player) player.score += points;
        return {
          nick: player?.nick || '?',
          points: points,
          position: position,
          lamport: solver.lamport,
          usedHint: usedHint,
        };
      });
      this.emitGame({
        type: 'ROUND_END',
        word: round.wordEntry.word,
        reveal: round.wordEntry.reveal,
        solvers: solvers,
      });
      this.emitRanking(false);
      this.syncState();
      this.setEngineTimeout(() => this.nextRound(), ROUND_GAP_MS);
    }

    nextRound() {
      if (!this.state) return;
      this.state.currentRoundIndex++;
      if (this.state.currentRoundIndex >= this.state.rounds.length) {
        this.endGame();
        return;
      }
      const entry = this.state.rounds[this.state.currentRoundIndex];
      const chars = entry.word.split('');
      const revealOrder = chars
        .map((char, index) => char === ' ' ? -1 : index)
        .filter(index => index >= 0);
      const duration = Math.max(5, 25 - this.state.currentRoundIndex * 3);
      this.state.round = {
        wordEntry: entry,
        hiddenWord: chars.map(char => char === ' ' ? ' ' : '_'),
        revealOrder: revealOrder,
        revealedCount: 0,
        timeLeft: duration,
        totalTime: duration,
        solvers: [],
        hintedPlayerIds: [],
      };
      this.state.phase = 'countdown';
      this.emitGame({
        type: 'ROUND_PREVIEW',
        roundNumber: this.state.currentRoundIndex + 1,
        totalRounds: this.state.rounds.length,
        category: entry.category,
        svg: entry.svg,
        image: entry.image,
        hiddenWord: this.state.round.hiddenWord.join(' '),
      });
      this.syncState();
      this.runCountdown(3);
    }

    runCountdown(value) {
      this.emitGame({ type: 'COUNTDOWN', value: value });
      if (value > 0) {
        this.setEngineTimeout(() => this.runCountdown(value - 1), 1000);
        return;
      }
      this.state.phase = 'playing';
      this.emitGame(this.roundStartMessage());
      this.syncState();
      this.startTicking();
    }

    endGame() {
      this.state.phase = 'gameEnd';
      this.emitRanking(true);
      this.syncState();
      this.stopEngine();
      this.rememberOfflineResult();
    }

    /**
     * ¿Puede este dispositivo arrancar una partida SIN servidor?
     *
     * Solo el líder electo de la malla, y solo si tiene munición (el lote de
     * reserva que mandó el servidor mientras estaba vivo) y no hay ya una
     * partida corriendo.
     */
    canStartOfflineGame() {
      if (!this.failoverActive || this.leaderId !== this.peerId) return false;
      if (!this.state || !this.spareRounds.length) return false;
      const phase = this.state.phase;
      return phase !== 'countdown' && phase !== 'playing' && phase !== 'roundEnd' && phase !== 'voting';
    }

    /**
     * El líder toma el mando que normalmente tiene /master y arranca una
     * partida nueva sobre la malla. Sin servidor no hay votación de categoría:
     * se juega directo con el lote de reserva.
     */
    startOfflineGame() {
      if (!this.canStartOfflineGame()) return false;
      this.stopEngine();
      this.state.mode = 'clasico';
      this.state.currentGameId = makeGameId();
      this.state.rounds = clone(this.spareRounds);
      this.state.currentRoundIndex = -1;
      this.state.round = null;
      this.state.phase = 'countdown';
      for (const player of this.state.players) player.score = 0;
      this.emitRanking(false);
      this.syncState();
      this.nextRound();
      return true;
    }

    /**
     * Guarda el podio de una partida jugada en la malla para subirlo cuando
     * vuelva el clúster. Se conserva el token de cada jugador porque es lo que
     * la base usa para atribuir la partida a una identidad.
     */
    rememberOfflineResult() {
      if (this.leaderId !== this.peerId || !this.state) return;
      const medallas = ['oro', 'plata', 'bronce'];
      const standings = [...this.state.players]
        .sort((a, b) => b.score - a.score)
        .map((player, index) => ({
          token: player.token,
          nick: player.nick,
          score: player.score,
          position: index + 1,
          medalla: medallas[index] || null,
        }))
        .filter(standing => standing.token);
      if (!standings.length) return;
      const result = {
        gameId: this.state.currentGameId || makeGameId(),
        mode: 'clasico',
        totalRounds: this.state.rounds.length,
        standings: standings,
      };
      if (this.offlineResults.some(item => item.gameId === result.gameId)) return;
      this.offlineResults.push(result);
      writeStoredResults(this.offlineResults);
      this.onStatus({ type: 'offline-result', pending: this.offlineResults.length });
    }

    /**
     * Sube al servidor las partidas jugadas sin él. Se reintenta en cada
     * reconexión; el servidor deduplica por gameId, así que repetir es barato
     * y perder un resultado no lo es.
     */
    flushOfflineResults() {
      if (!this.offlineResults.length || !this.signalSend) return;
      const quedan = [];
      for (const result of this.offlineResults) {
        if (this.signalSend({ type: 'OFFLINE_RESULT', result: result }) !== true) quedan.push(result);
      }
      this.offlineResults = quedan;
      writeStoredResults(this.offlineResults);
    }

    ranking() {
      return [...(this.state?.players || [])]
        .sort((a, b) => b.score - a.score)
        .map(player => ({
          nick: player.nick,
          score: player.score,
          avatarId: player.avatarId || 0,
          avatarKey: player.avatarKey,
        }));
    }

    emitRanking(final) {
      this.emitGame({ type: 'RANKING', entries: this.ranking(), final: final });
    }

    emitGame(message, targetPeerId) {
      const eventId = this.peerId + ':' + (++this.eventSeq);
      this.rememberEvent(eventId);
      if (!targetPeerId || targetPeerId === this.peerId) this.onGameMessage(message);
      this.broadcast({
        kind: 'GAME',
        eventId: eventId,
        targetPeerId: targetPeerId || null,
        message: message,
      });
    }

    syncState() {
      if (!this.state || this.leaderId !== this.peerId) return;
      this.stateVersion++;
      this.broadcast({
        kind: 'STATE',
        leaderId: this.peerId,
        version: this.stateVersion,
        state: this.state,
      });
    }
  }

  window.SilunetP2P = {
    create: function (options) {
      return new SilunetP2PNode(options || {});
    },
  };
})();
