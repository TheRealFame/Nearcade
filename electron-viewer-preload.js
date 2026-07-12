'use strict';
/**
 * electron-viewer-preload.js
 * Injected into every remote session viewer window.
 * Responsibilities:
 *   1. Auto-activate gamepad polling without user gesture
 *   2. Inject a floating "back out" overlay button
 *   3. Detect Start+Select controller combo to exit session
 *   4. Communicate back-out to main process via IPC
 */
const { contextBridge, ipcRenderer } = require('electron');

// Minimal API surface exposed to the remote session page
contextBridge.exposeInMainWorld('electronAPI', {
  backToDashboard: () => ipcRenderer.send('back-to-dashboard'),
  // Expose the same getWindowSources noop so host.js doesn't crash if loaded here
  getWindowSources: () => Promise.resolve([]),
});

// ── Run after DOM is ready ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  injectBackOutOverlay();
  startGamepadWatcher();
  injectAutoplayUnlock();
});

// ── Floating back-out button ──────────────────────────────────────────────────
function injectBackOutOverlay() {
  const style = document.createElement('style');
  style.textContent = `
    #ns-backout-btn {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 999999;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: 1.5px solid rgba(192,132,252,0.5);
      background: rgba(8,8,8,0.72);
      backdrop-filter: blur(8px);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s, transform 0.15s, background 0.15s, border-color 0.15s;
      font-family: monospace;
    }
    #ns-backout-btn svg { width: 16px; height: 16px; }
    body:hover #ns-backout-btn,
    #ns-backout-btn:hover { opacity: 1; pointer-events: auto; }
    #ns-backout-btn:hover {
      background: rgba(192,132,252,0.85);
      border-color: #c084fc;
      transform: scale(1.1);
    }
    #ns-backout-btn:active { transform: scale(0.96); }

    /* Start+Select hint toast */
    #ns-combo-hint {
      position: fixed;
      top: 60px;
      left: 12px;
      z-index: 999998;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 9px;
      color: rgba(192,132,252,0.6);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s;
      white-space: nowrap;
      letter-spacing: 0.05em;
    }
    body:hover #ns-combo-hint { opacity: 1; }

    /* Escape toast shown when combo is held */
    #ns-escape-toast {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.9);
      z-index: 9999999;
      background: rgba(8,8,8,0.92);
      border: 1px solid #c084fc;
      border-radius: 12px;
      padding: 18px 32px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      color: #c084fc;
      letter-spacing: 0.1em;
      text-align: center;
      opacity: 0;
      pointer-events: none;
      backdrop-filter: blur(12px);
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 0 40px rgba(192,132,252,0.2);
    }
    #ns-escape-toast.visible {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    #ns-escape-progress {
      margin-top: 10px;
      height: 2px;
      background: rgba(192,132,252,0.2);
      border-radius: 2px;
      overflow: hidden;
    }
    #ns-escape-fill {
      height: 100%;
      width: 0%;
      background: #c084fc;
      transition: width 0.05s linear;
      box-shadow: 0 0 6px #c084fc;
    }
  `;
  document.head.appendChild(style);

  // Back button
  const btn = document.createElement('button');
  btn.id = 'ns-backout-btn';
  btn.title = 'Back to Nearcade Dashboard';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 12H5M5 12l7-7M5 12l7 7"/>
    </svg>`;
  btn.addEventListener('click', () => ipcRenderer.send('back-to-dashboard'));
  document.body.appendChild(btn);

  // Hint label
  const hint = document.createElement('div');
  hint.id = 'ns-combo-hint';
  hint.textContent = 'START + SELECT to exit';
  document.body.appendChild(hint);

  // Escape toast
  const toast = document.createElement('div');
  toast.id = 'ns-escape-toast';
  toast.innerHTML = `
    RETURNING TO ARCADE
    <div id="ns-escape-progress"><div id="ns-escape-fill"></div></div>
  `;
  document.body.appendChild(toast);
}

// ── Gamepad watcher: Start + Select held for 1.5s = exit ─────────────────────
function startGamepadWatcher() {
  let comboHoldStart = null;
  let toastVisible   = false;
  const HOLD_MS      = 1500; // how long to hold Start+Select

  function pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let comboActive = false;

    for (const gp of pads) {
      if (!gp) continue;
      // Standard mapping: button 8 = Select/Back/Share, button 9 = Start/Menu/Options
      const start  = gp.buttons[9]?.pressed;
      const select = gp.buttons[8]?.pressed;
      if (start && select) { comboActive = true; break; }
    }

    const toast = document.getElementById('ns-escape-toast');
    const fill  = document.getElementById('ns-escape-fill');

    if (comboActive) {
      if (!comboHoldStart) comboHoldStart = Date.now();
      const elapsed  = Date.now() - comboHoldStart;
      const progress = Math.min(100, (elapsed / HOLD_MS) * 100);

      if (!toastVisible && elapsed > 100) {
        toastVisible = true;
        if (toast) toast.classList.add('visible');
      }
      if (fill) fill.style.width = progress + '%';

      if (elapsed >= HOLD_MS) {
        // Exit!
        ipcRenderer.send('back-to-dashboard');
        return; // stop polling
      }
    } else {
      comboHoldStart = null;
      if (toastVisible) {
        toastVisible = false;
        if (toast) toast.classList.remove('visible');
        if (fill) fill.style.width = '0%';
      }
    }

    requestAnimationFrame(pollGamepads);
  }

  // Start polling once any gamepad is connected or immediately
  window.addEventListener('gamepadconnected', () => {
    requestAnimationFrame(pollGamepads);
  });

  // Also start immediately — Electron doesn't need a gesture
  requestAnimationFrame(pollGamepads);
}

// ── Autoplay unlock — dispatch a fake trusted interaction early ───────────────
function injectAutoplayUnlock() {
  // Synthesise a pointer-down event so the browser's internal user-gesture
  // tracker is satisfied and audio plays immediately on stream connect
  try {
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  } catch {}
}
