// node_modules/@trystero-p2p/core/dist/utils.mjs
var { floor, min, sin } = Math;
var libName = "Trystero";
var alloc = (n, f) => Array(n).fill(void 0).map(f);
var charSet = "0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz";
var genId = (n) => alloc(n, () => charSet[floor(Math.random() * 62)] ?? "").join("");
var selfId = genId(20);
var all = Promise.all.bind(Promise);
var isBrowser = typeof window !== "undefined";
var { entries, fromEntries, keys, values } = Object;
var noOp = () => {
};
var candidateType = "candidate";
var resetTimer = (timer) => {
  if (timer !== null) clearTimeout(timer);
  return null;
};
var mkErr = (msg) => /* @__PURE__ */ new Error(`${libName}: ${msg}`);
var toErrorMessage = (reason, fallback) => {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return toJson(reason ?? fallback);
};
var toError = (reason, fallback) => reason instanceof Error ? reason : mkErr(toErrorMessage(reason, fallback));
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var encodeBytes = (txt) => encoder.encode(txt);
var decodeBytes = (buffer) => decoder.decode(buffer);
var toHex = (buffer) => buffer.reduce((a, c) => a + c.toString(16).padStart(2, "0"), "");
var topicPath = (...parts) => parts.join("@");
var shuffle = (xs, seed) => {
  const a = [...xs];
  const rand = () => {
    const x = sin(seed++) * 1e4;
    return x - floor(x);
  };
  let i = a.length;
  while (i) {
    const j = floor(rand() * i--);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
};
var getRelays = (config, defaults, defaultN, deriveFromAppId = false) => config.relayConfig?.urls || (deriveFromAppId ? shuffle(defaults, strToNum(config.appId)) : defaults).slice(0, config.relayConfig?.redundancy ?? defaultN);
var toJson = JSON.stringify;
var fromJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    throw mkErr(`failed to parse JSON: ${s}`);
  }
};
var strToNum = (str, limit = Number.MAX_SAFE_INTEGER) => str.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % limit;
var defaultRetryMs = 3333;
var maxRetryMs = 6e4;
var socketRetryPeriods = {};
var reconnectionLockingPromise = null;
var resolver = null;
var pauseRelayReconnection = () => {
  if (!reconnectionLockingPromise) reconnectionLockingPromise = new Promise((resolve) => {
    resolver = resolve;
  }).finally(() => {
    resolver = null;
    reconnectionLockingPromise = null;
  });
};
var resumeRelayReconnection = () => {
  resolver?.();
};
var makeSocket = (url, onMessage, onReconnect) => {
  const client = {};
  let didOpen = false;
  let isReconnectPending = false;
  let resolveReady = noOp;
  client.ready = new Promise((res) => resolveReady = res);
  const init = () => {
    isReconnectPending = false;
    const socket = new WebSocket(url);
    socket.onclose = () => {
      if (isReconnectPending) return;
      isReconnectPending = true;
      if (reconnectionLockingPromise) {
        reconnectionLockingPromise.then(init);
        return;
      }
      const period = socketRetryPeriods[url] ??= defaultRetryMs;
      setTimeout(init, Math.random() * period);
      socketRetryPeriods[url] = min(period * 2, maxRetryMs);
    };
    socket.onmessage = (e) => onMessage(String(e.data));
    client.socket = socket;
    client.url = socket.url;
    socket.onopen = () => {
      const isReconnect = didOpen;
      didOpen = true;
      resolveReady(client);
      socketRetryPeriods[url] = defaultRetryMs;
      if (isReconnect) onReconnect?.();
    };
    client.send = (data) => {
      if (socket.readyState === 1) socket.send(data);
    };
  };
  init();
  return client;
};
var createRelayManager = (getSocket) => {
  const relays = {};
  const keysByRelay = /* @__PURE__ */ new WeakMap();
  const keyOf = (relay) => {
    const key = keysByRelay.get(relay);
    if (!key) throw mkErr("relay bookkeeping missing registration for relay client");
    return key;
  };
  const scoped = () => {
    const store2 = {};
    const forKey = (key) => store2[key] ??= {};
    return {
      forKey,
      forRelay: (relay) => forKey(keyOf(relay))
    };
  };
  const store = (key, relay) => {
    relays[key] = relay;
    keysByRelay.set(relay, key);
    return relay;
  };
  return {
    register: (key, createRelay) => {
      const relay = relays[key];
      if (relay) return relay;
      return store(key, createRelay());
    },
    keyOf,
    scoped,
    getSockets: () => fromEntries(entries(relays).flatMap(([key, relay]) => {
      const socket = getSocket(relay);
      return socket ? [[key, socket]] : [];
    }))
  };
};
var watchOnline = () => {
  if (isBrowser) {
    const controller = new AbortController();
    addEventListener("online", resumeRelayReconnection, { signal: controller.signal });
    addEventListener("offline", pauseRelayReconnection, { signal: controller.signal });
    return () => controller.abort();
  }
  return noOp;
};

// node_modules/@trystero-p2p/core/dist/crypto.mjs
var algo = "AES-GCM";
var strToSha1 = {};
var pack = (buff) => btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(buff))));
var unpack = (packed) => {
  const str = atob(packed);
  return new Uint8Array(str.length).map((_, i) => str.charCodeAt(i)).buffer;
};
var hashWith = async (algorithm, str) => new Uint8Array(await crypto.subtle.digest(algorithm, encodeBytes(str)));
var sha1 = async (str) => strToSha1[str] ??= Array.from(await hashWith("SHA-1", str)).map((b) => b.toString(36)).join("");
var genKey = async (secret, appId, roomId) => crypto.subtle.importKey("raw", await crypto.subtle.digest({ name: "SHA-256" }, encodeBytes(`${secret}:${appId}:${roomId}`)), { name: algo }, false, ["encrypt", "decrypt"]);
var deriveRoomNamespace = async (appId, roomId) => toHex(await hashWith("SHA-256", `${libName}:${appId}:${roomId}`));
var joinChar = "$";
var ivJoinChar = ",";
var encrypt = async (keyP, plaintext) => {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  return iv.join(ivJoinChar) + joinChar + pack(await crypto.subtle.encrypt({
    name: algo,
    iv
  }, await keyP, encodeBytes(plaintext)));
};
var decrypt = async (keyP, raw) => {
  const [iv, c] = raw.split(joinChar);
  return decodeBytes(await crypto.subtle.decrypt({
    name: algo,
    iv: new Uint8Array(iv?.split(ivJoinChar).map(Number) ?? [])
  }, await keyP, unpack(c ?? "")));
};

// node_modules/@trystero-p2p/core/dist/offer-pool.mjs
var offerTtl = 57333;
var offerLeaseTtlMs = 18e4;
var poolSize = 20;
var OfferPool = class {
  makeOffer;
  pool = [];
  pooled = /* @__PURE__ */ new Set();
  leased = /* @__PURE__ */ new Map();
  recycling = /* @__PURE__ */ new Set();
  cleanupTimer = null;
  active = false;
  constructor(makeOffer) {
    this.makeOffer = makeOffer;
  }
  get isActive() {
    return this.active;
  }
  warmup() {
    this.pool = [];
    this.pooled.clear();
    alloc(poolSize, this.makeOffer).forEach((p) => this.push(p));
    this.active = true;
    this.cleanupTimer = setInterval(() => {
      this.pool = this.pool.filter((peer) => {
        if (peer.isDead) {
          this.pooled.delete(peer);
          return false;
        }
        return true;
      });
    }, offerTtl);
  }
  push(peer) {
    if (peer.isDead || this.pooled.has(peer) || this.leased.has(peer)) return;
    this.pool.push(peer);
    this.pooled.add(peer);
  }
  shift(n) {
    const peers = [];
    while (peers.length < n && this.pool.length > 0) {
      const peer = this.pool.shift();
      if (!peer) break;
      this.pooled.delete(peer);
      peers.push(peer);
    }
    return peers;
  }
  claimLeased(peer) {
    const timer = this.leased.get(peer);
    if (timer) {
      resetTimer(timer);
      this.leased.delete(peer);
    }
  }
  recycle(peer) {
    if (peer.isDead || this.recycling.has(peer)) return;
    if (peer.connection.remoteDescription) {
      peer.destroy();
      return;
    }
    if (!this.active) {
      peer.destroy();
      return;
    }
    this.recycling.add(peer);
    peer.setHandlers({
      connect: noOp,
      close: noOp,
      error: noOp
    });
    peer.getOffer(true).then((offer) => {
      if (!offer || offer.type !== "offer" || peer.isDead || !this.active) {
        peer.destroy();
        return;
      }
      this.push(peer);
    }).catch(() => peer.destroy()).finally(() => this.recycling.delete(peer));
  }
  reclaimLeased(peer) {
    const timer = this.leased.get(peer);
    if (!timer) return;
    resetTimer(timer);
    this.leased.delete(peer);
    this.recycle(peer);
  }
  lease(peer) {
    this.claimLeased(peer);
    this.leased.set(peer, setTimeout(() => {
      this.leased.delete(peer);
      this.recycle(peer);
    }, offerLeaseTtlMs));
  }
  checkout(n, leaseOffers, encryptOffer) {
    const peers = this.shift(n);
    const missing = Math.max(0, n - peers.length);
    if (missing > 0) peers.push(...alloc(missing, this.makeOffer));
    const toRecord = async (candidate, didRetry = false) => {
      try {
        const offer = await encryptOffer(candidate);
        if (leaseOffers) {
          this.lease(candidate);
          return {
            peer: candidate,
            offer,
            claim: () => this.claimLeased(candidate),
            reclaim: () => this.reclaimLeased(candidate)
          };
        }
        return {
          peer: candidate,
          offer
        };
      } catch (err) {
        this.claimLeased(candidate);
        this.pooled.delete(candidate);
        candidate.destroy();
        if (!didRetry) return toRecord(this.makeOffer(), true);
        throw err;
      }
    };
    return all(peers.map((peer) => toRecord(peer)));
  }
  getOffers(n, encryptOffer) {
    return this.checkout(n, true, encryptOffer);
  }
  destroy() {
    this.active = false;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pool.forEach((peer) => peer.destroy());
    this.pool = [];
    this.pooled.clear();
    this.leased.forEach((timeout, peer) => {
      resetTimer(timeout);
      peer.destroy();
    });
    this.leased.clear();
    this.recycling.forEach((peer) => peer.destroy());
    this.recycling.clear();
  }
};

// node_modules/@trystero-p2p/core/dist/handshake.mjs
var overlapRoomPasswordErr = mkErr("incorrect password for overlapping room");
var createPasswordHandshake = (password, appId, roomId) => {
  const hashChallenge = (challenge) => hashWith("SHA-256", `${challenge}:${password}:${appId}:${roomId}`).then(toHex);
  const run = async (send2, receive, isInitiator) => {
    if (!password) return;
    if (isInitiator) {
      const challenge = genId(36);
      await send2({
        __trystero_pw: "challenge",
        c: challenge
      });
      const { data: data2 } = await receive();
      if (!data2 || typeof data2 !== "object" || data2.__trystero_pw !== "response" || typeof data2.h !== "string") throw overlapRoomPasswordErr;
      const expected = await hashChallenge(challenge);
      if (data2.h !== expected) throw overlapRoomPasswordErr;
      return;
    }
    const { data } = await receive();
    if (!data || typeof data !== "object" || data.__trystero_pw !== "challenge" || typeof data.c !== "string") throw overlapRoomPasswordErr;
    await send2({
      __trystero_pw: "response",
      h: await hashChallenge(data.c)
    });
  };
  const compose = (userHandshake) => password || userHandshake ? async (peerId, send2, receive, isInitiator) => {
    await run(send2, receive, isInitiator);
    await userHandshake?.(peerId, send2, receive, isInitiator);
  } : void 0;
  return {
    run,
    compose
  };
};
var toHandshakeErrorMessage = (error) => {
  const message = toErrorMessage(error, "unknown error");
  return message.startsWith("handshake ") ? message : `handshake failed: ${message}`;
};
var createHandshakeManager = ({ onPeerHandshake, onHandshakeError, handshakeTimeoutMs, sendHandshakeData, sendHandshakeReady, onActivate, onFailure }) => {
  const peerStates = {};
  const maybeActivatePeer = (id, peer) => {
    const state = peerStates[id];
    if (!state || peer && state.peer !== peer || state.isActive) return;
    if (!state.didLocalHandshakePass || !state.didReceiveRemoteReady) return;
    state.isActive = true;
    state.handshakeTimer = resetTimer(state.handshakeTimer);
    onActivate(id, state.peer);
  };
  const failPeerHandshake = (id, peer, reason) => {
    const state = peerStates[id];
    if (!state || state.peer !== peer) return;
    const error = toHandshakeErrorMessage(reason);
    onHandshakeError?.(id, error);
    onFailure(id, peer, mkErr(error));
  };
  const markLocalHandshakePassed = (id, peer) => {
    const state = peerStates[id];
    if (!state || state.peer !== peer || state.isActive) return;
    state.didLocalHandshakePass = true;
    sendHandshakeReady("", id).catch((err) => failPeerHandshake(id, peer, mkErr(`failed sending handshake readiness: ${toErrorMessage(err, "unknown send failure")}`)));
    maybeActivatePeer(id, peer);
  };
  return {
    addPeer: (id, peer) => {
      peerStates[id] = {
        peer,
        isActive: false,
        didLocalHandshakePass: false,
        didReceiveRemoteReady: false,
        handshakeTimer: null,
        pendingHandshakePayloads: [],
        handshakeWaiters: []
      };
    },
    clearPeer: (id, error) => {
      const state = peerStates[id];
      if (!state) return;
      state.handshakeTimer = resetTimer(state.handshakeTimer);
      state.pendingHandshakePayloads.length = 0;
      state.handshakeWaiters.splice(0).forEach((waiter) => waiter.reject(error));
      delete peerStates[id];
    },
    canReceiveFromPeer: (id, receiveWhilePending) => {
      const state = peerStates[id];
      return Boolean(state && (state.isActive || receiveWhilePending));
    },
    start: (id, peer) => {
      const state = peerStates[id];
      if (!state || state.peer !== peer) return;
      state.handshakeTimer = setTimeout(() => failPeerHandshake(id, peer, mkErr(`handshake timed out after ${handshakeTimeoutMs}ms`)), handshakeTimeoutMs);
      const sendHandshake = async (data, metadata) => {
        await sendHandshakeData(data, id, metadata);
      };
      const receiveHandshake = () => new Promise((resolve, reject) => {
        const current = peerStates[id];
        if (!current || current.peer !== peer) {
          reject(mkErr("peer disconnected during handshake"));
          return;
        }
        const payload = current.pendingHandshakePayloads.shift();
        if (payload) {
          resolve(payload);
          return;
        }
        current.handshakeWaiters.push({
          resolve,
          reject: (error) => reject(error)
        });
      });
      const isInitiator = selfId < id;
      Promise.resolve(onPeerHandshake?.(id, sendHandshake, receiveHandshake, isInitiator)).then(() => markLocalHandshakePassed(id, peer)).catch((err) => failPeerHandshake(id, peer, toError(err, "handshake failed")));
    },
    receiveHandshakeData: (data, id, metadata) => {
      const state = peerStates[id];
      if (!state || state.isActive) return;
      const payload = metadata === void 0 ? { data } : {
        data,
        metadata
      };
      const pending = state.handshakeWaiters.shift();
      if (pending) {
        pending.resolve(payload);
        return;
      }
      state.pendingHandshakePayloads.push(payload);
    },
    receiveHandshakeReady: (id) => {
      const state = peerStates[id];
      if (!state || state.isActive) return;
      state.didReceiveRemoteReady = true;
      maybeActivatePeer(id);
    }
  };
};

