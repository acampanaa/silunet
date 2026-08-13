(function () {
  'use strict';

  const HEARTBEAT_MS = 1000;
  const PEER_TIMEOUT_MS = 3500;
  const SERVER_HEARTBEAT_TIMEOUT_MS = 3200;
  const SERVER_DOWN_GRACE_MS = 1200;
  const ROUND_GAP_MS = 4000;
  const MAX_SEEN_EVENTS = 500;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
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
      this.serverClosedAt = 0;
      this.failoverActive = false;
      this.leaderId = null;
      this.state = null;
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

      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
      this.monitorTimer = setInterval(() => this.monitor(), 500);
    }

    attachSignaling(sendFunction) {
      this.signalSend = sendFunction;
    }

    register(playerId, nick) {
      if (playerId) this.playerId = playerId;
      if (nick) this.nick = nick;
      this.serverOpened();
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

    serverHeartbeat() {
      if (this.failoverActive) return;
      this.lastServerSeen = Date.now();
      this.serverAlive = true;
      this.serverClosedAt = 0;
    }

    serverClosed() {
      if (this.failoverActive) return;
      this.serverAlive = false;
      if (!this.serverClosedAt) this.serverClosedAt = Date.now();
      this.onStatus({ type: 'server-down', openPeers: this.openPeerIds().length });
    }

    handleServerMessage(msg) {
      if (!msg || typeof msg.type !== 'string') return false;
      // Cualquier mensaje autentico del servidor demuestra vida. PONG cubre
      // especialmente las fases donde el juego no esta emitiendo eventos.
      this.serverHeartbeat();
      if (msg.type === 'PONG') return true;
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
          void this.cacheSnapshotAssets(this.state);
        }
        return true;
      }
      return false;
    }

    snapshotAssetUrls(snapshot) {
      if (!snapshot) return [];
      const entries = [...(snapshot.rounds || [])];
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
      const hasRounds = Array.isArray(snapshot?.rounds) && snapshot.rounds.length > 0;
      if (!hasRounds) return Promise.resolve(false);
      const urls = this.snapshotAssetUrls(snapshot);
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
      return this.assetCache.get(url) || url || null;
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
        if (peer) peer.serverAlive = msg.serverAlive === true;
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

      if (!this.failoverActive) {
        if (this.serverAlive && now - this.lastServerSeen > SERVER_HEARTBEAT_TIMEOUT_MS) {
          this.serverClosed();
        }
        if (!this.serverAlive && now - this.serverClosedAt >= SERVER_DOWN_GRACE_MS && this.hasServerDownMajority()) {
          this.activateFailover(this.electedLeader());
        }
        return;
      }

      if (!this.leaderId || !this.isEligibleAlive(this.leaderId)) {
        this.activateFailover(this.electedLeader());
      }
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
      if (!leaderId) {
        this.onStatus({ type: 'no-leader' });
        return;
      }
      const changed = !this.failoverActive || this.leaderId !== leaderId;
      this.failoverActive = true;
      this.serverAlive = false;
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

    handlesLiveAction() {
      return this.failoverActive || !this.serverAlive;
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
