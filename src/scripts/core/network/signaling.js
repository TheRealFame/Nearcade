class Signaling {
    constructor() {
        this.ws = null;
        this.url = null;
        this._handlers = {};
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._maxRetries = 30;
        this._stopped = false;
        this._pingTimer = null;
        this._lastPong = 0;
        this._pending = [];
        this._readyState = WebSocket.CLOSED;
        this._log('Signaling module initialized');
    }

    get readyState() { return this._readyState; }

    _log(msg, level = 'info') {
        const ts = new Date().toISOString().slice(11, 23);
        const prefix = `[Signaling][${ts}]`;
        switch (level) {
            case 'warn': console.warn(`${prefix} ${msg}`); break;
            case 'err':  console.error(`${prefix} ${msg}`); break;
            case 'ok':   console.log(`%c${prefix} ${msg}`, 'color:#34d399'); break;
            default:     console.log(`${prefix} ${msg}`);
        }
    }

    on(type, fn) {
        if (!this._handlers[type]) this._handlers[type] = [];
        this._handlers[type].push(fn);
        return this;
    }

    off(type, fn) {
        if (!this._handlers[type]) return;
        this._handlers[type] = this._handlers[type].filter(h => h !== fn);
    }

    _emit(type, data) {
        const handlers = this._handlers[type] || [];
        handlers.forEach(fn => {
            try { fn(data); } catch (e) {
                this._log(`Handler error for "${type}": ${e.message}`, 'err');
            }
        });
        const wild = this._handlers['*'] || [];
        wild.forEach(fn => {
            try { fn(type, data); } catch (e) {
                this._log(`Wildcard handler error: ${e.message}`, 'err');
            }
        });
    }

    connect(url) {
        if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
            this._log('Already connected or connecting, skipping', 'warn');
            return;
        }
        this._stopped = false;
        this.url = url;
        this._readyState = WebSocket.CONNECTING;
        this._log(`Connecting to ${url}`);
        this._emit('connecting');

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            this._log(`WebSocket constructor failed: ${e.message}`, 'err');
            this._emit('error', { code: 'CONSTRUCTOR', message: e.message });
            this._readyState = WebSocket.CLOSED;
            this._scheduleReconnect();
            return;
        }

        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this._reconnectAttempts = 0;
            this._readyState = WebSocket.OPEN;
            this._log(`Connected to ${this.url}`, 'ok');
            this._startPing();
            // Flush pending messages
            const pending = this._pending.splice(0);
            pending.forEach(msg => this.send(msg));
            this._emit('connected');
        };

        this.ws.onclose = (e) => {
            this._stopPing();
            this._readyState = WebSocket.CLOSED;
            const reason = e.reason || `code=${e.code}`;
            this._log(`Disconnected (${reason})`, 'warn');
            this._emit('disconnected', { code: e.code, reason: e.reason });
            // NOTE: Auto-reconnect is disabled here. The consumer (viewer.js/host.js)
            // handles reconnection via its own ws.onclose → setTimeout(connect, 2000).
            // Parallel reconnect attempts cause handshake stutter and duplicate PCs.
        };

        this.ws.onerror = (e) => {
            this._log('WebSocket error', 'err');
            this._emit('error', { code: 'WS_ERROR' });
        };

        this.ws.onmessage = (e) => {
            // Binary messages (WebCodecs video, PCM audio)
            if (e.data instanceof ArrayBuffer) {
                this._emit('binary', e.data);
                return;
            }
            if (e.data instanceof Blob) {
                this._emit('binary', e.data);
                return;
            }
            // String messages
            let msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                this._log(`Failed to parse message: ${err.message}`, 'warn');
                return;
            }
            // Auto-handle pong for the keepalive timer
            if (msg.type === 'pong') { this._lastPong = Date.now(); return; }
            this._emit(msg.type, msg);
        };
    }

    send(data) {
        if (!this.ws || this.ws.readyState !== 1) {
            this._pending.push(data);
            return false;
        }
        try {
            this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            return true;
        } catch (e) {
            this._log(`Send failed: ${e.message}`, 'err');
            this._pending.push(data);
            return false;
        }
    }

    sendBinary(data) {
        if (!this.ws || this.ws.readyState !== 1) {
            this._log('Cannot send binary — WS not open', 'warn');
            return false;
        }
        try {
            this.ws.send(data);
            return true;
        } catch (e) {
            this._log(`Binary send failed: ${e.message}`, 'err');
            return false;
        }
    }

    disconnect(code = 1000, reason = '') {
        this._stopped = true;
        this._stopPing();
        this._clearReconnect();
        this._readyState = WebSocket.CLOSED;
        if (this.ws) {
            try {
                this.ws.close(code, reason);
            } catch (e) {
                this._log(`Close error: ${e.message}`, 'warn');
            }
            this.ws = null;
        }
        this._pending = [];
        this._log('Disconnected (intentional)', 'ok');
        this._emit('disconnected', { code, reason, intentional: true });
    }

    _scheduleReconnect() {
        if (this._stopped) return;
        if (this._reconnectAttempts >= this._maxRetries) {
            this._log(`Max reconnect attempts (${this._maxRetries}) reached, giving up`, 'err');
            this._emit('error', { code: 'MAX_RETRIES' });
            return;
        }
        this._reconnectAttempts++;
        // Exponential backoff with jitter: base 1s, max 30s
        const base = Math.min(1000 * Math.pow(1.5, this._reconnectAttempts - 1), 30000);
        const jitter = Math.random() * 1000;
        const delay = Math.round(base + jitter);
        this._log(`Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxRetries})`, 'warn');
        this._emit('reconnecting', { attempt: this._reconnectAttempts, delay });
        this._clearReconnect();
        this._reconnectTimer = setTimeout(() => {
            if (!this._stopped) this.connect(this.url);
        }, delay);
    }

    _clearReconnect() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _startPing() {
        this._stopPing();
        this._lastPong = Date.now();
        this._pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== 1) return;
            // Send a periodic ping. If the server doesn't pong back, we
            // rely on the browser's built-in TCP keepalive instead of
            // force-closing — some servers don't echo pong frames.
            try {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            } catch (_) {}
        }, 30000);
    }

    _stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    handlePong() {
        this._lastPong = Date.now();
    }
}

window.Signaling = Signaling;