// node_modules/@trystero-p2p/core/dist/peer.mjs
var iceTimeout = 15e3;
var disconnectedCloseDelayMs = 5e3;
var iceStateEvent = "icegatheringstatechange";
var iceConnectionStateEvent = "iceconnectionstatechange";
var offerType = "offer";
var answerType = "answer";
var outOfRangePattern = /out of range/i;
var rewriteMdnsCandidatesToLoopback = (sdp) => sdp.replace(/ (\S+\.local) (\d+) typ host/g, " 127.0.0.1 $2 typ host");
var peer_default = (initiator, { trickleIce, rtcConfig, rtcPolyfill, turnConfig, _test_only_mdnsHostFallbackToLoopback }) => {
  const pc = new (rtcPolyfill ?? RTCPeerConnection)({
    iceServers: defaultIceServers.concat(turnConfig ?? []),
    ...rtcConfig
  });
  const handlers = {};
  const pendingSignals = [];
  const pendingData = [];
  const shouldTrickleIce = trickleIce !== false;
  const pendingRemoteCandidates = [];
  const pendingTracks = [];
  let makingOffer = false;
  let isSettingRemoteAnswerPending = false;
  let dataChannel = null;
  let disconnectedCloseTimer = null;
  let didEmitClose = false;
  const clearDisconnectedCloseTimer = () => disconnectedCloseTimer = resetTimer(disconnectedCloseTimer);
  const emitClose = () => {
    if (didEmitClose) return;
    didEmitClose = true;
    clearDisconnectedCloseTimer();
    handlers.close?.();
  };
  const emitSignal = (signal) => {
    if (handlers.signal) handlers.signal(signal);
    else pendingSignals.push(signal);
  };
  const appendSignalHandler = (handler) => {
    const previousSignalHandler = handlers.signal;
    handlers.signal = (signal) => {
      previousSignalHandler?.(signal);
      handler(signal);
    };
    if (pendingSignals.length > 0) pendingSignals.splice(0).forEach((signal) => handlers.signal?.(signal));
  };
  const normalizeSdp = (sdp) => _test_only_mdnsHostFallbackToLoopback ? rewriteMdnsCandidatesToLoopback(sdp) : sdp;
  const normalizeCandidate = (candidate) => {
    if (!_test_only_mdnsHostFallbackToLoopback || typeof candidate.candidate !== "string") return candidate;
    const normalizedCandidate = rewriteMdnsCandidatesToLoopback(candidate.candidate);
    return normalizedCandidate === candidate.candidate ? candidate : {
      ...candidate,
      candidate: normalizedCandidate
    };
  };
  const localDescriptionSignal = (peerConnection) => ({
    type: peerConnection.localDescription?.type ?? offerType,
    sdp: normalizeSdp(peerConnection.localDescription?.sdp ?? "")
  });
  const getRemoteUfrag = () => {
    const sdp = pc.remoteDescription?.sdp;
    if (!sdp) return null;
    return sdp.match(/a=ice-ufrag:([^\s]+)/)?.[1] ?? null;
  };
  const getRemoteMediaSectionCount = () => (pc.remoteDescription?.sdp?.match(/^m=/gm) ?? []).length;
  const canApplyRemoteCandidate = (candidate) => {
    if (!pc.remoteDescription) return false;
    const remoteMLineCount = getRemoteMediaSectionCount();
    if (typeof candidate.sdpMLineIndex === "number" && remoteMLineCount > 0 && candidate.sdpMLineIndex >= remoteMLineCount) return false;
    const remoteUfrag = getRemoteUfrag();
    if (remoteUfrag && candidate.usernameFragment && candidate.usernameFragment !== remoteUfrag) return false;
    return true;
  };
  const addIceCandidateSafe = async (candidate) => {
    try {
      await pc.addIceCandidate(candidate);
      return true;
    } catch (err) {
      if (err instanceof Error && outOfRangePattern.test(err.message) && typeof candidate.sdpMLineIndex === "number") return false;
      throw err;
    }
  };
  const flushPendingRemoteCandidates = async () => {
    if (!pc.remoteDescription || pendingRemoteCandidates.length === 0) return;
    const queuedCandidates = pendingRemoteCandidates.splice(0);
    const stillPending = [];
    for (const candidate of queuedCandidates) {
      if (!canApplyRemoteCandidate(candidate)) {
        stillPending.push(candidate);
        continue;
      }
      if (!await addIceCandidateSafe(candidate)) stillPending.push(candidate);
    }
    if (stillPending.length > 0) pendingRemoteCandidates.push(...stillPending);
  };
  const addRemoteCandidate = async (candidate) => {
    if (canApplyRemoteCandidate(candidate)) {
      if (!await addIceCandidateSafe(candidate)) pendingRemoteCandidates.push(candidate);
      return;
    }
    pendingRemoteCandidates.push(candidate);
  };
  const setupDataChannel = (channel) => {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 65535;
    channel.onmessage = (e) => {
      const data = e.data;
      if (handlers.data) handlers.data(data);
      else pendingData.push(data);
    };
    channel.onopen = () => handlers.connect?.();
    channel.onclose = emitClose;
    channel.onerror = ({ error }) => handlers.error?.(toError(error, "data channel error"));
  };
  const waitForIceGathering = async (peerConnection) => {
    let timeout = null;
    try {
      await Promise.race([new Promise((res) => {
        const checkState = () => {
          if (peerConnection.iceGatheringState === "complete") {
            peerConnection.removeEventListener(iceStateEvent, checkState);
            res();
          }
        };
        peerConnection.addEventListener(iceStateEvent, checkState);
        checkState();
      }), new Promise((res) => {
        timeout = setTimeout(res, iceTimeout);
      })]);
    } finally {
      resetTimer(timeout);
    }
    return localDescriptionSignal(peerConnection);
  };
  const emitLocalDescriptionSignal = async () => {
    const signal = shouldTrickleIce ? localDescriptionSignal(pc) : await waitForIceGathering(pc);
    emitSignal(signal);
    return signal;
  };
  if (initiator) {
    dataChannel = pc.createDataChannel("data");
    setupDataChannel(dataChannel);
  } else pc.ondatachannel = ({ channel }) => {
    dataChannel = channel;
    setupDataChannel(channel);
  };
  const createOffer = async (restartIce = false) => {
    if (pc.connectionState === "closed") return;
    try {
      makingOffer = true;
      if (restartIce) {
        if (pc.signalingState !== "stable" && pc.signalingState !== "closed" && pc.localDescription?.type === offerType) await pc.setLocalDescription({ type: "rollback" });
        if (typeof pc.restartIce === "function") pc.restartIce();
      }
      await pc.setLocalDescription(restartIce ? await pc.createOffer({ iceRestart: true }) : void 0);
      return await emitLocalDescriptionSignal();
    } catch (err) {
      handlers.error?.(toError(err, "failed to create local offer"));
    } finally {
      makingOffer = false;
    }
  };
  pc.onnegotiationneeded = async () => createOffer(false);
  pc.onicecandidate = ({ candidate }) => {
    if (!shouldTrickleIce || !candidate) return;
    const candidatePayload = normalizeCandidate(typeof candidate.toJSON === "function" ? candidate.toJSON() : {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment
    });
    emitSignal({
      type: candidateType,
      sdp: JSON.stringify(candidatePayload)
    });
  };
  const handleConnectionStateChange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
      emitClose();
      return;
    }
    if (pc.connectionState === "connected" || pc.connectionState === "connecting" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed" || pc.iceConnectionState === "checking") {
      clearDisconnectedCloseTimer();
      return;
    }
    if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") {
      if (!disconnectedCloseTimer) disconnectedCloseTimer = setTimeout(() => {
        disconnectedCloseTimer = null;
        if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") emitClose();
      }, disconnectedCloseDelayMs);
      return;
    }
  };
  pc.onconnectionstatechange = handleConnectionStateChange;
  pc.addEventListener(iceConnectionStateEvent, handleConnectionStateChange);
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (stream) {
      if (!handlers.track && !handlers.stream) {
        pendingTracks.push({
          track: e.track,
          stream
        });
        return;
      }
      handlers.track?.(e.track, stream);
      handlers.stream?.(stream);
    }
  };
  pc.onremovestream = (e) => handlers.stream?.(e.stream);
  const offerPromise = initiator ? new Promise((res) => appendSignalHandler((signal) => {
    if (signal.type === offerType) res(signal);
  })) : Promise.resolve();
  if (initiator) queueMicrotask(() => {
    if (!makingOffer && pc.signalingState === "stable" && !pc.localDescription && pc.connectionState !== "closed") pc.onnegotiationneeded?.(new Event("negotiationneeded"));
  });
  return {
    created: Date.now(),
    connection: pc,
    get channel() {
      return dataChannel;
    },
    get isDead() {
      return pc.connectionState === "closed";
    },
    getOffer: async (restartIce = false) => {
      if (!initiator) return;
      if (restartIce) return createOffer(true);
      if (pc.localDescription?.type === offerType) return shouldTrickleIce ? localDescriptionSignal(pc) : waitForIceGathering(pc);
      return offerPromise;
    },
    async signal(sdp) {
      if (sdp.type === "candidate") {
        try {
          const candidate = JSON.parse(sdp.sdp);
          if (candidate && typeof candidate === "object") await addRemoteCandidate(normalizeCandidate(candidate));
        } catch (err) {
          handlers.error?.(toError(err, "failed to parse remote candidate"));
        }
        return;
      }
      if (dataChannel?.readyState === "open" && !sdp.sdp?.includes("a=rtpmap")) return;
      try {
        const rtcSdp = {
          ...sdp,
          sdp: normalizeSdp(sdp.sdp)
        };
        if (sdp.type === offerType) {
          if (makingOffer || pc.signalingState !== "stable" && !isSettingRemoteAnswerPending) {
            if (initiator) return;
            await all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(rtcSdp)]);
          } else await pc.setRemoteDescription(rtcSdp);
          await flushPendingRemoteCandidates();
          await pc.setLocalDescription();
          return await emitLocalDescriptionSignal();
        }
        if (sdp.type === answerType) {
          isSettingRemoteAnswerPending = true;
          try {
            await pc.setRemoteDescription(rtcSdp);
            await flushPendingRemoteCandidates();
          } finally {
            isSettingRemoteAnswerPending = false;
          }
        }
      } catch (err) {
        handlers.error?.(toError(err, "failed to apply remote signal"));
      }
    },
    sendData: (data) => dataChannel?.send(data),
    destroy: () => {
      clearDisconnectedCloseTimer();
      dataChannel?.close();
      pc.close();
      makingOffer = false;
      isSettingRemoteAnswerPending = false;
      emitClose();
    },
    setHandlers: (newHandlers) => {
      const { signal, ...restHandlers } = newHandlers;
      Object.assign(handlers, restHandlers);
      if (handlers.data && pendingData.length > 0) pendingData.splice(0).forEach((data) => handlers.data?.(data));
      if (signal) appendSignalHandler(signal);
      if ((handlers.track || handlers.stream) && pendingTracks.length > 0) pendingTracks.splice(0).forEach(({ track, stream }) => {
        handlers.track?.(track, stream);
        handlers.stream?.(stream);
      });
    },
    offerPromise,
    addStream: (stream) => stream.getTracks().forEach((track) => pc.addTrack(track, stream)),
    removeStream: (stream) => pc.getSenders().filter((sender) => sender.track && stream.getTracks().includes(sender.track)).forEach((sender) => pc.removeTrack(sender)),
    addTrack: (track, stream) => pc.addTrack(track, stream),
    removeTrack: (track) => {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) pc.removeTrack(sender);
    },
    replaceTrack: (oldTrack, newTrack) => {
      const sender = pc.getSenders().find((s) => s.track === oldTrack);
      if (sender) return sender.replaceTrack(newTrack);
    }
  };
};
var defaultIceServers = [...alloc(3, (_, i) => `stun:stun${i || ""}.l.google.com:19302`), "stun:stun.cloudflare.com:3478"].map((url) => ({ urls: url }));

