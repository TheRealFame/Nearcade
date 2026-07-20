// ==UserScript==
// @name         Nearcade Identity Persist
// @namespace    https://github.com/TheRealFame/Nearcade
// @version      3.0.4
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
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // We only care about Nearcade specific keys
    function isNearcadeKey(key) {
        return key && (key.startsWith('ns_') || key.startsWith('nearsec_map_'));
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

                        // Fire a fake storage event so the page knows it updated
                        window.dispatchEvent(new StorageEvent('storage', { key: key, newValue: gmVal }));
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

})();
