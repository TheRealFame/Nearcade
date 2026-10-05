import * as ORP from './orp-client.bundle.js';

class P2PSignaler {
    constructor() {
        this.room = null;
        this.peers = new Set();
        this.onMessageCallback = null;
        this.isActive = false;
        
        this.hostSession = null;
        this.clientSession = null;

        // Dedicated send function for Nearcade's native WebRTC payloads.
        // Uses a SEPARATE Trystero action ('ns-rtc') so ORPHostSession's
        // handleSignalingSocket (which listens on 'orp-signal') never sees
        // these messages and cannot drop them with the v2 gate.
        this._nsRtcSendActions = [];
        this._nsRtcRecvAction = null;

        this._viewerEphemeralMap = new Map(); // logicalViewerId → Trystero ephemeral peerId
    }

    async initHost(roomCode, onMessageCallback) {
        this.onMessageCallback = onMessageCallback;
        this.isActive = true;
        
        let iceServers = ORP.ORP_ICE_SERVERS;
        try {
            const mod = await import('./ice-servers.js');
            iceServers = mod.buildIceServers(window._turnCredentials);
        } catch(e) {}

        this.hostSession = new ORP.ORPHostSession({ roomCode, iceServers });
        this.room = await ORP.ORPNostrSession.create(roomCode);

        // ── ORP SDK handles its own internal WebRTC handshake (data channels, input) ──
        this.hostSession.handleSignalingSocket(this.room);

        // ── Dedicated Nearcade native-WebRTC channel (separate from orp-signal) ──
        // This prevents ORPHostSession from ever seeing ns-rtc messages and rejecting them.
        this._attachNsRtcHost();

        // When ORP SDK's own PC reaches 'connected', the data channels are up.
        // Fire 'join' to trigger host.js's video pipeline for this viewer.
        this.hostSession.on('viewer-joined', (viewer) => {
            console.log('[P2P] ORP Handshake complete for viewer:', viewer.senderId, viewer.displayName);
            this.peers.add(viewer.senderId);
            if (this.onMessageCallback) {
                this.onMessageCallback({
                    type: 'join',
                    name: viewer.displayName,
                    viewerId: viewer.senderId,
                    isDesktopApp: false,
                    supportsWebCodecs: true,
                }, viewer.senderId);
            }
        });
        
        this.hostSession.on('viewer-left', (viewerId) => {
            this.peers.delete(viewerId);
            this._viewerEphemeralMap.delete(viewerId);
            if (this.onMessageCallback) {
                this.onMessageCallback({ type: 'viewer-left', viewer_id: viewerId }, viewerId);
            }
        });

        // Pass-through for non-WebRTC messages (chat, etc.) from room.onmessage
        this.room.onmessage = (ev) => {
            let data;
            try { data = JSON.parse(ev.data); } catch { return; }
            
            // Track ephemeral ID mapping for accurate targeted sends
            if (data.senderId && data._ephemeralId) {
                this._viewerEphemeralMap.set(data.senderId, data._ephemeralId);
            }

            // ns-rtc payloads are handled by the dedicated action, not here
            if (data.ns_rtc) return;
            // ORP SDK protocol messages — let handleSignalingSocket deal with them
            if (data.v === 2 || data.type === 'orp-ping') return;
            // Drop bare WebRTC messages that leaked through (shouldn't happen)
            if (data.type && (data.type.startsWith('ice') || data.type === 'offer' || data.type === 'answer' || data.type === 'join')) return;

            const viewerId = data.senderId || data.viewer_id || data.viewerId || data.from;
            if (this.onMessageCallback) {
                if (viewerId) data.viewer_id = viewerId;
                this.onMessageCallback(data, viewerId);
            }
        };
    }

    _attachNsRtcHost() {
        // Each Trystero room exposes makeAction() for named channels.
        // We use 'ns-rtc' exclusively for Nearcade's WebRTC signaling.
        // ORPHostSession only listens on 'orp-signal', so it never sees these.
        for (const room of (this.room.rooms || [])) {
            try {
                const action = room.makeAction('ns-rtc');
                const send = action.send ? action.send.bind(action) : action[0];
                const recv = action.onMessage ? action.onMessage.bind(action) : action[1];
                this._nsRtcSendActions.push({ send, name: room._name || 'room' });
                recv((data, meta) => {
                    if (!data) return;
                    // Update ephemeral mapping when we hear from a viewer
                    if (data.senderId) this._viewerEphemeralMap.set(data.senderId, meta.peerId);
                    const payload = data.payload || data;
                    const viewerId = data.senderId || payload.viewer_id || payload._viewerId || payload.viewerId;
                    if (this.onMessageCallback) {
                        if (viewerId) payload.viewer_id = viewerId;
                        this.onMessageCallback(payload, viewerId);
                    }
                });
            } catch(e) {
                console.warn('[P2P] ns-rtc action attach failed for a room:', e);
            }
        }

        // Fallback: if rooms are not directly accessible, use room.onmessage ns_rtc flag
        if (this._nsRtcSendActions.length === 0) {
            console.warn('[P2P] ns-rtc separate action unavailable — falling back to ns_rtc flag on shared channel');
            this._useNsRtcFlag = true;
        }
    }