// node_modules/@trystero-p2p/core/dist/action-wire.mjs
var TypedArray = Object.getPrototypeOf(Uint8Array);
var typeByteLimit = 32;
var typeIndex = 0;
var nonceIndex = 32;
var tagIndex = 34;
var progressIndex = 35;
var payloadIndex = 36;
var chunkSize = 16 * 2 ** 10 - payloadIndex;
var oneByteMax = 255;
var twoByteMax = 65535;
var buffLowEvent = "bufferedamountlow";
var channelCloseEvent = "close";
var channelErrorEvent = "error";
var backpressureWaitTimeoutMs = 1e4;
var toByteArray = (value) => value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
var waitForBufferedAmountLow = (channel, timeoutMs = backpressureWaitTimeoutMs) => {
  if (channel.readyState !== "open" || channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve(channel.readyState === "open");
  return new Promise((res) => {
    let settled = false;
    let timeout = null;
    const finish = (didDrain) => {
      if (settled) return;
      settled = true;
      channel.removeEventListener(buffLowEvent, onBufferLow);
      channel.removeEventListener(channelCloseEvent, onCloseOrError);
      channel.removeEventListener(channelErrorEvent, onCloseOrError);
      resetTimer(timeout);
      res(didDrain);
    };
    const onBufferLow = () => finish(true);
    const onCloseOrError = () => finish(false);
    channel.addEventListener(buffLowEvent, onBufferLow);
    channel.addEventListener(channelCloseEvent, onCloseOrError);
    channel.addEventListener(channelErrorEvent, onCloseOrError);
    timeout = setTimeout(() => finish(false), timeoutMs);
    if (channel.readyState !== "open") {
      finish(false);
      return;
    }
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) finish(true);
  });
};
var createActionWireManager = ({ getPeer, getPeerIds, canReceiveFromPeer, throwIfAborted: throwIfAborted2 }) => {
  const actions = {};
  const actionsCache = {};
  const pendingTransmissions = {};
  const pendingActionPayloads = {};
  const iterate = (targets, f, { includePending = false } = {}) => (targets ? Array.isArray(targets) ? targets : [targets] : getPeerIds(includePending)).flatMap((id) => {
    const peer = getPeer(id, includePending);
    if (!peer) {
      console.warn(`${libName}: no peer with id ${id} found`);
      return [];
    }
    return [Promise.resolve(f(id, peer))];
  });
  const makeInternalAction = (type, options = {}) => {
    const cached = actionsCache[type];
    if (actions[type] && cached) {
      const cachedOptions = actions[type].options;
      if (cachedOptions.sendToPending !== Boolean(options.sendToPending) || cachedOptions.receiveWhilePending !== Boolean(options.receiveWhilePending)) throw mkErr(`action type "${type}" cannot be redefined`);
      return cached;
    }
    if (!type) throw mkErr("action type argument is required");
    const typeBytes = encodeBytes(type);
    if (typeBytes.byteLength > typeByteLimit) throw mkErr(`action type string "${type}" (${typeBytes.byteLength}b) exceeds byte limit (${typeByteLimit}). Hint: choose a shorter name.`);
    const normalizedOptions = {
      sendToPending: Boolean(options.sendToPending),
      receiveWhilePending: Boolean(options.receiveWhilePending)
    };
    const typeBytesPadded = new Uint8Array(typeByteLimit);
    typeBytesPadded.set(typeBytes);
    let nonce = 0;
    actions[type] = {
      onComplete: noOp,
      onProgress: noOp,
      setOnComplete: (f) => {
        actions[type].onComplete = f;
        const pending = pendingActionPayloads[type];
        if (pending?.length) {
          delete pendingActionPayloads[type];
          pending.forEach(({ payload, peerId, metadata }) => f(payload, peerId, metadata));
        }
      },
      setOnProgress: (f) => {
        actions[type].onProgress = f;
      },
      send: async (data, targets, meta, onProgress, signal) => {
        throwIfAborted2(signal);
        const dataType = typeof data;
        if (dataType === "undefined") throw mkErr("action data cannot be undefined");
        const isJson = dataType !== "string";
        const isBlob = data instanceof Blob;
        const isBinary = isBlob || data instanceof ArrayBuffer || data instanceof TypedArray;
        const hasMeta = meta !== void 0;
        const buffer = isBinary ? toByteArray(isBlob ? await data.arrayBuffer() : data) : encodeBytes(isJson ? toJson(data) : data);
        const metaEncoded = hasMeta ? encodeBytes(toJson(meta)) : null;
        const chunkTotal = Math.ceil(buffer.byteLength / chunkSize) + (hasMeta ? 1 : 0) || 1;
        const chunks = alloc(chunkTotal, (_, i) => {
          const isLast = i === chunkTotal - 1;
          const isMeta = Boolean(hasMeta && i === 0);
          const chunk = new Uint8Array(payloadIndex + (isMeta ? metaEncoded?.byteLength ?? 0 : isLast ? buffer.byteLength - chunkSize * (chunkTotal - (hasMeta ? 2 : 1)) : chunkSize));
          chunk.set(typeBytesPadded);
          chunk.set([nonce >> 8, nonce & oneByteMax], nonceIndex);
          chunk.set([Number(isLast) | Number(isMeta) << 1 | Number(isBinary) << 2 | Number(isJson) << 3], tagIndex);
          chunk.set([Math.round((i + 1) / chunkTotal * oneByteMax)], progressIndex);
          chunk.set(hasMeta ? isMeta ? metaEncoded ?? new Uint8Array() : buffer.subarray((i - 1) * chunkSize, i * chunkSize) : buffer.subarray(i * chunkSize, (i + 1) * chunkSize), payloadIndex);
          return chunk;
        });
        nonce = nonce + 1 & twoByteMax;
        await all(iterate(targets, async (id, peer) => {
          const { channel } = peer;
          let chunkN = 0;
          while (chunkN < chunkTotal) {
            throwIfAborted2(signal);
            const chunk = chunks[chunkN];
            if (!chunk) break;
            if (channel && channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
              const didDrain = await waitForBufferedAmountLow(channel);
              throwIfAborted2(signal);
              if (!didDrain) break;
            }
            const currentPeer = getPeer(id, normalizedOptions.sendToPending);
            if (!currentPeer || currentPeer !== peer) break;
            peer.sendData(chunk);
            chunkN++;
            const progressByte = chunk[progressIndex] ?? oneByteMax;
            onProgress?.(progressByte / oneByteMax, id, meta);
          }
        }, { includePending: normalizedOptions.sendToPending }));
        return [];
      },
      options: normalizedOptions
    };
    return actionsCache[type] = {
      send: actions[type].send,
      onMessage: actions[type].setOnComplete,
      onProgress: actions[type].setOnProgress
    };
  };
  const handleData = (id, data) => {
    const buffer = new Uint8Array(data);
    const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll("\0", "");
    const action = actions[type];
    if (!canReceiveFromPeer(id, Boolean(action?.options.receiveWhilePending))) return;
    const nonce = (buffer[nonceIndex] ?? 0) << 8 | (buffer[33] ?? 0);
    const tag = buffer[tagIndex] ?? 0;
    const progress = buffer[progressIndex] ?? 0;
    const payload = buffer.subarray(payloadIndex);
    const isLast = Boolean(tag & 1);
    const isMeta = Boolean(tag & 2);
    const isBinary = Boolean(tag & 4);
    const isJson = Boolean(tag & 8);
    pendingTransmissions[id] ??= {};
    pendingTransmissions[id][type] ??= {};
    const target = pendingTransmissions[id][type][nonce] ??= { chunks: [] };
    if (isMeta) target.meta = fromJson(decodeBytes(payload));
    else target.chunks.push(payload);
    action?.onProgress(progress / oneByteMax, id, target.meta);
    if (!isLast) return;
    const full = new Uint8Array(target.chunks.reduce((a, c) => a + c.byteLength, 0));
    target.chunks.reduce((a, c) => {
      full.set(c, a);
      return a + c.byteLength;
    }, 0);
    delete pendingTransmissions[id][type][nonce];
    const payloadValue = isBinary ? full : isJson ? fromJson(decodeBytes(full)) : decodeBytes(full);
    if (action) {
      action.onComplete(payloadValue, id, target.meta);
      return;
    }
    (pendingActionPayloads[type] ??= []).push({
      payload: payloadValue,
      peerId: id,
      ...target.meta === void 0 ? {} : { metadata: target.meta }
    });
  };
  return {
    makeInternalAction,
    handleData,
    clearPeer: (id) => {
      delete pendingTransmissions[id];
    }
  };
};

// node_modules/@trystero-p2p/core/dist/actions.mjs
var requestHandlerBufferMs = 500;
var makeActionError = (kind, message) => {
  const error = mkErr(message);
  error.kind = kind;
  error.name = kind === "aborted" ? "AbortError" : error.name;
  return error;
};
var throwIfAborted = (signal) => {
  if (signal?.aborted) throw makeActionError("aborted", "operation aborted");
};
var getRequestMetadata = (metadata) => {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.r === "string") return {
    r: metadata.r,
    ...Object.hasOwn(metadata, "m") ? { m: metadata.m } : {}
  };
  return null;
};
var getResponseMetadata = (metadata) => {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.r === "string") return {
    r: metadata.r,
    ...typeof metadata.e === "string" ? { e: metadata.e } : {}
  };
  return null;
};
var withMetadata = (context, metadata) => metadata === void 0 ? context : {
  ...context,
  metadata
};
var createActionManager = ({ getPeer, getPeerIds, canReceiveFromPeer }) => {
  const publicActions = {};
  const pendingRequestWaiters = {};
  const wire = createActionWireManager({
    getPeer,
    getPeerIds,
    canReceiveFromPeer,
    throwIfAborted
  });
  const makeInternalAction = wire.makeInternalAction;
  const handleData = wire.handleData;
  const clearPendingRequestWaiter = (requestId) => {
    const waiter = pendingRequestWaiters[requestId];
    if (!waiter) return;
    resetTimer(waiter.timer);
    if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener("abort", waiter.abortHandler);
    delete pendingRequestWaiters[requestId];
  };
  const rejectPendingRequestsForPeer = (id, error) => {
    entries(pendingRequestWaiters).forEach(([requestId, waiter]) => {
      if (waiter.peerId !== id) return;
      clearPendingRequestWaiter(requestId);
      waiter.reject(error);
    });
  };
  const clearPeer = (id, error) => {
    wire.clearPeer(id);
    rejectPendingRequestsForPeer(id, makeActionError("disconnected", toErrorMessage(error, "peer disconnected")));
  };
  const responseAction = makeInternalAction("@_response");
  responseAction.onMessage((payload, id, metadata) => {
    const parsed = getResponseMetadata(metadata);
    if (!parsed) return;
    const waiter = pendingRequestWaiters[parsed.r];
    if (!waiter || waiter.peerId !== id) return;
    clearPendingRequestWaiter(parsed.r);
    if (parsed.e !== void 0) {
      waiter.reject(makeActionError("rejected", parsed.e));
      return;
    }
    waiter.resolve(payload);
  });
  const makeActionImpl = (type, config) => {
    if (config && "onRequest" in config && config.kind !== "request") throw mkErr('request actions must use kind: "request"');
    const kind = config?.kind ?? "message";
    const rawAction = makeInternalAction(type);
    const existingState = publicActions[type];
    if (existingState) {
      if (existingState.kind !== kind) throw mkErr(`action type "${type}" cannot be redefined`);
      return existingState.action;
    }
    const state = {
      kind,
      action: null,
      pendingMessages: [],
      pendingRequests: [],
      onReceiveProgress: config?.onReceiveProgress ?? null
    };
    const toProgressHandler = (handler, metadata) => handler ? (progress, peerId) => handler(progress, withMetadata({ peerId }, metadata)) : void 0;
    const setReceiveProgress = (handler) => {
      state.onReceiveProgress = handler;
    };
    const dispatchReceiveProgress = (progress, peerId, metadata) => {
      const requestMetadata = state.kind === "request" ? getRequestMetadata(metadata) : null;
      state.onReceiveProgress?.(progress, withMetadata({ peerId }, requestMetadata ? requestMetadata.m : metadata));
    };
    rawAction.onProgress(dispatchReceiveProgress);
    if (kind === "message") {
      let onMessage = config?.onMessage ?? null;
      const flushMessages = () => {
        if (!onMessage) return;
        const handler = onMessage;
        state.pendingMessages.splice(0).forEach(({ payload, peerId, metadata }) => {
          Promise.resolve().then(() => handler(payload, withMetadata({ peerId }, metadata))).catch((err) => console.error(`${libName} action handler error:`, err));
        });
      };
      const action2 = {
        send: async (data, options = {}) => {
          await rawAction.send(data, options.target, options.metadata, toProgressHandler(options.onProgress, options.metadata), options.signal);
        },
        get onMessage() {
          return onMessage;
        },
        set onMessage(handler) {
          onMessage = handler;
          flushMessages();
        },
        get onReceiveProgress() {
          return state.onReceiveProgress;
        },
        set onReceiveProgress(handler) {
          setReceiveProgress(handler);
        }
      };
      rawAction.onMessage((payload, peerId, metadata) => {
        if (!onMessage) {
          state.pendingMessages.push(metadata === void 0 ? {
            payload,
            peerId
          } : {
            payload,
            peerId,
            metadata
          });
          return;
        }
        const handler = onMessage;
        Promise.resolve().then(() => handler(payload, withMetadata({ peerId }, metadata))).catch((err) => console.error(`${libName} action handler error:`, err));
      });
      state.action = action2;
      publicActions[type] = state;
      flushMessages();
      return action2;
    }
    let onRequest = config?.onRequest ?? null;
    const removePendingIncomingRequest = (request) => {
      resetTimer(request.timer);
      const i = state.pendingRequests.indexOf(request);
      if (i > -1) state.pendingRequests.splice(i, 1);
    };
    const sendRequestError = (peerId, requestId, error) => {
      responseAction.send(null, peerId, {
        r: requestId,
        e: toErrorMessage(error, "request failed")
      });
    };
    const respondToIncomingRequest = (request, handler) => {
      removePendingIncomingRequest(request);
      Promise.resolve().then(() => handler(request.payload, {
        peerId: request.peerId,
        ...request.metadata === void 0 ? {} : { metadata: request.metadata },
        signal: request.controller.signal
      })).then(async (response) => {
        if (response === void 0) throw mkErr("request handler returned undefined");
        await responseAction.send(response, request.peerId, { r: request.requestId });
      }).catch((err) => sendRequestError(request.peerId, request.requestId, err)).finally(() => request.controller.abort());
    };
    const flushRequests = () => {
      if (!onRequest) return;
      state.pendingRequests.slice().forEach((request) => respondToIncomingRequest(request, onRequest));
    };
    const queueIncomingRequest = (payload, peerId, metadata, requestId) => {
      if (onRequest) {
        respondToIncomingRequest({
          payload,
          peerId,
          ...metadata === void 0 ? {} : { metadata },
          requestId,
          controller: new AbortController(),
          timer: null
        }, onRequest);
        return;
      }
      const request = {
        payload,
        peerId,
        ...metadata === void 0 ? {} : { metadata },
        requestId,
        controller: new AbortController(),
        timer: setTimeout(() => {
          removePendingIncomingRequest(request);
          request.controller.abort();
          sendRequestError(peerId, requestId, "request handler unavailable");
        }, requestHandlerBufferMs)
      };
      state.pendingRequests.push(request);
    };
    const requestOne = async (data, options) => {
      const { target, metadata, onProgress, signal, timeoutMs } = options;
      throwIfAborted(signal);
      if (!getPeer(target, false)) throw makeActionError("disconnected", `no active peer with id ${target}`);
      const requestId = genId(20);
      const handledResponsePromise = new Promise((resolve, reject) => {
        const waiter = {
          peerId: target,
          resolve,
          reject,
          timer: null,
          ...signal === void 0 ? {} : { signal }
        };
        const rejectAsAborted = () => {
          clearPendingRequestWaiter(requestId);
          reject(makeActionError("aborted", "operation aborted"));
        };
        if (signal) {
          waiter.abortHandler = rejectAsAborted;
          signal.addEventListener("abort", rejectAsAborted, { once: true });
        }
        pendingRequestWaiters[requestId] = waiter;
      }).catch((err) => {
        throw err;
      });
      try {
        await rawAction.send(data, target, metadata === void 0 ? { r: requestId } : {
          r: requestId,
          m: metadata
        }, toProgressHandler(onProgress, metadata), signal);
        const waiter = pendingRequestWaiters[requestId];
        if (waiter && timeoutMs !== void 0) waiter.timer = setTimeout(() => {
          clearPendingRequestWaiter(requestId);
          waiter.reject(makeActionError("timeout", "request timed out"));
        }, timeoutMs);
        return await handledResponsePromise;
      } catch (err) {
        clearPendingRequestWaiter(requestId);
        throw err;
      }
    };
    const action = {
      request: requestOne,
      requestMany: async (data, options) => {
        throwIfAborted(options.signal);
        return await all(options.targets.map(async (target) => {
          try {
            const result = {
              peerId: target,
              status: "fulfilled",
              value: await requestOne(data, {
                target,
                ...options.metadata === void 0 ? {} : { metadata: options.metadata },
                ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
                ...options.onProgress === void 0 ? {} : { onProgress: options.onProgress },
                ...options.signal === void 0 ? {} : { signal: options.signal }
              })
            };
            options.onResult?.(result);
            return result;
          } catch (err) {
            const error = toError(err, "request failed");
            if (error.kind === "aborted" || !error.kind) throw error;
            const result = error.kind === "timeout" ? {
              peerId: target,
              status: "timeout"
            } : error.kind === "disconnected" ? {
              peerId: target,
              status: "disconnected"
            } : {
              peerId: target,
              status: "rejected",
              error
            };
            options.onResult?.(result);
            return result;
          }
        }));
      },
      get onRequest() {
        return onRequest;
      },
      set onRequest(handler) {
        onRequest = handler;
        flushRequests();
      },
      get onReceiveProgress() {
        return state.onReceiveProgress;
      },
      set onReceiveProgress(handler) {
        setReceiveProgress(handler);
      }
    };
    rawAction.onMessage((payload, peerId, metadata) => {
      const requestMetadata = getRequestMetadata(metadata);
      if (!requestMetadata) return;
      queueIncomingRequest(payload, peerId, requestMetadata.m, requestMetadata.r);
    });
    state.action = action;
    publicActions[type] = state;
    flushRequests();
    return action;
  };
  return {
    makeAction: makeActionImpl,
    makeInternalAction,
    handleData,
    clearPeer
  };
};

