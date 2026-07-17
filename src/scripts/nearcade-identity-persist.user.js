// ==UserScript==
// @name         Nearcade Identity Persist
// @namespace    nearcade
// @version      1.1.0
// @description  Persists your display name and chat color across all Nearcade sessions — works on any tunnel, any origin. Install once, identity follows you everywhere.
// @author       Nearcade
// @match        *://*/*
// @icon         https://nearcade.cutefame.net/assets/NearcadeIcon.svg
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const KEY = 'ns_name';

    function isNearcadePage() {
        return !!(document.getElementById('nameInput') ||
                  document.querySelector('.pin-card') ||
                  document.getElementById('pinScreen'));
    }

    function inject() {
        const input = document.getElementById('nameInput');
        const clrInput = document.getElementById('profileClr');
        
        if (input) {
            const saved = GM_getValue(KEY, '');
            if (saved && !input.value) {
                input.value = saved;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }

            let timer;
            input.addEventListener('input', function() {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    const val = input.value.trim();
                    if (val) {
                        GM_setValue(KEY, val);
                        try { localStorage.setItem(KEY, val); } catch {}
                    }
                }, 300);
            });
        }

        if (clrInput) {
            const savedClr = GM_getValue('ns_chat_color', '');
            if (savedClr && clrInput.value !== savedClr) {
                clrInput.value = savedClr;
                clrInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            clrInput.addEventListener('change', function() {
                const val = clrInput.value;
                if (val) {
                    GM_setValue('ns_chat_color', val);
                    try { localStorage.setItem('ns_chat_color', val); } catch {}
                }
            });
        }
    }

    if (isNearcadePage()) {
        if (document.getElementById('nameInput')) {
            inject();
        } else {
            const observer = new MutationObserver(() => {
                if (document.getElementById('nameInput')) {
                    observer.disconnect();
                    inject();
                }
            });
            observer.observe(document.body || document.documentElement, {
                childList: true, subtree: true
            });
        }
    }
})();
