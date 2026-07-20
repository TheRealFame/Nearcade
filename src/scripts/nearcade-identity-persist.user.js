// ==UserScript==
// @name         Nearcade Identity Persist
// @namespace    nearcade
// @version      1.2.0
// @description  Persists ALL your viewer settings (name, colors, gamepad mappings, volumes, stream quality) across all Nearcade sessions and tunnels. Install once, your setup follows you everywhere.
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

(function() {
    'use strict';

    // We only care about Nearcade specific keys
    function isNearcadeKey(key) {
        return key && (key.startsWith('ns_') || key.startsWith('nearsec_map_'));
    }

    // 1. On page load, immediately inject all saved settings from Tampermonkey into the site's localStorage
    // This happens at document-start before Nearcade's scripts load and read localStorage
    try {
        const savedKeys = GM_listValues();
        for (const key of savedKeys) {
            if (isNearcadeKey(key)) {
                localStorage.setItem(key, GM_getValue(key));
            }
        }
    } catch (e) {}

    // 2. Continually monitor localStorage for any changes made by the viewer (e.g. changing volume, remaps, name)
    // Since we are in a sandbox, a lightweight polling interval is the most reliable way to catch changes
    // without having to build complex window.postMessage bridges.
    setInterval(() => {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (isNearcadeKey(key)) {
                    const val = localStorage.getItem(key);
                    const savedVal = GM_getValue(key);
                    if (val !== savedVal) {
                        GM_setValue(key, val);
                    }
                }
            }
        } catch (e) {}
    }, 1000); // Check every second

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