// node_modules/@trystero-p2p/core/dist/media.mjs
var toPendingMediaMeta = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.k === "string") return {
    key: value.k,
    ...typeof value.s === "string" ? { streamId: value.s } : {},
    ...typeof value.t === "string" ? { trackId: value.t } : {},
    ...Object.hasOwn(value, "m") ? { metadata: value.m } : {}
  };
  return null;
};
var makeKeyGetter = (map) => (item) => {
  let key = map.get(item);
  if (!key) {
    key = genId(20);
    map.set(item, key);
  }
  return key;
};
var createMediaIdentityCache = () => {
  const localStreamKeys = /* @__PURE__ */ new WeakMap();
  const localTrackKeys = /* @__PURE__ */ new WeakMap();
  const remoteStreamsByKey = /* @__PURE__ */ new Map();
  const remoteStreamsById = /* @__PURE__ */ new Map();
  const remoteTracksByKey = /* @__PURE__ */ new Map();
  const remoteTracksById = /* @__PURE__ */ new Map();
  return {
    getStreamKey: makeKeyGetter(localStreamKeys),
    getTrackKey: makeKeyGetter(localTrackKeys),
    rememberRemoteStream: (key, stream, streamId) => {
      remoteStreamsByKey.set(key, stream);
      if (streamId) remoteStreamsById.set(streamId, stream);
    },
    getRemoteStream: (key, streamId) => remoteStreamsByKey.get(key) ?? (streamId ? remoteStreamsById.get(streamId) : void 0),
    rememberRemoteTrack: (key, track, stream, trackId, streamId) => {
      const ref = {
        track,
        stream
      };
      remoteTracksByKey.set(key, ref);
      if (trackId) remoteTracksById.set(trackId, ref);
      if (streamId) remoteStreamsById.set(streamId, stream);
    },
    getRemoteTrack: (key, trackId) => remoteTracksByKey.get(key) ?? (trackId ? remoteTracksById.get(trackId) : void 0),
    clearRemote: () => {
      remoteStreamsByKey.clear();
      remoteStreamsById.clear();
      remoteTracksByKey.clear();
      remoteTracksById.clear();
    }
  };
};
var createMediaManager = ({ iterate, isActive, getSharedMediaPeer }) => {
  const pendingStreamMetas = {};
  const pendingTrackMetas = {};
  const localMedia = createMediaIdentityCache();
  const listeners = {
    onPeerStream: null,
    onPeerTrack: null
  };
  const emitStream = (id, key, stream, metadata) => {
    if (!isActive(id)) return;
    getSharedMediaPeer(id)?.__trysteroMedia?.rememberRemoteStream(key, stream, typeof stream.id === "string" ? stream.id : void 0);
    listeners.onPeerStream?.(stream, id, metadata);
  };
  const emitTrack = (id, key, track, stream, metadata) => {
    if (!isActive(id)) return;
    getSharedMediaPeer(id)?.__trysteroMedia?.rememberRemoteTrack(key, track, stream, typeof track.id === "string" ? track.id : void 0, typeof stream.id === "string" ? stream.id : void 0);
    listeners.onPeerTrack?.(track, stream, id, metadata);
  };
  const applyMediaOp = (targets, key, metadata, sendMeta, op, mediaIds = {}) => {
    const payload = {
      k: key,
      ...mediaIds,
      ...metadata === void 0 ? {} : { m: metadata }
    };
    return iterate(targets, async (id, peer) => {
      await sendMeta(payload, id);
      op(peer);
    });
  };
  return {
    addStream: (stream, options, sendMeta) => applyMediaOp(options.target, localMedia.getStreamKey(stream), options.metadata, sendMeta, (peer) => peer.addStream(stream), { s: stream.id }),
    removeStream: (stream, target) => {
      iterate(target, (_, peer) => peer.removeStream(stream));
    },
    addTrack: (track, stream, options, sendMeta) => applyMediaOp(options.target, localMedia.getTrackKey(track), options.metadata, sendMeta, (peer) => peer.addTrack(track, stream), {
      s: stream.id,
      t: track.id
    }),
    removeTrack: (track, target) => {
      iterate(target, (_, peer) => peer.removeTrack(track));
    },
    replaceTrack: (oldTrack, newTrack, options, sendMeta) => applyMediaOp(options.target, localMedia.getTrackKey(newTrack), options.metadata, sendMeta, (peer) => peer.replaceTrack(oldTrack, newTrack), { t: oldTrack.id }),
    receiveStreamMeta: (meta, id) => {
      if (!isActive(id)) return;
      const parsed = toPendingMediaMeta(meta);
      if (!parsed) return;
      const cached = getSharedMediaPeer(id)?.__trysteroMedia?.getRemoteStream(parsed.key, parsed.streamId);
      if (cached) {
        emitStream(id, parsed.key, cached, parsed.metadata);
        return;
      }
      (pendingStreamMetas[id] ??= []).push(parsed);
    },
    receiveTrackMeta: (meta, id) => {
      if (!isActive(id)) return;
      const parsed = toPendingMediaMeta(meta);
      if (!parsed) return;
      const cached = getSharedMediaPeer(id)?.__trysteroMedia?.getRemoteTrack(parsed.key, parsed.trackId);
      if (cached) {
        emitTrack(id, parsed.key, cached.track, cached.stream, parsed.metadata);
        return;
      }
      (pendingTrackMetas[id] ??= []).push(parsed);
    },
    receiveRemoteStream: (id, stream) => {
      if (!isActive(id)) return;
      const next = pendingStreamMetas[id]?.shift();
      if (!next) return;
      emitStream(id, next.key, stream, next.metadata);
    },
    receiveRemoteTrack: (id, track, stream) => {
      if (!isActive(id)) return;
      const next = pendingTrackMetas[id]?.shift();
      if (!next) return;
      emitTrack(id, next.key, track, stream, next.metadata);
    },
    clearPeer: (id) => {
      delete pendingStreamMetas[id];
      delete pendingTrackMetas[id];
    },
    get onPeerStream() {
      return listeners.onPeerStream;
    },
    set onPeerStream(handler) {
      listeners.onPeerStream = handler;
    },
    get onPeerTrack() {
      return listeners.onPeerTrack;
    },
    set onPeerTrack(handler) {
      listeners.onPeerTrack = handler;
    }
  };
};

// node_modules/@trystero-p2p/core/dist/room.mjs
var unloadEvent = "beforeunload";
var defaultHandshakeTimeoutMs = 1e4;
var internalNs = (ns) => "@_" + ns;
var beforeUnloadRoomCleanups = /* @__PURE__ */ new Set();
var cleanupActiveRoomsOnBeforeUnload = () => beforeUnloadRoomCleanups.forEach((cleanup) => cleanup());
var registerBeforeUnloadCleanup = (cleanup) => {
  beforeUnloadRoomCleanups.add(cleanup);
  if (beforeUnloadRoomCleanups.size === 1) addEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload);
  return () => {
    beforeUnloadRoomCleanups.delete(cleanup);
    if (!beforeUnloadRoomCleanups.size) removeEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload);
  };
};
var room_default = (onPeer, onPeerLeave, onSelfLeave, { onPeerHandshake, onHandshakeError, handshakeTimeoutMs = defaultHandshakeTimeoutMs, isPassive = false } = {}) => {
  const peerMap = {};
  const activePeerMap = {};
  const pendingPongs = {};
  const listeners = {
    onPeerJoin: null,
    onPeerLeave: null
  };
  let unregisterBeforeUnloadCleanup = noOp;
  let handshakeManager = null;
  const iterate = (targets, f, { includePending = false } = {}) => (targets ? Array.isArray(targets) ? targets : [targets] : keys(includePending ? peerMap : activePeerMap)).flatMap((id) => {
    const peer = includePending ? peerMap[id] : activePeerMap[id];
    if (!peer) {
      console.warn(`${libName}: no peer with id ${id} found`);
      return [];
    }
    return [Promise.resolve(f(id, peer))];
  });
  const mediaManager = createMediaManager({
    iterate: (targets, f) => iterate(targets, (id, peer) => f(id, peer)),
    isActive: (id) => Boolean(activePeerMap[id]),
    getSharedMediaPeer: (id) => peerMap[id] ?? null
  });
  const actionManager = createActionManager({
    getPeer: (id, includePending) => (includePending ? peerMap : activePeerMap)[id],
    getPeerIds: (includePending) => keys(includePending ? peerMap : activePeerMap),
    canReceiveFromPeer: (id, receiveWhilePending) => Boolean(handshakeManager?.canReceiveFromPeer(id, receiveWhilePending))
  });
  const makeActionInternal = actionManager.makeInternalAction;
  const handleData = actionManager.handleData;
  const makeAction = actionManager.makeAction;
  const clearPeerState = (id, reason = mkErr("peer disconnected")) => {
    const err = toError(reason, "peer disconnected");
    handshakeManager?.clearPeer(id, err);
    delete peerMap[id];
    delete activePeerMap[id];
    actionManager.clearPeer(id, err);
    pendingPongs[id]?.splice(0).forEach((waiter) => waiter.reject(err));
    delete pendingPongs[id];
    mediaManager.clearPeer(id);
  };
  const exitPeer = (id, peer, reason) => {
    const current = peerMap[id];
    if (!current) return;
    if (peer && current !== peer) return;
    const wasActive = Boolean(activePeerMap[id]);
    clearPeerState(id, reason);
    current.destroy();
    if (wasActive) listeners.onPeerLeave?.(id);
    onPeerLeave(id);
  };
  const leave = async () => {
    await leaveAction.send("");
    await new Promise((res) => setTimeout(res, 99));
    entries(peerMap).forEach(([id, peer]) => {
      peer.destroy();
      clearPeerState(id, mkErr("room left"));
    });
    unregisterBeforeUnloadCleanup();
    onSelfLeave();
  };
  const pingAction = makeActionInternal(internalNs("ping"));
  const pongAction = makeActionInternal(internalNs("pong"));
  const signalAction = makeActionInternal(internalNs("signal"));
  const streamMetaAction = makeActionInternal(internalNs("stream"));
  const trackMetaAction = makeActionInternal(internalNs("track"));
  const leaveAction = makeActionInternal(internalNs("leave"), {
    sendToPending: true,
    receiveWhilePending: true
  });
  const handshakeDataAction = makeActionInternal(internalNs("hsdata"), {
    sendToPending: true,
    receiveWhilePending: true
  });
  const handshakeReadyAction = makeActionInternal(internalNs("hsready"), {
    sendToPending: true,
    receiveWhilePending: true
  });
  handshakeManager = createHandshakeManager({
    ...onPeerHandshake === void 0 ? {} : { onPeerHandshake },
    ...onHandshakeError === void 0 ? {} : { onHandshakeError },
    handshakeTimeoutMs,
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    onActivate: (id, peer) => {
      activePeerMap[id] = peer;
      listeners.onPeerJoin?.(id);
    },
    onFailure: (id, peer, reason) => exitPeer(id, peer, reason)
  });
  pingAction.onMessage((_, id) => pongAction.send("", id));
  pongAction.onMessage((_, id) => {
    const queue = pendingPongs[id];
    queue?.shift()?.resolve();
    if (queue && !queue.length) delete pendingPongs[id];
  });
  signalAction.onMessage((sdp, id) => {
    if (!activePeerMap[id]) return;
    peerMap[id]?.signal(sdp);
  });
  streamMetaAction.onMessage((meta, id) => mediaManager.receiveStreamMeta(meta, id));
  trackMetaAction.onMessage((meta, id) => mediaManager.receiveTrackMeta(meta, id));
  leaveAction.onMessage((_, id) => exitPeer(id, void 0, mkErr("peer left room")));
  handshakeDataAction.onMessage((data, id, metadata) => handshakeManager?.receiveHandshakeData(data, id, metadata));
  handshakeReadyAction.onMessage((_, id) => handshakeManager?.receiveHandshakeReady(id));
  onPeer((peer, id) => {
    const existingPeer = peerMap[id];
    if (existingPeer) {
      if (existingPeer === peer) return;
      existingPeer.destroy();
      clearPeerState(id, mkErr("peer replaced"));
    }
    peerMap[id] = peer;
    handshakeManager?.addPeer(id, peer);
    peer.setHandlers({
      data: (d) => handleData(id, d),
      stream: (stream) => mediaManager.receiveRemoteStream(id, stream),
      track: (track, stream) => mediaManager.receiveRemoteTrack(id, track, stream),
      signal: (sdp) => {
        if (!activePeerMap[id]) return;
        signalAction.send(sdp, id);
      },
      close: () => exitPeer(id, peer, mkErr("peer disconnected")),
      error: (err) => {
        console.error(`${libName} peer error:`, err);
        exitPeer(id, peer, err);
      }
    });
    handshakeManager?.start(id, peer);
  });
  if (isBrowser) unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() => leave().catch(noOp));
  return {
    makeAction,
    leave,
    ping: async (id) => {
      if (!activePeerMap[id]) throw mkErr(`no active peer with id ${id}`);
      const start = Date.now();
      await new Promise((resolve, reject) => {
        const queue = pendingPongs[id] ??= [];
        const clearFromQueue = () => {
          const currentQueue = pendingPongs[id];
          if (!currentQueue) return;
          const i = currentQueue.indexOf(waiter);
          if (i > -1) currentQueue.splice(i, 1);
          if (!currentQueue.length) delete pendingPongs[id];
        };
        const waiter = {
          resolve: () => {
            clearFromQueue();
            resolve();
          },
          reject: (reason) => {
            clearFromQueue();
            reject(reason);
          }
        };
        queue.push(waiter);
        pingAction.send("", id).catch((err) => waiter.reject(toError(err, "peer disconnected")));
      });
      return Date.now() - start;
    },
    isPassive: () => isPassive,
    getPeers: () => fromEntries(entries(activePeerMap).map(([id, peer]) => [id, peer.connection])),
    addStream: (stream, options = {}) => mediaManager.addStream(stream, options, streamMetaAction.send),
    removeStream: (stream, options = {}) => {
      mediaManager.removeStream(stream, options.target);
    },
    addTrack: (track, stream, options = {}) => mediaManager.addTrack(track, stream, options, trackMetaAction.send),
    removeTrack: (track, options = {}) => {
      mediaManager.removeTrack(track, options.target);
    },
    replaceTrack: (oldTrack, newTrack, options = {}) => mediaManager.replaceTrack(oldTrack, newTrack, options, trackMetaAction.send),
    get onPeerJoin() {
      return listeners.onPeerJoin;
    },
    set onPeerJoin(handler) {
      listeners.onPeerJoin = handler;
      if (handler) keys(activePeerMap).forEach((peerId) => handler(peerId));
    },
    get onPeerLeave() {
      return listeners.onPeerLeave;
    },
    set onPeerLeave(handler) {
      listeners.onPeerLeave = handler;
    },
    get onPeerStream() {
      return mediaManager.onPeerStream;
    },
    set onPeerStream(handler) {
      mediaManager.onPeerStream = handler;
    },
    get onPeerTrack() {
      return mediaManager.onPeerTrack;
    },
    set onPeerTrack(handler) {
      mediaManager.onPeerTrack = handler;
    }
  };
};

