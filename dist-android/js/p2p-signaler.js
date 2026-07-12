import { joinRoom } from './trystero-bundle.js';

class P2PSignaler {
    constructor() {
        this.room = null;
        this.sendAction = null;
        this.peers = new Set();
        this.onMessageCallback = null;
        this.isActive = false;
    }

    initHost(roomCode, onMessageCallback) {
        this.room = joinRoom({ appId: 'nearsec-arcade' }, roomCode);
        this.onMessageCallback = onMessageCallback;
        this.isActive = true;
        
        const action = this.room.makeAction('signal');
        this.sendAction = (msg, peerId) => action.send(msg, { target: peerId });

        this.room.onPeerJoin = peerId => {
            console.log('[P2P] Viewer joined:', peerId);
            this.peers.add(peerId);
        };
        
        this.room.onPeerLeave = peerId => {
            console.log('[P2P] Viewer left:', peerId);
            this.peers.delete(peerId);
            if (this.onMessageCallback) {
                this.onMessageCallback({ type: 'viewer-left', viewer_id: peerId });
            }
        };

        action.onMessage = (data, meta) => {
            if (this.onMessageCallback) {
                data.viewer_id = meta.peerId; // inject peerId as viewer_id
                this.onMessageCallback(data);
            }
        };
    }

    initViewer(roomCode, onMessageCallback, onReady) {
        this.room = joinRoom({ appId: 'nearsec-arcade' }, roomCode);
        this.onMessageCallback = onMessageCallback;
        this.isActive = true;
        
        const action = this.room.makeAction('signal');
        this.sendAction = (msg, peerId) => action.send(msg, { target: peerId });

        this.room.onPeerJoin = peerId => {
            console.log('[P2P] Host discovered:', peerId);
            this.peers.add(peerId);
            if (onReady) {
                onReady();
                onReady = null; // Only fire once
            }
        };

        action.onMessage = (data) => {
            if (this.onMessageCallback) {
                this.onMessageCallback(data);
            }
        };
    }

    isPeer(viewerId) {
        return this.peers.has(viewerId);
    }

    sendToPeer(peerId, msg) {
        if (this.sendAction && this.isPeer(peerId)) {
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
            // Trystero sends to all peers in the room when 2nd arg is omitted.
            // Since it's a 1-on-1 topology usually, or Viewer->Host, this works.
            this.sendAction(msg);
        }
    }
}

window.P2PManager = new P2PSignaler();