    _sendNsRtc(msg, peerId) {
        const payload = { ns_rtc: true, senderId: 'host', payload: msg };
        if (peerId) payload.target = peerId;

        if (this._nsRtcSendActions.length > 0) {
            // Resolve ephemeral peerId from logical viewerId for targeted sends
            const ephemeral = peerId ? (this._viewerEphemeralMap.get(peerId) || peerId) : undefined;
            for (const { send } of this._nsRtcSendActions) {
                try {
                    if (ephemeral) send(payload, ephemeral);
                    else send(payload);
                } catch(e) {}
            }
        } else {
            // Fallback: broadcast on shared channel with ns_rtc flag
            // room.onmessage on viewer side will pick this up and route it
            this.room.send(payload);
        }
    }

    sendToPeer(peerId, msg) {
        this._sendNsRtc(msg, peerId);
    }

    sendToAllPeers(msg) {
        for (const peerId of this.peers) {
            this._sendNsRtc(msg, peerId);
        }
    }

    async initViewer(roomCode, onMessageCallback, onReady) {
        this.onMessageCallback = onMessageCallback;
        this.isActive = true;
        
        const displayName = document.getElementById('nameInput')?.value || localStorage.getItem('ns_name') || 'Guest';
        const viewerId = localStorage.getItem('ns_my_id') || ('v_' + Math.random().toString(36).substr(2, 9));
        if (!localStorage.getItem('ns_my_id')) localStorage.setItem('ns_my_id', viewerId);
        
        console.log('[P2P] Initializing ORP Viewer Session for room:', roomCode);
        
        let iceServers = ORP.ORP_ICE_SERVERS;
        try {
            const mod = await import('./ice-servers.js');
            iceServers = mod.buildIceServers(window._turnCredentials);
        } catch(e) {}

        this.clientSession = new ORP.ORPClient({ roomCode, displayName, viewerId, iceServers });
        this.room = await ORP.ORPNostrSession.create(roomCode);

        // Dedicated send for Nearcade WebRTC signaling (viewer→host direction)
        this._viewerId = viewerId;

        this.room.onopen = () => {
            console.log('[P2P] Host discovered (ORP channel open)');
            this.peers.add('host');
            if (onReady) {
                onReady();
                onReady = null; 
            }
        };

        // Attach ns-rtc receive on viewer side
        this._attachNsRtcViewer(viewerId);

        // Pass-through for non-WebRTC messages
        this.room.onmessage = (ev) => {
            let data;
            try { data = JSON.parse(ev.data); } catch { return; }

            if (data.ns_rtc) {
                // ns_rtc flag fallback (when separate action unavailable)
                const payload = data.payload || data;
                if (this.onMessageCallback) this.onMessageCallback(payload);
                return;
            }

            // ORP SDK protocol messages — let ORPClient.connect() handle them
            if (data.v === 2 || data.type === 'orp-ping') return;
            // Drop bare WebRTC that shouldn't be here
            if (data.type && (data.type.startsWith('ice') || data.type === 'offer' || data.type === 'answer' || data.type === 'request-offer' || data.type === 'join')) return;

            if (this.onMessageCallback) this.onMessageCallback(data);
        };

        this.clientSession.connect(this.room).catch(err => {
            console.error('[P2P] ORPClient connection failed:', err);
        });
    }

    _attachNsRtcViewer(viewerId) {
        for (const room of (this.room.rooms || [])) {
            try {
                const action = room.makeAction('ns-rtc');
                const send = action.send ? action.send.bind(action) : action[0];
                const recv = action.onMessage ? action.onMessage.bind(action) : action[1];
                this._nsRtcSendActions.push({ send });
                recv((data) => {
                    if (!data) return;
                    const payload = data.payload || data;
                    if (this.onMessageCallback) this.onMessageCallback(payload);
                });
            } catch(e) {
                console.warn('[P2P] ns-rtc viewer attach failed:', e);
            }
        }
        if (this._nsRtcSendActions.length === 0) {
            this._useNsRtcFlag = true;
        }
    }

    sendToHost(msg) {
        const payload = { ns_rtc: true, senderId: this._viewerId || 'viewer', payload: msg };
        if (this._nsRtcSendActions.length > 0) {
            for (const { send } of this._nsRtcSendActions) {
                try { send(payload); } catch(e) {}
            }
        } else {
            this.room.send(payload);
        }
    }

    isPeer(viewerId) {
        return this.peers.has(viewerId);
    }
}

window.P2PManager = new P2PSignaler();