// node_modules/@trystero-p2p/core/dist/shared-peer.mjs
var roomFrameVersion = 1;
var roomPresenceFrameVersion = 2;
var wrapRoomFrame = (roomToken, data) => {
  const tokenBytes = encodeBytes(roomToken);
  const frame = new Uint8Array(3 + tokenBytes.byteLength + data.byteLength);
  frame[0] = roomFrameVersion;
  frame[1] = tokenBytes.byteLength >>> 8 & 255;
  frame[2] = tokenBytes.byteLength & 255;
  frame.set(tokenBytes, 3);
  frame.set(data, 3 + tokenBytes.byteLength);
  return frame;
};
var wrapRoomPresenceFrame = (roomToken, isPresent) => {
  const tokenBytes = encodeBytes(roomToken);
  const frame = new Uint8Array(4 + tokenBytes.byteLength);
  frame[0] = roomPresenceFrameVersion;
  frame[1] = Number(isPresent);
  frame[2] = tokenBytes.byteLength >>> 8 & 255;
  frame[3] = tokenBytes.byteLength & 255;
  frame.set(tokenBytes, 4);
  return frame;
};
var unwrapFrame = (data) => {
  const buffer = new Uint8Array(data);
  if (buffer.byteLength < 3) return null;
  if (buffer[0] === roomFrameVersion) {
    const tokenSize2 = (buffer[1] ?? 0) << 8 | (buffer[2] ?? 0);
    const headerSize2 = 3 + tokenSize2;
    if (tokenSize2 <= 0 || buffer.byteLength < headerSize2) return null;
    return {
      type: "room",
      roomToken: decodeBytes(buffer.subarray(3, headerSize2)),
      payload: buffer.subarray(headerSize2).slice().buffer
    };
  }
  if (buffer[0] !== roomPresenceFrameVersion || buffer.byteLength < 4) return null;
  const tokenSize = (buffer[2] ?? 0) << 8 | (buffer[3] ?? 0);
  const headerSize = 4 + tokenSize;
  if (tokenSize <= 0 || buffer.byteLength < headerSize) return null;
  return {
    type: "presence",
    roomToken: decodeBytes(buffer.subarray(4, headerSize)),
    isPresent: buffer[1] === 1
  };
};
var isPeerUnderlyingStale = (peer) => {
  const { connection, channel } = peer;
  return peer.isDead || connection.connectionState === "closed" || connection.connectionState === "failed" || connection.iceConnectionState === "closed" || connection.iceConnectionState === "failed" || channel?.readyState === "closing" || channel?.readyState === "closed";
};
var getConnectedPeerHealth = (peer) => {
  if (isPeerUnderlyingStale(peer)) return "stale";
  const { channel } = peer;
  if (!channel || channel.readyState !== "open") return "transient";
  return "live";
};
var SharedPeerManager = class {
  byApp = {};
  roomPresenceHandlers = {};
  getMap(appId) {
    return this.byApp[appId] ??= {};
  }
  get(appId, peerId) {
    return this.byApp[appId]?.[peerId];
  }
  isPeerStale(peer) {
    return isPeerUnderlyingStale(peer);
  }
  getHealth(peer) {
    return this.isPeerStale(peer) ? "stale" : "live";
  }
  setRoomPresenceHandler(appId, handler) {
    this.roomPresenceHandlers[appId] = handler;
    return () => {
      if (this.roomPresenceHandlers[appId] === handler) delete this.roomPresenceHandlers[appId];
    };
  }
  sendRoomPresence(shared, roomToken, isPresent) {
    if (shared.isClosing || shared.peer.isDead) return;
    shared.peer.sendData(wrapRoomPresenceFrame(roomToken, isPresent));
  }
  clear(appId, peerId, { destroyPeer }) {
    const map = this.byApp[appId];
    const shared = map?.[peerId];
    if (!shared || shared.isClosing) return;
    shared.idleTimer = resetTimer(shared.idleTimer);
    shared.isClosing = true;
    if (destroyPeer && !shared.peer.isDead) shared.peer.destroy();
    const bindings = values(shared.bindings);
    shared.bindings = {};
    shared.bindingsByToken = {};
    shared.controlRoomId = null;
    delete map[peerId];
    bindings.forEach((binding) => {
      binding.handlers.close?.();
      binding.pendingData.length = 0;
      binding.pendingSendData.length = 0;
      binding.pendingTracks.length = 0;
    });
    shared.media.clearRemote();
    shared.pendingDataByToken.clear();
    shared.remoteRoomTokens.clear();
    if (keys(map).length === 0) delete this.byApp[appId];
  }
  register(appId, peerId, peer, idleMs) {
    const map = this.getMap(appId);
    const existing = map[peerId];
    if (existing) {
      existing.idleTimer = resetTimer(existing.idleTimer);
      if (existing.peer === peer) return existing;
      this.clear(appId, peerId, { destroyPeer: true });
    }
    const shared = {
      appId,
      peerId,
      peer,
      bindings: {},
      bindingsByToken: {},
      pendingDataByToken: /* @__PURE__ */ new Map(),
      remoteRoomTokens: /* @__PURE__ */ new Set(),
      idleTimer: null,
      controlRoomId: null,
      streamOwners: /* @__PURE__ */ new Map(),
      trackOwners: /* @__PURE__ */ new Map(),
      media: createMediaIdentityCache(),
      idleMs,
      isClosing: false
    };
    peer.setHandlers({
      data: (data) => this.dispatchData(shared, data),
      signal: (signal) => this.dispatchSignal(shared, signal),
      close: () => this.clear(appId, peerId, { destroyPeer: false }),
      error: (err) => {
        console.error(`${libName} peer error:`, err);
        this.clear(appId, peerId, { destroyPeer: false });
      },
      track: (track, stream) => this.dispatchTrack(shared, track, stream)
    });
    map[peerId] = shared;
    return shared;
  }
  bind(roomId, roomTokenPromise, shared, { onDetach }) {
    const existingBinding = shared.bindings[roomId];
    if (existingBinding) {
      shared.idleTimer = resetTimer(shared.idleTimer);
      return {
        proxy: existingBinding.proxy,
        isNew: false
      };
    }
    const binding = {
      roomId,
      roomToken: null,
      roomTokenPromise,
      handlers: {},
      pendingData: [],
      pendingSendData: [],
      pendingTracks: [],
      detach: noOp,
      proxy: {}
    };
    const detachBinding = () => {
      if (!shared.bindings[roomId]) return;
      this.pruneRoomOwnership(shared, roomId);
      delete shared.bindings[roomId];
      if (binding.roomToken && shared.bindingsByToken[binding.roomToken] === binding) delete shared.bindingsByToken[binding.roomToken];
      if (shared.controlRoomId === roomId) shared.controlRoomId = keys(shared.bindings)[0] ?? null;
      onDetach();
      this.scheduleIdleTimer(shared);
    };
    const proxy = {
      created: shared.peer.created,
      get connection() {
        return shared.peer.connection;
      },
      get channel() {
        return shared.peer.channel;
      },
      get isDead() {
        return shared.peer.isDead;
      },
      getOffer: (restartIce) => shared.peer.getOffer(restartIce),
      signal: (sdp) => shared.peer.signal(sdp),
      sendData: (data) => {
        if (!binding.roomToken) {
          binding.pendingSendData.push(data);
          return;
        }
        shared.peer.sendData(wrapRoomFrame(binding.roomToken, data));
      },
      destroy: () => detachBinding(),
      setHandlers: (newHandlers) => {
        const { signal, ...rest } = newHandlers;
        Object.assign(binding.handlers, rest);
        if (signal) binding.handlers.signal = signal;
        this.flushBindingQueues(binding);
      },
      offerPromise: shared.peer.offerPromise,
      addStream: (stream) => {
        const owners = shared.streamOwners.get(stream) ?? /* @__PURE__ */ new Set();
        const shouldAttach = owners.size === 0;
        owners.add(roomId);
        shared.streamOwners.set(stream, owners);
        if (shouldAttach) shared.peer.addStream(stream);
      },
      removeStream: (stream) => {
        const owners = shared.streamOwners.get(stream);
        if (!owners) return;
        owners.delete(roomId);
        if (owners.size === 0) {
          shared.streamOwners.delete(stream);
          shared.peer.removeStream(stream);
        }
      },
      addTrack: (track, stream) => {
        const entry = shared.trackOwners.get(track) ?? {
          stream,
          rooms: /* @__PURE__ */ new Set()
        };
        const shouldAttach = entry.rooms.size === 0;
        entry.stream = stream;
        entry.rooms.add(roomId);
        shared.trackOwners.set(track, entry);
        if (shouldAttach) return shared.peer.addTrack(track, stream);
        return shared.peer.connection.getSenders().find((s) => s.track === track) ?? shared.peer.addTrack(track, stream);
      },
      removeTrack: (track) => {
        const entry = shared.trackOwners.get(track);
        if (!entry) return;
        entry.rooms.delete(roomId);
        if (entry.rooms.size === 0) {
          shared.trackOwners.delete(track);
          shared.peer.removeTrack(track);
        }
      },
      replaceTrack: (oldTrack, newTrack) => {
        const oldEntry = shared.trackOwners.get(oldTrack);
        if (oldEntry) {
          shared.trackOwners.delete(oldTrack);
          const nextEntry = shared.trackOwners.get(newTrack) ?? {
            stream: oldEntry.stream,
            rooms: /* @__PURE__ */ new Set()
          };
          oldEntry.rooms.forEach((room) => nextEntry.rooms.add(room));
          shared.trackOwners.set(newTrack, nextEntry);
        }
        return shared.peer.replaceTrack(oldTrack, newTrack);
      },
      __trysteroMedia: shared.media
    };
    binding.proxy = proxy;
    binding.detach = detachBinding;
    shared.bindings[roomId] = binding;
    shared.controlRoomId ??= roomId;
    shared.idleTimer = resetTimer(shared.idleTimer);
    roomTokenPromise.then((roomToken) => {
      if (shared.isClosing || shared.bindings[roomId] !== binding) return;
      binding.roomToken = roomToken;
      shared.bindingsByToken[roomToken] = binding;
      const pendingData = shared.pendingDataByToken.get(roomToken);
      if (pendingData?.length) {
        binding.pendingData.push(...pendingData);
        shared.pendingDataByToken.delete(roomToken);
      }
      binding.pendingSendData.splice(0).forEach((payload) => shared.peer.sendData(wrapRoomFrame(roomToken, payload)));
      this.flushBindingQueues(binding);
    });
    return {
      proxy,
      isNew: true
    };
  }
  pruneRoomOwnership(shared, roomIdToRemove) {
    shared.streamOwners.forEach((rooms, stream) => {
      rooms.delete(roomIdToRemove);
      if (rooms.size === 0) {
        shared.streamOwners.delete(stream);
        shared.peer.removeStream(stream);
      }
    });
    shared.trackOwners.forEach((entry, track) => {
      entry.rooms.delete(roomIdToRemove);
      if (entry.rooms.size === 0) {
        shared.trackOwners.delete(track);
        shared.peer.removeTrack(track);
      }
    });
  }
  scheduleIdleTimer(shared) {
    if (shared.isClosing || keys(shared.bindings).length > 0) return;
    shared.idleTimer = resetTimer(shared.idleTimer);
    shared.idleTimer = setTimeout(() => {
      const current = this.byApp[shared.appId]?.[shared.peerId];
      if (!current || keys(current.bindings).length > 0) return;
      this.clear(shared.appId, shared.peerId, { destroyPeer: true });
    }, shared.idleMs);
  }
  getSignalBinding(shared) {
    if (shared.controlRoomId) {
      const selected = shared.bindings[shared.controlRoomId];
      if (selected?.handlers.signal) return selected;
    }
    const fallback = values(shared.bindings).find((binding) => Boolean(binding.handlers.signal));
    if (!fallback) return null;
    shared.controlRoomId = fallback.roomId;
    return fallback;
  }
  flushBindingQueues(binding) {
    const { handlers } = binding;
    if (handlers.data && binding.pendingData.length > 0) binding.pendingData.splice(0).forEach((payload) => handlers.data?.(payload));
    if ((handlers.track || handlers.stream) && binding.pendingTracks.length) binding.pendingTracks.splice(0).forEach(({ track, stream }) => {
      handlers.track?.(track, stream);
      handlers.stream?.(stream);
    });
  }
  dispatchData(shared, data) {
    const decoded = unwrapFrame(data);
    if (!decoded) return;
    if (decoded.type === "presence") {
      if (decoded.isPresent) shared.remoteRoomTokens.add(decoded.roomToken);
      else shared.remoteRoomTokens.delete(decoded.roomToken);
      this.roomPresenceHandlers[shared.appId]?.(shared.peerId, decoded.roomToken, decoded.isPresent);
      return;
    }
    const binding = shared.bindingsByToken[decoded.roomToken];
    if (!binding) {
      const pending = shared.pendingDataByToken.get(decoded.roomToken) ?? [];
      pending.push(decoded.payload);
      shared.pendingDataByToken.set(decoded.roomToken, pending);
      return;
    }
    if (binding.handlers.data) binding.handlers.data(decoded.payload);
    else binding.pendingData.push(decoded.payload);
  }
  dispatchSignal(shared, signal) {
    this.getSignalBinding(shared)?.handlers.signal?.(signal);
  }
  dispatchTrack(shared, track, stream) {
    values(shared.bindings).forEach((binding) => {
      if (binding.handlers.track || binding.handlers.stream) {
        binding.handlers.track?.(track, stream);
        binding.handlers.stream?.(stream);
        return;
      }
      binding.pendingTracks.push({
        track,
        stream
      });
    });
  }
};

