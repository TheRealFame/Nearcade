// ==UserScript==
// @name         Nearcade Identity Persist
// @namespace    https://github.com/TheRealFame/Nearcade
// @version      3.0.6
// @description  Persists ALL your viewer settings (name, colors, gamepad mappings, volumes, stream quality) across all Nearcade sessions and tunnels. Install once, your setup follows you everywhere.
// @updateURL    https://github.com/TheRealFame/Nearcade/raw/refs/heads/main/src/scripts/nearcade-identity-persist.user.js
// @downloadURL  https://github.com/TheRealFame/Nearcade/raw/refs/heads/main/src/scripts/nearcade-identity-persist.user.js
// @author       Nearcade
// @match        *://*/*
// @icon         https://nearcade.cutefame.net/assets/NearcadeIcon.svg
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        window.close
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // We only care about Nearcade specific keys
    function isNearcadeKey(key) {
        return key && (key.startsWith('ns_') || key.startsWith('nearsec_map_'));
    }

    // Inject a flag so Nearcade web UI knows the extension is installed
    if (location.hostname.includes('nearcade') || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        document.documentElement.dataset.nsPersist = 'true';
    }

    // 1. Memory cache to detect which side actually changed
    const memoryCache = {};

    // 2. On page load, immediately inject all saved settings from Tampermonkey into the site's localStorage
    try {
        const savedKeys = GM_listValues();
        for (const key of savedKeys) {
            if (isNearcadeKey(key)) {
                const val = GM_getValue(key);
                localStorage.setItem(key, val);
                memoryCache[key] = val;
            }
        }
        // Write our own version so the server can detect mismatches on join
        localStorage.setItem('ns_script_version', GM_info.script.version);
    } catch (e) { }

    // 3. Bidirectional sync loop
    setInterval(() => {
        try {
            // A. Check if Tampermonkey storage was updated by ANOTHER tab/origin
            const savedKeys = GM_listValues();
            for (const key of savedKeys) {
                if (isNearcadeKey(key)) {
                    const gmVal = GM_getValue(key);
                    if (memoryCache[key] !== gmVal) {
                        localStorage.setItem(key, gmVal);
                        memoryCache[key] = gmVal;
                    }
                }
            }

            // B. Check if THIS tab's localStorage was updated by the user interacting with the UI
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (isNearcadeKey(key)) {
                    const lsVal = localStorage.getItem(key);
                    if (memoryCache[key] !== lsVal) {
                        GM_setValue(key, lsVal);
                        memoryCache[key] = lsVal;
                    }
                }
            }
        } catch (e) { }
    }, 250);

    // If the name input exists, we might still want to trigger its input event so the UI updates
    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            const nameInput = document.getElementById('nameInput');
            if (nameInput && nameInput.value === '') {
                const saved = GM_getValue('ns_name', '');
                if (saved) {
                    nameInput.value = saved;
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }, 500);
    });

    window.addEventListener('ns-close-tab', () => {
        window.close();
    });

    // ── NATIVE EXTENSION UI ──
    // Allows users to configure their global Nearcade settings from ANY website without needing to visit the Arcade.
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand("Configure Nearcade Settings", openSettingsModal);
    }

    function openSettingsModal() {
        if (document.getElementById('ns-tm-settings-modal')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ns-tm-settings-modal {
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0,0,0,0.7); z-index: 2147483647;
                display: flex; justify-content: center; align-items: center;
                font-family: 'Segoe UI', system-ui, sans-serif;
            }
            .ns-tm-box {
                background: #1e1e2e; color: #cdd6f4; width: 400px; max-width: 90%;
                border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                border: 1px solid #313244;
            }
            .ns-tm-box h2 { margin: 0 0 20px 0; font-size: 20px; color: #89b4fa; text-align: center; }
            .ns-tm-group { margin-bottom: 15px; display: flex; flex-direction: column; gap: 5px; }
            .ns-tm-group label { font-size: 13px; font-weight: 600; color: #a6adc8; }
            .ns-tm-group input, .ns-tm-group select {
                background: #11111b; border: 1px solid #45475a; color: #cdd6f4;
                padding: 8px 12px; border-radius: 6px; outline: none; font-size: 14px;
            }
            .ns-tm-group input[type="range"] { padding: 0; background: transparent; border: none; }
            .ns-tm-group input:focus, .ns-tm-group select:focus { border-color: #89b4fa; }
            .ns-tm-row { display: flex; align-items: center; justify-content: space-between; }
            .ns-tm-val { font-size: 12px; color: #a6adc8; background: #313244; padding: 2px 6px; border-radius: 4px; }
            .ns-tm-close {
                background: #89b4fa; color: #11111b; border: none; width: 100%;
                padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer;
                margin-top: 10px; font-size: 14px; transition: background 0.2s;
            }
            .ns-tm-close:hover { background: #b4befe; }
        `;
        document.head.appendChild(style);

        const modal = document.createElement('div');
        modal.id = 'ns-tm-settings-modal';
        
        // Helper to get value falling back to defaults
        const getV = (k, def) => GM_getValue(k, def);

        modal.innerHTML = `
            <div class="ns-tm-box">
                <h2>Nearcade Global Settings</h2>
                
                <div class="ns-tm-group" style="align-items: center;">
                    <img id="ns_avatar_preview" src="/assets/avatars/avatar-${getV('ns_avatar', '1')}.svg" style="width: 64px; height: 64px; border-radius: 50%; background: #11111b; border: 2px solid #89b4fa; margin-bottom: 8px;">
                    <div class="ns-tm-row" style="width: 100%; justify-content: center; gap: 10px;">
                        <button id="ns_avatar_prev" style="background:#313244; color:#cdd6f4; border:none; padding:4px 10px; border-radius:4px; cursor:pointer;">◀</button>
                        <span style="font-size: 12px; color: #a6adc8; width: 60px; text-align: center;">Avatar <span id="ns_avatar_lbl">${getV('ns_avatar', '1')}</span></span>
                        <button id="ns_avatar_next" style="background:#313244; color:#cdd6f4; border:none; padding:4px 10px; border-radius:4px; cursor:pointer;">▶</button>
                    </div>
                    <input type="hidden" id="ns_avatar" value="${getV('ns_avatar', '1')}">
                </div>

                <div class="ns-tm-group">
                    <label>Display Name</label>
                    <input type="text" id="ns_name" value="${getV('ns_name', '')}" placeholder="Player 1">
                </div>
                
                <div class="ns-tm-group">
                    <label>Chat Color</label>
                    <input type="color" id="ns_chat_color" value="${getV('ns_chat_color', '#89b4fa')}">
                </div>

                <div class="ns-tm-group">
                    <div class="ns-tm-row">
                        <label>Global Stick Deadzone</label>
                        <span class="ns-tm-val" id="val_dz">${getV('ns_global_deadzone', '0.05')}</span>
                    </div>
                    <input type="range" id="ns_global_deadzone" min="0" max="0.5" step="0.01" value="${getV('ns_global_deadzone', '0.05')}">
                </div>

                <div class="ns-tm-group">
                    <div class="ns-tm-row">
                        <label>Analog Sensitivity</label>
                        <span class="ns-tm-val" id="val_sens">${getV('ns_global_sens', '1.50')}</span>
                    </div>
                    <input type="range" id="ns_global_sens" min="0.5" max="3.0" step="0.05" value="${getV('ns_global_sens', '1.50')}">
                </div>

                <div class="ns-tm-group">
                    <label>Default Upscale Mode</label>
                    <select id="ns_upscale_mode">
                        <option value="0.0">Standard</option>
                        <option value="1.0">Crisp (Bilinear)</option>
                        <option value="2.0">Pixel Perfect</option>
                        <option value="3.0">Ultra (FSR-Lite)</option>
                    </select>
                </div>

                <div class="ns-tm-group">
                    <div class="ns-tm-row">
                        <label>WebGPU Upscaler <span style="font-size:9px;background:rgba(139,92,246,0.2);color:#a78bfa;border:1px solid rgba(139,92,246,0.35);border-radius:3px;padding:1px 4px;margin-left:4px;">⚗ Exp.</span></label>
                        <input type="checkbox" id="ns_gpu_backend" ${getV('ns_gpu_backend','0')==='1' ? 'checked' : ''} style="width:18px;height:18px;accent-color:#89b4fa;cursor:pointer;">
                    </div>
                    <span style="font-size:11px;color:#6c7086;">GPU shader pipeline. Requires page reload when toggled.</span>
                </div>

                <button class="ns-tm-close" id="ns_tm_close">Save & Close</button>
            </div>
        `;

        document.body.appendChild(modal);

        // Set select value
        document.getElementById('ns_upscale_mode').value = getV('ns_upscale_mode', '0.0');

        // Avatar selector logic
        let currentIcon = parseInt(getV('ns_avatar', '1')) || 1;
        const updateIconUI = () => {
            document.getElementById('ns_avatar').value = currentIcon;
            document.getElementById('ns_avatar_lbl').textContent = currentIcon;
            
            // Set image source. If they are not on the Arcade site, we load it directly from github raw content to ensure it shows!
            const isLocal = location.hostname.includes('nearcade') || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            const baseUri = isLocal ? '' : 'https://raw.githubusercontent.com/TheRealFame/Nearcade/main';
            document.getElementById('ns_avatar_preview').src = baseUri + '/assets/avatars/avatar-' + currentIcon + '.svg';
        };
        updateIconUI(); // Force initialization

        document.getElementById('ns_avatar_prev').addEventListener('click', () => {
            currentIcon = currentIcon > 1 ? currentIcon - 1 : 100;
            updateIconUI();
        });
        document.getElementById('ns_avatar_next').addEventListener('click', () => {
            currentIcon = currentIcon < 100 ? currentIcon + 1 : 1;
            updateIconUI();
        });

        // Update value displays
        document.getElementById('ns_global_deadzone').addEventListener('input', e => {
            document.getElementById('val_dz').textContent = e.target.value;
        });
        document.getElementById('ns_global_sens').addEventListener('input', e => {
            document.getElementById('val_sens').textContent = e.target.value;
        });

        // Close and Save
        document.getElementById('ns_tm_close').addEventListener('click', () => {
            const save = (id) => {
                const val = document.getElementById(id).value;
                GM_setValue(id, val);
                localStorage.setItem(id, val);
                memoryCache[id] = val;
            };
            
            save('ns_avatar');
            save('ns_name');
            save('ns_chat_color');
            save('ns_global_deadzone');
            save('ns_global_sens');
            save('ns_upscale_mode');
            // GPU backend is a checkbox — save as '1' or '0'
            const gpuCb = document.getElementById('ns_gpu_backend');
            if (gpuCb) {
                const val = gpuCb.checked ? '1' : '0';
                GM_setValue('ns_gpu_backend', val);
                localStorage.setItem('ns_gpu_backend', val);
                memoryCache['ns_gpu_backend'] = val;
            }

            document.body.removeChild(modal);
            document.head.removeChild(style);
        });
    }

})();
