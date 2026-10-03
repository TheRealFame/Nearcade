import * as ORP from './orp-client.bundle.js';

class P2PSignaler {
    constructor() {
        this.room = null;
        this.sendAction = null;
        this.peers = new Set();
        this.onMessageCallback = null;
        this.isActive = false;
        
        this.hostSession = null;
        this.clientSession = null;
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
        
        this.hostSession.handleSignalingSocket(this.room);

        this.sendAction = (msg, peerId) => {
            if (peerId) msg.target = peerId;
            this.room.send(msg);
        };



        this.hostSession.on('viewer-joined', (viewer) => {
            console.log('[P2P] ORP Handshake complete for viewer:', viewer.senderId, viewer.displayName);
            this.peers.add(viewer.senderId);
            if (this.onMessageCallback) {
                this.onMessageCallback({ type: 'join', name: viewer.displayName, viewerId: viewer.senderId }, viewer.senderId);
            }
        });
        
        this.hostSession.on('viewer-left', (viewerId) => {
            this.peers.delete(viewerId);
            if (this.onMessageCallback) {
                this.onMessageCallback({ type: 'viewer-left', viewer_id: viewerId }, viewerId);
            }
        });

        this.room.onmessage = (ev) => {
            let data;
            try { data = JSON.parse(ev.data); } catch { return; }
            
            if (typeof data === 'object') {
                if (data.type && (data.type.startsWith('ice') || data.type === 'offer' || data.type === 'answer' || data.type === 'orp-ping' || data.type === 'join')) {
                    return;
                }
            }
            
            const viewerId = data.senderId || data.viewer_id || data.viewerId || data.from;
            if (this.onMessageCallback) {
                if (typeof data === 'object') {
                    if (viewerId) data.viewer_id = viewerId;
                }
                this.onMessageCallback(data, viewerId);
            }
        };
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
        
        this.sendAction = (msg) => {
            this.room.send(msg);
        };

        this.room.onopen = () => {
            console.log('[P2P] Host discovered (ORP channel open)');
            this.peers.add('host');
            if (onReady) {
                onReady();
                onReady = null; 
            }
        };

        this.room.onmessage = (ev) => {
            let data;
            try { data = JSON.parse(ev.data); } catch { return; }

            if (typeof data === 'object') {
                if (data.type && (data.type.startsWith('ice') || data.type === 'offer' || data.type === 'answer' || data.type === 'request-offer' || data.type === 'orp-ping' || data.type === 'join')) {
                    return;
                }
            }

            if (this.onMessageCallback) {
                this.onMessageCallback(data);
            }
        };

        this.clientSession.connect(this.room).catch(err => {
            console.error('[P2P] ORPClient connection failed:', err);
        });
    }

    isPeer(viewerId) {
        return this.peers.has(viewerId);
    }

    sendToPeer(peerId, msg) {
        if (this.sendAction) {
            this.sendAction(msg, peerId);
        }
    }

    sendToAllPeers(msg) {
        if (this.sendAction) {
            for (const peerId of this.peers) {
                this.sendAction(msg, peerId);
            }
        }
    }
    
    sendToHost(msg) {
        if (this.sendAction) {
            this.sendAction(msg);
        }
    }
}

window.P2PManager = new P2PSignaler();