// node_modules/@trystero-p2p/core/dist/signal-handler.mjs
var offerPostAnswerTtlMs = 23333;
var offerIdSize = 12;
var disconnectedPeerGraceMs = 7533;
var answeringTtlMs = 23333;
var legacyCandidateKey = "__legacy__";
var offerRelayPlaceholder = "offer-placeholder";
var signalKeys = [
  "offer",
  "answer",
  "candidate"
];
var toPayload = (msg) => {
  if (typeof msg === "string") try {
    const parsed = fromJson(msg);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
  return msg && typeof msg === "object" ? msg : null;
};
var getString = (payload, key) => typeof payload[key] === "string" && payload[key] ? payload[key] : void 0;
var hasInvalidSignalField = (payload) => signalKeys.some((key) => key in payload && (typeof payload[key] !== "string" || payload[key] === ""));
var publishCipheredSignalingMessage = (ctx, signal, peerTopic, signalPeer, buildPayload, stillValid) => {
  ctx.toCipher(signal).then((encryptedSignal) => {
    if (ctx.isLeaving() || !stillValid()) return;
    signalPeer(peerTopic, toJson(buildPayload(encryptedSignal.sdp)));
  });
};
var makeState = () => ({
  status: "idle",
  offerPeer: null,
  offerId: null,
  offerSdp: null,
  offerInitPromise: null,
  offerAnswered: false,
  offerRelays: [],
  offerSignalRelays: [],
  offerSignalBacklog: [],
  offerRelayTimers: [],
  offerExpiryTimer: null,
  connectedPeer: null,
  connectedPeerUnhealthySinceMs: null,
  answeringExpiryTimer: null,
  answeringPeer: null,
  answerSent: false,
  connectionErrorReported: false,
  pendingCandidates: {}
});
var hasTurnServer = (config) => {
  return [...config.turnConfig ?? [], ...config.rtcConfig?.iceServers ?? []].some(({ urls }) => {
    return (Array.isArray(urls) ? urls : [urls]).some((url) => /^turns?:/i.test(url));
  });
};
var getSdpExchangeConnectionError = (peerId, config) => `could not connect to peer ${peerId} after exchanging SDP; ${hasTurnServer(config) ? "check that your TURN server URLs and credentials are reachable by both peers" : "configure TURN servers with turnConfig or rtcConfig.iceServers"}`;
var reportSdpExchangeConnectionFailure = (ctx, state, peerId) => {
  if (ctx.isLeaving() || state.connectedPeer || state.connectionErrorReported) return;
  state.connectionErrorReported = true;
  ctx.onJoinError?.({
    error: getSdpExchangeConnectionError(peerId, ctx.config),
    appId: ctx.appId,
    peerId,
    roomId: ctx.roomId
  });
};
var getState = (peerStates, peerId) => peerStates[peerId] ??= makeState();
var updateStatus = (state) => {
  if (state.connectedPeer) state.status = "connected";
  else if (state.answeringPeer) state.status = "answering";
  else if (state.offerPeer || state.offerRelays.some(Boolean)) state.status = "offering";
  else state.status = "idle";
};
var clearAnswering = (state, peer) => {
  if (state.answeringPeer === peer) {
    state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
    state.answeringPeer = null;
    state.answerSent = false;
    updateStatus(state);
  }
};
var clearConnectedPeer = (state, peerId, _reason) => {
  if (!state.connectedPeer) return;
  if (!state.connectedPeer.isDead) state.connectedPeer.destroy();
  state.connectedPeer = null;
  state.connectedPeerUnhealthySinceMs = null;
  updateStatus(state);
};
var clearOfferRelay = (state, relayId) => {
  state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId]);
  if (state.offerRelays[relayId]) {
    state.offerRelays[relayId] = void 0;
    updateStatus(state);
  }
};
var clearOfferRelayIfPlaceholder = (state, relayId) => {
  if (state?.offerRelays[relayId] === offerRelayPlaceholder) clearOfferRelay(state, relayId);
};
var hasRemoteDescription = (peer) => {
  if (peer.isDead || peer.connection.connectionState === "closed") return true;
  try {
    return Boolean(peer.connection.remoteDescription);
  } catch {
    return true;
  }
};
var resetOfferState = (state, offerPool) => {
  const previousOfferAnswered = state.offerAnswered;
  state.offerExpiryTimer = resetTimer(state.offerExpiryTimer);
  state.offerInitPromise = null;
  state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId));
  state.offerRelays = [];
  state.offerSignalRelays = [];
  state.offerRelayTimers = [];
  state.offerSignalBacklog = [];
  if (state.offerPeer && state.offerPeer !== state.connectedPeer) if (previousOfferAnswered || hasRemoteDescription(state.offerPeer)) {
    if (!state.offerPeer.isDead) state.offerPeer.destroy();
  } else offerPool.recycle(state.offerPeer);
  state.offerPeer = null;
  state.offerId = null;
  state.offerSdp = null;
  state.offerAnswered = false;
  state.connectionErrorReported = false;
  updateStatus(state);
};
var scheduleAnsweringExpiry = (ctx, state, peerId, peer) => {
  resetTimer(state.answeringExpiryTimer);
  state.answeringExpiryTimer = setTimeout(() => {
    const current = ctx.peerStates[peerId];
    if (!current || current.connectedPeer || current.answeringPeer !== peer) return;
    if (current.answerSent) reportSdpExchangeConnectionFailure(ctx, current, peerId);
    peer.destroy();
    clearAnswering(current, peer);
    ctx.checkDeactivate();
  }, answeringTtlMs);
};
var flushBufferedCandidates = async (state, peer, offerId) => {
  const bufferKeys = offerId ? [offerId, legacyCandidateKey] : [legacyCandidateKey];
  for (const key of bufferKeys) {
    const buffered = state.pendingCandidates[key];
    if (!buffered?.length) continue;
    delete state.pendingCandidates[key];
    for (const candidate of buffered) await peer.signal(candidate);
  }
};
var scheduleOfferExpiry = (ctx, state, peerId, ttlMs = offerTtl) => {
  resetTimer(state.offerExpiryTimer);
  const offerId = state.offerId;
  state.offerExpiryTimer = setTimeout(() => {
    const current = ctx.peerStates[peerId];
    if (!current || current.connectedPeer || current.offerId !== offerId) return;
    if (current.offerAnswered) reportSdpExchangeConnectionFailure(ctx, current, peerId);
    resetOfferState(current, ctx.offerPool);
    ctx.checkDeactivate();
  }, ttlMs);
};
var ensureOffer = (ctx, state, peerId, relayId) => {
  if (state.offerPeer && state.offerId && state.offerSdp) return Promise.resolve({
    peer: state.offerPeer,
    offer: state.offerSdp,
    offerId: state.offerId
  });
  if (state.offerInitPromise) return state.offerInitPromise;
  state.offerInitPromise = (async () => {
    const firstOffer = (await ctx.offerPool.checkout(1, false, ctx.encryptOffer))[0];
    if (!firstOffer) throw mkErr("failed to allocate offer peer");
    const { peer, offer } = firstOffer;
    state.offerPeer = peer;
    state.offerId = genId(offerIdSize);
    state.offerSdp = offer;
    state.offerAnswered = false;
    state.connectionErrorReported = false;
    state.offerSignalBacklog = [];
    updateStatus(state);
    const onOfferPeerClosedOrError = () => {
      if (state.offerPeer === peer && !state.connectedPeer) {
        if (state.offerAnswered) reportSdpExchangeConnectionFailure(ctx, state, peerId);
        resetOfferState(state, ctx.offerPool);
      }
      ctx.disconnectPeer(peer, peerId);
      ctx.checkDeactivate();
    };
    peer.setHandlers({
      connect: () => ctx.connectPeer(peer, peerId, relayId),
      signal: (signal) => {
        if (state.offerPeer !== peer) return;
        state.offerSignalBacklog.push(signal);
        state.offerSignalRelays.forEach((sendSignal) => sendSignal?.(signal));
      },
      close: onOfferPeerClosedOrError,
      error: onOfferPeerClosedOrError
    });
    scheduleOfferExpiry(ctx, state, peerId);
    return {
      peer,
      offer,
      offerId: state.offerId
    };
  })().finally(() => state.offerInitPromise = null);
  return state.offerInitPromise;
};
var handleAnnouncement = async (ctx, relayId, peerId, shared, signalPeer) => {
  if (shared) {
    ctx.attachSharedPeerToRoom(peerId, shared);
    return;
  }
  const state = ctx.peerStates[peerId];
  if (!state || state.connectedPeer || state.answeringPeer || state.offerAnswered) {
    clearOfferRelayIfPlaceholder(state, relayId);
    return;
  }
  if (state.offerRelays[relayId] !== offerRelayPlaceholder) return;
  const [peerTopic, offerInfo] = await all([sha1(topicPath(ctx.rootTopicPlaintext, peerId)), ensureOffer(ctx, state, peerId, relayId)]);
  if (ctx.isLeaving()) return;
  if (state.connectedPeer || state.answeringPeer || state.offerAnswered || state.offerRelays[relayId] !== offerRelayPlaceholder) {
    clearOfferRelayIfPlaceholder(state, relayId);
    return;
  }
  state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId]);
  state.offerRelays[relayId] = true;
  updateStatus(state);
  state.offerRelayTimers[relayId] = setTimeout(() => prunePendingOffer(ctx, peerId, relayId), (ctx.announceIntervals[relayId] ?? ctx.announceIntervalMs) * 0.9);
  let didSendOffer = false;
  state.offerSignalRelays[relayId] = (signal) => {
    if (!didSendOffer) return;
    if (ctx.isLeaving() || state.connectedPeer || state.offerPeer !== offerInfo.peer || state.offerId !== offerInfo.offerId || signal.type !== "candidate") return;
    publishCipheredSignalingMessage(ctx, signal, peerTopic, signalPeer, (sdp) => ({
      peerId: selfId,
      offerId: offerInfo.offerId,
      candidate: sdp,
      ...ctx.isPassive ? { passive: true } : {}
    }), () => !state.connectedPeer && state.offerPeer === offerInfo.peer && state.offerId === offerInfo.offerId);
  };
  signalPeer(peerTopic, toJson({
    peerId: selfId,
    offerId: offerInfo.offerId,
    offer: offerInfo.offer,
    ...ctx.isPassive ? { passive: true } : {}
  }));
  didSendOffer = true;
  state.offerSignalBacklog.forEach((signal) => state.offerSignalRelays[relayId]?.(signal));
};
var handleOffer = async (ctx, relayId, peerId, offer, offerId, hasOutgoingOfferHint, signalPeer) => {
  const state = getState(ctx.peerStates, peerId);
  if (state.answeringPeer || state.offerAnswered) return;
  const hasTrackedOutgoingOffer = Boolean(state.offerPeer || state.offerRelays.some(Boolean));
  if ((hasTrackedOutgoingOffer || hasOutgoingOfferHint) && selfId < peerId) return;
  if (hasTrackedOutgoingOffer) resetOfferState(state, ctx.offerPool);
  const answerPeer = ctx.initPeer(false, ctx.config);
  state.answeringPeer = answerPeer;
  state.answerSent = false;
  state.connectionErrorReported = false;
  scheduleAnsweringExpiry(ctx, state, peerId, answerPeer);
  updateStatus(state);
  const onAnswerPeerClosedOrError = () => {
    if (state.answeringPeer === answerPeer && !state.connectedPeer && state.answerSent) reportSdpExchangeConnectionFailure(ctx, state, peerId);
    clearAnswering(state, answerPeer);
    ctx.disconnectPeer(answerPeer, peerId);
    ctx.checkDeactivate();
  };
  answerPeer.setHandlers({
    connect: () => ctx.connectPeer(answerPeer, peerId, relayId),
    close: onAnswerPeerClosedOrError,
    error: onAnswerPeerClosedOrError
  });
  let plainOffer;
  try {
    plainOffer = await ctx.toPlain({
      type: "offer",
      sdp: offer
    });
  } catch {
    clearAnswering(state, answerPeer);
    ctx.onJoinError?.({
      error: "incorrect room password when decrypting offer",
      appId: ctx.appId,
      peerId,
      roomId: ctx.roomId
    });
    return;
  }
  if (answerPeer.isDead) {
    clearAnswering(state, answerPeer);
    return;
  }
  const peerTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
  if (ctx.isLeaving()) return;
  answerPeer.setHandlers({ signal: (signal) => {
    if (ctx.isLeaving() || state.answeringPeer !== answerPeer || answerPeer.isDead) return;
    if (signal.type !== "answer" && signal.type !== "candidate") return;
    publishCipheredSignalingMessage(ctx, signal, peerTopic, signalPeer, (sdp) => {
      const payloadToSend = { peerId: selfId };
      if (signal.type === "answer") {
        state.answerSent = true;
        payloadToSend["answer"] = sdp;
      } else payloadToSend["candidate"] = sdp;
      if (offerId) payloadToSend["offerId"] = offerId;
      if (ctx.isPassive) payloadToSend["passive"] = true;
      return payloadToSend;
    }, () => state.answeringPeer === answerPeer && !answerPeer.isDead);
  } });
  await answerPeer.signal(plainOffer);
  await flushBufferedCandidates(state, answerPeer, offerId);
};
var handleCandidate = async (ctx, peerId, candidate, offerId, peer) => {
  let plainCandidate;
  try {
    plainCandidate = await ctx.toPlain({
      type: candidateType,
      sdp: candidate
    });
  } catch {
    return;
  }
  const state = getState(ctx.peerStates, peerId);
  const offerPeerMatch = offerId && state?.offerPeer && state.offerId === offerId ? state.offerPeer : null;
  const answeringPeer = state?.answeringPeer ?? null;
  const fallbackOfferPeer = !offerId && state?.offerPeer ? state.offerPeer : null;
  const targetPeer = peer && !peer.isDead ? peer : offerPeerMatch ?? answeringPeer ?? fallbackOfferPeer;
  if (!targetPeer || targetPeer.isDead) {
    const pendingKey = offerId ?? legacyCandidateKey;
    (state.pendingCandidates[pendingKey] ??= []).push(plainCandidate);
    return;
  }
  targetPeer.signal(plainCandidate);
};
var handleAnswer = async (ctx, relayId, peerId, answer, offerId, peer) => {
  let plainAnswer;
  try {
    plainAnswer = await ctx.toPlain({
      type: "answer",
      sdp: answer
    });
  } catch {
    ctx.onJoinError?.({
      error: "incorrect room password when decrypting answer",
      appId: ctx.appId,
      peerId,
      roomId: ctx.roomId
    });
    return;
  }
  if (peer) {
    ctx.offerPool.claimLeased(peer);
    peer.setHandlers({
      connect: () => ctx.connectPeer(peer, peerId, relayId),
      close: () => ctx.disconnectPeer(peer, peerId)
    });
    peer.signal(plainAnswer);
  } else {
    const state = ctx.peerStates[peerId];
    if (!state || !state.offerPeer || state.offerAnswered || offerId && state.offerId && offerId !== state.offerId || state.offerPeer.isDead) return;
    state.offerAnswered = true;
    scheduleOfferExpiry(ctx, state, peerId, offerPostAnswerTtlMs);
    state.offerPeer.signal(plainAnswer);
  }
};
var prunePendingOffer = (ctx, peerId, relayId) => {
  const state = ctx.peerStates[peerId];
  if (!state || state.connectedPeer) return;
  if (state.offerRelays[relayId]) {
    clearOfferRelay(state, relayId);
    ctx.checkDeactivate();
  }
};
var createSignalHandler = (ctx) => (relayId) => async (topic, msg, signalPeer) => {
  if (ctx.isLeaving()) return;
  const payload = toPayload(msg);
  if (!payload || hasInvalidSignalField(payload)) return;
  const peerId = getString(payload, "peerId") ?? "";
  const offer = getString(payload, "offer");
  const answer = getString(payload, "answer");
  const candidate = getString(payload, "candidate");
  const offerId = getString(payload, "offerId");
  const peer = payload["peer"];
  const hasOutgoingOfferHint = payload["hasOutgoingOffer"] === true;
  const remoteIsPassive = payload["passive"] === true;
  if (!peerId || peerId === selfId) return;
  const [rootTopic, selfTopic] = await all([ctx.rootTopicP, ctx.selfTopicP]);
  if (ctx.isLeaving()) return;
  if (topic !== rootTopic && topic !== selfTopic) return;
  if (ctx.isPassive && remoteIsPassive) return;
  if (ctx.isPassive && !ctx.isActive && !answer && !candidate) {
    ctx.isActive = true;
    ctx.requeueAnnounce?.();
  }
  if (ctx.isPassive && !ctx.isActive) return;
  const state = ctx.peerStates[peerId];
  const connectedPeer = state?.connectedPeer;
  if (connectedPeer && state) {
    const health = getConnectedPeerHealth(connectedPeer);
    if (health === "live") {
      state.connectedPeerUnhealthySinceMs = null;
      return;
    }
    if (health === "stale") clearConnectedPeer(state, peerId, "message-from-stale-peer");
    else {
      const nowMs = Date.now();
      const unhealthySinceMs = state.connectedPeerUnhealthySinceMs ?? nowMs;
      state.connectedPeerUnhealthySinceMs = unhealthySinceMs;
      if (nowMs - unhealthySinceMs < disconnectedPeerGraceMs) return;
      clearConnectedPeer(state, peerId, "message-from-prolonged-disconnect");
    }
  }
  let shared = ctx.sharedPeers.get(ctx.appId, peerId);
  if (shared && ctx.sharedPeers.getHealth(shared.peer) === "stale") {
    ctx.sharedPeers.clear(ctx.appId, peerId, { destroyPeer: true });
    shared = void 0;
  }
  const isAnnouncement = Boolean(peerId && !offer && !answer && !candidate);
  if (isAnnouncement && !shared) {
    const announcePeerState = getState(ctx.peerStates, peerId);
    const shouldLeadOffer = selfId < peerId;
    if (announcePeerState.answeringPeer || announcePeerState.connectedPeer || announcePeerState.offerAnswered) return;
    if (!shouldLeadOffer && !announcePeerState.offerPeer) {
      const peerSelfTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId));
      if (!ctx.isLeaving() && !announcePeerState.connectedPeer) signalPeer(peerSelfTopic, toJson({ peerId: selfId }));
      return;
    }
    if (announcePeerState.offerRelays[relayId]) return;
    announcePeerState.offerRelays[relayId] = offerRelayPlaceholder;
    updateStatus(announcePeerState);
  }
  if (shared && (offer || answer || candidate)) {
    if (shared.bindings[ctx.roomId]) return;
    ctx.attachSharedPeerToRoom(peerId, shared);
    return;
  }
  if (isAnnouncement) return handleAnnouncement(ctx, relayId, peerId, shared, signalPeer);
  if (offer) return handleOffer(ctx, relayId, peerId, offer, offerId, hasOutgoingOfferHint, signalPeer);
  if (candidate) return handleCandidate(ctx, peerId, candidate, offerId, peer);
  if (answer) return handleAnswer(ctx, relayId, peerId, answer, offerId, peer);
};

// node_modules/@trystero-p2p/core/dist/strategy.mjs
var announceIntervalMs = 5333;
var announceWarmupIntervalsMs = [
  233,
  533,
  1333
];
var passiveActivationGraceMs = 7533;
var sharedPeerIdleMsDefault = 123333;
var strategy_default = ({ init, subscribe, announce, deactivate }) => {
  const occupiedRooms = {};
  const roomRegistrations = {};
  const roomIdsByToken = {};
  const roomPresenceHandlerCleanups = {};
  const sharedPeers = new SharedPeerManager();
  const hasActiveRooms = () => values(occupiedRooms).some((rooms) => keys(rooms).length > 0);
  const getRoomRegistrations = (appId) => roomRegistrations[appId] ??= {};
  const getRoomIdsByToken = (appId) => roomIdsByToken[appId] ??= {};
  const advertiseRoomPresence = (shared, roomToken, isPresent) => {
    if (sharedPeers.getHealth(shared.peer) === "live") sharedPeers.sendRoomPresence(shared, roomToken, isPresent);
  };
  const advertiseKnownRoomsToShared = (appId, shared) => {
    entries(roomRegistrations[appId] ?? {}).forEach(([roomId, registration]) => {
      if (!registration.shouldAdvertise()) return;
      const { roomToken, roomTokenPromise } = registration;
      if (roomToken) {
        advertiseRoomPresence(shared, roomToken, true);
        return;
      }
      roomTokenPromise.then((token) => {
        if (roomRegistrations[appId]?.[roomId] !== registration) return;
        if (registration.roomToken !== token) return;
        if (sharedPeers.get(appId, shared.peerId) !== shared || shared.isClosing) return;
        if (!registration.shouldAdvertise()) return;
        advertiseRoomPresence(shared, token, true);
      });
    });
  };
  const advertiseRoomPresenceToAll = (appId, roomToken, isPresent) => values(sharedPeers.getMap(appId)).forEach((shared) => advertiseRoomPresence(shared, roomToken, isPresent));
  const ensureRoomPresenceHandler = (appId) => {
    if (roomPresenceHandlerCleanups[appId]) return;
    roomPresenceHandlerCleanups[appId] = sharedPeers.setRoomPresenceHandler(appId, (peerId, roomToken, isPresent) => {
      if (!isPresent) return;
      const shared = sharedPeers.get(appId, peerId);
      const roomId = roomIdsByToken[appId]?.[roomToken];
      if (!shared || !roomId) return;
      roomRegistrations[appId]?.[roomId]?.attachSharedPeerToRoom(peerId, shared);
    });
  };
  const cleanupRoomPresenceHandler = (appId) => {
    if (occupiedRooms[appId] && keys(occupiedRooms[appId]).length > 0) return;
    roomPresenceHandlerCleanups[appId]?.();
    delete roomPresenceHandlerCleanups[appId];
    delete roomRegistrations[appId];
    delete roomIdsByToken[appId];
  };
  let didInit = false;
  let initPromises = [];
  let offerPool = null;
  let cleanupWatchOnline = noOp;
  return (config, roomId, callbacks) => {
    if (!config) throw mkErr("requires a config map as the first argument");
    if (callbacks && typeof callbacks !== "object") throw mkErr("third argument must be a callbacks object");
    const { appId } = config;
    const onJoinError = callbacks?.onJoinError;
    const onPeerHandshake = callbacks?.onPeerHandshake;
    const handshakeTimeoutMs = callbacks?.handshakeTimeoutMs;
    if (!appId) throw mkErr("config map is missing appId field");
    if (!roomId) throw mkErr("roomId argument required");
    if (handshakeTimeoutMs !== void 0 && (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0)) throw mkErr("handshakeTimeoutMs must be a positive number");
    if (occupiedRooms[appId]?.[roomId]) return occupiedRooms[appId][roomId];
    ensureRoomPresenceHandler(appId);
    const rootTopicPlaintext = topicPath(libName, appId, roomId);
    const rootTopicP = sha1(rootTopicPlaintext);
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId));
    const key = genKey(config.password ?? "", appId, roomId);
    const roomNamespacePromise = deriveRoomNamespace(appId, roomId);
    const sharedPeerIdleMs = config._test_only_sharedPeerIdleMs ?? sharedPeerIdleMsDefault;
    let didLeaveRoom = false;
    const withKey = (f) => async (signal) => ({
      type: signal.type,
      sdp: await f(key, signal.sdp)
    });
    const toPlain = withKey(decrypt);
    const toCipher = withKey(encrypt);
    const sharedPeerMap = sharedPeers.getMap(appId);
    const makeOffer = () => peer_default(true, config);
    offerPool ||= new OfferPool(makeOffer);
    const pool = offerPool;
    const encryptOffer = async (peer) => {
      const plainOffer = await peer.getOffer(Date.now() - peer.created > offerTtl);
      if (!plainOffer || plainOffer.type !== "offer") throw mkErr("failed to get offer for peer");
      return (await toCipher(plainOffer)).sdp;
    };
    const attachSharedPeerToRoom = (peerId, shared) => {
      const state = getState(ctx.peerStates, peerId);
      state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
      state.answeringPeer = null;
      const { proxy, isNew } = sharedPeers.bind(roomId, roomNamespacePromise, shared, { onDetach: () => {
        const current = ctx.peerStates[peerId];
        if (current?.connectedPeer === shared.peer) {
          current.connectedPeer = null;
          current.connectedPeerUnhealthySinceMs = null;
          updateStatus(current);
        }
      } });
      state.connectedPeer = shared.peer;
      state.connectedPeerUnhealthySinceMs = null;
      updateStatus(state);
      if (isNew) onPeerConnect(proxy, peerId);
      resetOfferState(state, pool);
    };
    const connectPeer = (peer, peerId, _relayId) => {
      if (didLeaveRoom) {
        peer.destroy();
        return;
      }
      const state = getState(ctx.peerStates, peerId);
      if (state.connectedPeer) {
        const shared2 = sharedPeerMap[peerId];
        if (shared2 && state.connectedPeer === shared2.peer && shared2.bindings[roomId]) return;
        if (state.connectedPeer !== peer && !peer.isDead) peer.destroy();
        return;
      }
      let shared = sharedPeerMap[peerId];
      if (shared && sharedPeers.getHealth(shared.peer) === "stale") {
        sharedPeers.clear(appId, peerId, { destroyPeer: true });
        shared = void 0;
      }
      if (shared && shared.peer !== peer) {
        if (!peer.isDead) peer.destroy();
        attachSharedPeerToRoom(peerId, shared);
        return;
      }
      const isNewShared = !shared;
      shared ||= sharedPeers.register(appId, peerId, peer, sharedPeerIdleMs);
      attachSharedPeerToRoom(peerId, shared);
      if (isNewShared) advertiseKnownRoomsToShared(appId, shared);
    };
    const disconnectPeer = (peer, peerId) => {
      if (didLeaveRoom) return;
      const state = ctx.peerStates[peerId];
      if (state?.connectedPeer === peer) {
        clearConnectedPeer(state, peerId, "close-event");
        checkDeactivate();
      }
    };
    const isPassive = Boolean(config.passive);
    let roomRegistration = null;
    let passiveActivationTimeout;
    let deactivateRelayAnnouncements = noOp;
    const checkDeactivate = () => {
      if (!isPassive || !ctx.isActive) return;
      let hasActiveWork = false;
      entries(ctx.peerStates).forEach(([peerId, state]) => {
        if (state.connectedPeer || state.answeringPeer || state.offerInitPromise || state.offerPeer || state.offerRelays.some(Boolean)) hasActiveWork = true;
        else if (state.status === "idle") delete ctx.peerStates[peerId];
      });
      if (!hasActiveWork) {
        ctx.isActive = false;
        passiveActivationTimeout = resetTimer(passiveActivationTimeout);
        announceTimeouts.forEach(resetTimer);
        announceTimeouts.length = 0;
        deactivateRelayAnnouncements();
        if (roomRegistration?.roomToken) advertiseRoomPresenceToAll(appId, roomRegistration.roomToken, false);
      }
    };
    const ctx = {
      appId,
      roomId,
      config,
      peerStates: {},
      rootTopicPlaintext,
      rootTopicP,
      selfTopicP,
      toPlain,
      toCipher,
      isLeaving: () => didLeaveRoom,
      isPassive,
      isActive: !isPassive,
      onJoinError,
      sharedPeers,
      offerPool: pool,
      encryptOffer,
      initPeer: peer_default,
      connectPeer,
      disconnectPeer,
      attachSharedPeerToRoom,
      checkDeactivate,
      announceIntervals: [],
      announceIntervalMs
    };
    const strategyContext = {
      config,
      appId,
      roomId,
      isPassive
    };
    const handleMessage = createSignalHandler(ctx);
    if (!didInit) {
      const initRes = init(config);
      initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map((value) => Promise.resolve(value));
      didInit = true;
      cleanupWatchOnline = config.relayConfig?.manualReconnection ? noOp : watchOnline();
    }
    if (!isPassive && !pool.isActive) pool.warmup();
    ctx.announceIntervals = initPromises.map(() => announceIntervalMs);
    const announceAttemptCounts = initPromises.map(() => 0);
    const announceErrorStreaks = initPromises.map(() => 0);
    const announceTimeouts = [];
    const unsubFns = initPromises.map(async (relayP, i) => subscribe(await relayP, await rootTopicP, await selfTopicP, handleMessage(i), (n) => pool.getOffers(n, encryptOffer), strategyContext));
    all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
      if (didLeaveRoom) return;
      const queueAnnounce = async (relay, i) => {
        if (didLeaveRoom) return;
        if (isPassive && !ctx.isActive) return;
        const extra = isPassive ? { passive: true } : void 0;
        let ms = void 0;
        try {
          ms = await announce(relay, rootTopic, selfTopic, extra, strategyContext);
          announceErrorStreaks[i] = 0;
        } catch (error) {
          const errorStreak = announceErrorStreaks[i] ?? 0;
          if (errorStreak === 0) console.warn(`${libName}: announce failed - ${toErrorMessage(error, "")}`);
          announceErrorStreaks[i] = errorStreak + 1;
        }
        if (didLeaveRoom || isPassive && !ctx.isActive) return;
        if (typeof ms === "number") ctx.announceIntervals[i] = ms;
        const announceAttempt = announceAttemptCounts[i] ?? 0;
        announceAttemptCounts[i] = announceAttempt + 1;
        const currentInterval = ctx.announceIntervals[i] ?? announceIntervalMs;
        const warmupDelay = announceWarmupIntervalsMs[announceAttempt];
        announceTimeouts[i] = setTimeout(() => {
          queueAnnounce(relay, i);
        }, typeof warmupDelay === "number" ? Math.min(currentInterval, warmupDelay) : currentInterval);
      };
      deactivateRelayAnnouncements = () => {
        if (!deactivate) return;
        initPromises.forEach(async (relayP) => {
          const relay = await relayP;
          if (!didLeaveRoom) deactivate(relay, rootTopic, selfTopic, strategyContext);
        });
      };
      ctx.requeueAnnounce = () => {
        announceTimeouts.forEach(resetTimer);
        announceTimeouts.length = 0;
        passiveActivationTimeout = resetTimer(passiveActivationTimeout);
        if (!pool.isActive) pool.warmup();
        if (roomRegistration?.roomToken) advertiseRoomPresenceToAll(appId, roomRegistration.roomToken, true);
        passiveActivationTimeout = setTimeout(checkDeactivate, passiveActivationGraceMs);
        initPromises.forEach(async (relayP, i) => {
          const relay = await relayP;
          if (relay && !didLeaveRoom) {
            announceAttemptCounts[i] = 0;
            queueAnnounce(relay, i);
          }
        });
      };
      unsubFns.forEach(async (didSub, i) => {
        await didSub;
        if (didLeaveRoom) return;
        const relay = await initPromises[i];
        if (relay && !didLeaveRoom && (!isPassive || ctx.isActive)) queueAnnounce(relay, i);
      });
    });
    let onPeerConnect = noOp;
    const { compose } = createPasswordHandshake(config.password ?? "", appId, roomId);
    const composedPeerHandshake = compose(onPeerHandshake);
    const roomOptions = {
      ...composedPeerHandshake ? { onPeerHandshake: composedPeerHandshake } : {},
      ...handshakeTimeoutMs === void 0 ? {} : { handshakeTimeoutMs },
      isPassive,
      onHandshakeError: (peerId, error) => onJoinError?.({
        error: error.replace(/^handshake failed: /, ""),
        appId,
        peerId,
        roomId
      })
    };
    occupiedRooms[appId] ??= {};
    const appRoomRegistrations = getRoomRegistrations(appId);
    const joinedRoom = room_default((f) => onPeerConnect = f, (id) => {
      if (didLeaveRoom) return;
      const state = ctx.peerStates[id];
      if (state?.connectedPeer) {
        state.connectedPeer = null;
        updateStatus(state);
        checkDeactivate();
      }
    }, () => {
      didLeaveRoom = true;
      onPeerConnect = noOp;
      const registration = roomRegistrations[appId]?.[roomId];
      if (registration?.roomToken) {
        advertiseRoomPresenceToAll(appId, registration.roomToken, false);
        delete roomIdsByToken[appId]?.[registration.roomToken];
        if (roomIdsByToken[appId] && !keys(roomIdsByToken[appId]).length) delete roomIdsByToken[appId];
      }
      if (roomRegistrations[appId]) {
        delete roomRegistrations[appId][roomId];
        if (!keys(roomRegistrations[appId]).length) delete roomRegistrations[appId];
      }
      entries(ctx.peerStates).forEach(([peerId, state]) => {
        state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer);
        if (state.connectedPeer && !state.connectedPeer.isDead) {
          const shared = sharedPeerMap[peerId];
          if (!shared || shared.peer !== state.connectedPeer) state.connectedPeer.destroy();
        }
        if (state.answeringPeer && !state.answeringPeer.isDead) state.answeringPeer.destroy();
        resetOfferState(state, pool);
        state.connectedPeer = null;
        state.answeringPeer = null;
        updateStatus(state);
      });
      if (occupiedRooms[appId]) {
        delete occupiedRooms[appId][roomId];
        if (keys(occupiedRooms[appId]).length === 0) delete occupiedRooms[appId];
      }
      announceTimeouts.forEach(resetTimer);
      passiveActivationTimeout = resetTimer(passiveActivationTimeout);
      unsubFns.forEach(async (f) => {
        (await f)();
      });
      if (hasActiveRooms()) return;
      didInit = false;
      pool.destroy();
      offerPool = null;
      cleanupWatchOnline();
      cleanupRoomPresenceHandler(appId);
    }, roomOptions);
    roomRegistration = {
      roomToken: null,
      roomTokenPromise: roomNamespacePromise,
      attachSharedPeerToRoom,
      shouldAdvertise: () => !isPassive || ctx.isActive
    };
    appRoomRegistrations[roomId] = roomRegistration;
    roomNamespacePromise.then((roomToken) => {
      const registration = roomRegistration;
      if (!registration || didLeaveRoom || roomRegistrations[appId]?.[roomId] !== registration) return;
      registration.roomToken = roomToken;
      getRoomIdsByToken(appId)[roomToken] = roomId;
      values(sharedPeerMap).forEach((shared) => {
        if (shared.remoteRoomTokens.has(roomToken)) attachSharedPeerToRoom(shared.peerId, shared);
      });
      if (!isPassive || ctx.isActive) advertiseRoomPresenceToAll(appId, roomToken, true);
    });
    return occupiedRooms[appId][roomId] = joinedRoom;
  };
};

// node_modules/@trystero-p2p/torrent/dist/index.mjs
var relayManager = createRelayManager((client) => client.socket);
var topicToInfoHash = {};
var infoHashToTopic = {};
var announceIntervals = relayManager.scoped();
var announceFns = relayManager.scoped();
var subscriptionTokens = relayManager.scoped();
var trackerAnnounceMs = {};
var handledSignals = {};
var msgHandlers = relayManager.scoped();
var topicStates = relayManager.scoped();
var roomOutstandingOffers = {};
var roomOfferGenerationPromises = {};
var roomSubscriberCounts = {};
var trackerAction = "announce";
var hashLimit = 20;
var offerPoolSize = 3;
var defaultAnnounceMs = 1e4;
var dormantAnnounceMs = 12e4;
var maxAnnounceMs = 2e4;
var offerRetentionMs = 12e4;
var signalDedupeWindowMs = 4e3;
var defaultRedundancy = 3;
var getInfoHash = async (topic) => {
  if (topicToInfoHash[topic]) return topicToInfoHash[topic];
  const hash = (await sha1(topic)).slice(0, hashLimit);
  topicToInfoHash[topic] = hash;
  infoHashToTopic[hash] = topic;
  return hash;
};
var send = async (client, topic, payload) => client.send(toJson({
  action: trackerAction,
  info_hash: await getInfoHash(topic),
  peer_id: selfId,
  ...payload
}));
var warn = (url, msg, didFail = false) => console.warn(`${libName}: torrent tracker ${didFail ? "failure" : "warning"} from ${url} - ${msg}`);
var getRoomOutstandingOffers = (rootTopic) => roomOutstandingOffers[rootTopic] ??= {};
var deleteRoomOfferBookkeeping = (rootTopic) => {
  delete roomOutstandingOffers[rootTopic];
  delete roomOfferGenerationPromises[rootTopic];
};
var claimOutstandingOffer = (rootTopic, offerId) => {
  const outstandingOffers = roomOutstandingOffers[rootTopic];
  const offer = outstandingOffers?.[offerId];
  if (!offer) return;
  delete outstandingOffers[offerId];
  offer.claim?.();
  if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) deleteRoomOfferBookkeeping(rootTopic);
  return offer;
};
var reclaimOutstandingOffer = (rootTopic, offerId) => {
  const outstandingOffers = roomOutstandingOffers[rootTopic];
  const offer = outstandingOffers?.[offerId];
  if (!offer) return;
  delete outstandingOffers[offerId];
  offer.reclaim?.();
  if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) deleteRoomOfferBookkeeping(rootTopic);
};
var reclaimAllOutstandingOffers = (rootTopic) => {
  keys(getRoomOutstandingOffers(rootTopic)).forEach((offerId) => reclaimOutstandingOffer(rootTopic, offerId));
  deleteRoomOfferBookkeeping(rootTopic);
};
var pruneOutstandingOffers = (rootTopic) => {
  const now = Date.now();
  entries(getRoomOutstandingOffers(rootTopic)).forEach(([offerId, offer]) => {
    if (now - offer.createdAt > offerRetentionMs) reclaimOutstandingOffer(rootTopic, offerId);
  });
};
var ensureOutstandingOffers = async (rootTopic, getOffers) => {
  while (roomOfferGenerationPromises[rootTopic]) await roomOfferGenerationPromises[rootTopic];
  const nextPromise = (async () => {
    pruneOutstandingOffers(rootTopic);
    const outstandingOffers = getRoomOutstandingOffers(rootTopic);
    const outstandingCount = keys(outstandingOffers).length;
    const missingOffers = Math.max(0, offerPoolSize - outstandingCount);
    if (missingOffers > 0) (await getOffers(missingOffers)).forEach((peerAndOffer) => {
      outstandingOffers[genId(hashLimit)] = {
        ...peerAndOffer,
        createdAt: Date.now()
      };
    });
  })().finally(() => {
    if (roomOfferGenerationPromises[rootTopic] === nextPromise) delete roomOfferGenerationPromises[rootTopic];
  });
  roomOfferGenerationPromises[rootTopic] = nextPromise;
  await nextPromise;
  return getRoomOutstandingOffers(rootTopic);
};
var joinRoomStrategy = strategy_default({
  init: (config) => getRelays(config, defaultRelayUrls, defaultRedundancy).map((rawUrl) => {
    const client = relayManager.register(rawUrl, () => makeSocket(rawUrl, (rawData) => {
      const data = fromJson(rawData);
      const errMsg = data["failure reason"];
      const warnMsg = data["warning message"];
      const { interval } = data;
      const topic = data.info_hash ? infoHashToTopic[data.info_hash] : void 0;
      if (errMsg) {
        warn(client.url, errMsg, true);
        return;
      }
      if (warnMsg) warn(client.url, warnMsg);
      if (interval && interval * 1e3 > (trackerAnnounceMs[client.url] ?? defaultAnnounceMs) && topic && announceFns.forKey(rawUrl)[topic]) {
        const nextInterval = Math.min(interval * 1e3, maxAnnounceMs);
        const relayIntervals = announceIntervals.forKey(rawUrl);
        const relayFns = announceFns.forKey(rawUrl);
        if (relayIntervals[topic]) clearInterval(relayIntervals[topic]);
        trackerAnnounceMs[client.url] = nextInterval;
        const relayFn = relayFns[topic];
        if (relayFn) relayIntervals[topic] = setInterval(() => {
          relayFn();
        }, nextInterval);
      }
      if ((data.offer || data.answer) && topic && data.offer_id) {
        if (data.peer_id === selfId) return;
        const signalKey = `${topic}:${data.offer ? "offer" : "answer"}:${data.offer_id}:${data.peer_id ?? ""}`;
        const nowMs = Date.now();
        const lastHandledMs = handledSignals[signalKey];
        if (typeof lastHandledMs === "number" && nowMs - lastHandledMs < signalDedupeWindowMs) return;
        handledSignals[signalKey] = nowMs;
        entries(handledSignals).forEach(([key, handledAtMs]) => {
          if (nowMs - handledAtMs > signalDedupeWindowMs * 6) delete handledSignals[key];
        });
        msgHandlers.forKey(rawUrl)[topic]?.(data);
      }
    }));
    return client.ready;
  }),
  subscribe: (client, rootTopic, _, onMessage, getOffers, context) => {
    const handlers = msgHandlers.forRelay(client);
    const relayFns = announceFns.forRelay(client);
    const relayIntervals = announceIntervals.forRelay(client);
    const activeTokens = subscriptionTokens.forRelay(client);
    const states = topicStates.forRelay(client);
    const subscriptionToken = Symbol(rootTopic);
    activeTokens[rootTopic] = subscriptionToken;
    roomSubscriberCounts[rootTopic] = (roomSubscriberCounts[rootTopic] ?? 0) + 1;
    const topicHandler = (data) => {
      if (data.offer && data.peer_id && data.offer_id) onMessage(rootTopic, {
        offer: data.offer.sdp,
        peerId: data.peer_id,
        hasOutgoingOffer: keys(getRoomOutstandingOffers(rootTopic)).length > 0
      }, (_2, signal) => void send(client, rootTopic, {
        answer: {
          type: "answer",
          sdp: fromJson(signal).answer
        },
        offer_id: data.offer_id,
        to_peer_id: data.peer_id
      }));
      else if (data.answer && data.offer_id && data.peer_id) {
        const offer = claimOutstandingOffer(rootTopic, data.offer_id);
        if (offer) onMessage(rootTopic, {
          answer: data.answer.sdp,
          peerId: data.peer_id,
          peer: offer.peer
        }, () => {
        });
      }
    };
    handlers[rootTopic] = topicHandler;
    const topicState = {
      announce: async () => {
        if (activeTokens[rootTopic] !== subscriptionToken) return;
        if (!topicState.isActive) {
          send(client, rootTopic, {
            left: 0,
            numwant: offerPoolSize,
            offers: []
          });
          return;
        }
        send(client, rootTopic, {
          numwant: offerPoolSize,
          offers: entries(await ensureOutstandingOffers(rootTopic, getOffers)).map(([id, { offer }]) => ({
            offer_id: id,
            offer: {
              type: "offer",
              sdp: offer
            }
          }))
        });
      },
      isActive: !context?.isPassive
    };
    trackerAnnounceMs[client.url] = defaultAnnounceMs;
    const { announce } = topicState;
    relayFns[rootTopic] = announce;
    states[rootTopic] = topicState;
    const initialInterval = topicState.isActive ? trackerAnnounceMs[client.url] : dormantAnnounceMs;
    relayIntervals[rootTopic] = setInterval(announce, initialInterval);
    announce();
    return () => {
      roomSubscriberCounts[rootTopic] = Math.max(0, (roomSubscriberCounts[rootTopic] ?? 1) - 1);
      if (!roomSubscriberCounts[rootTopic]) delete roomSubscriberCounts[rootTopic];
      if (activeTokens[rootTopic] !== subscriptionToken) {
        if (!roomSubscriberCounts[rootTopic]) {
          reclaimAllOutstandingOffers(rootTopic);
          delete states[rootTopic];
        }
        return;
      }
      const interval = relayIntervals[rootTopic];
      if (interval) {
        clearInterval(interval);
        delete relayIntervals[rootTopic];
      }
      if (handlers[rootTopic] === topicHandler) delete handlers[rootTopic];
      if (relayFns[rootTopic] === announce) delete relayFns[rootTopic];
      delete activeTokens[rootTopic];
      if (states[rootTopic] === topicState) delete states[rootTopic];
      if (!roomSubscriberCounts[rootTopic]) reclaimAllOutstandingOffers(rootTopic);
    };
  },
  announce: (client, rootTopic) => {
    const state = topicStates.forRelay(client)[rootTopic];
    const relayIntervals = announceIntervals.forRelay(client);
    const fn = announceFns.forRelay(client)[rootTopic];
    if (state) state.isActive = true;
    if (fn && relayIntervals[rootTopic]) {
      clearInterval(relayIntervals[rootTopic]);
      relayIntervals[rootTopic] = setInterval(() => {
        fn();
      }, trackerAnnounceMs[client.url]);
      fn();
    }
    return trackerAnnounceMs[client.url];
  },
  deactivate: (client, rootTopic) => {
    const state = topicStates.forRelay(client)[rootTopic];
    const relayIntervals = announceIntervals.forRelay(client);
    const fn = announceFns.forRelay(client)[rootTopic];
    if (state) state.isActive = false;
    reclaimAllOutstandingOffers(rootTopic);
    if (fn && relayIntervals[rootTopic]) {
      clearInterval(relayIntervals[rootTopic]);
      relayIntervals[rootTopic] = setInterval(() => {
        fn();
      }, dormantAnnounceMs);
      fn();
    }
  }
});
var joinRoom = (config, roomId, callbacks) => joinRoomStrategy({
  ...config,
  trickleIce: config.trickleIce ?? false
}, roomId, callbacks);
var getRelaySockets = relayManager.getSockets;
var defaultRelayUrls = [
  "tracker.webtorrent.dev",
  "tracker.openwebtorrent.com",
  "tracker.btorrent.xyz",
  "tracker.files.fm:7073/announce"
].map((url) => "wss://" + url);
export {
  defaultRelayUrls,
  getRelaySockets,
  joinRoom,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId
};
