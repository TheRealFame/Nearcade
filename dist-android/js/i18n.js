const _urlParams = new URLSearchParams(window.location.search);
const _urlLang = _urlParams.get('lang');
if (_urlLang) {
    localStorage.setItem('ns_lang', _urlLang);
    // Strip it from the URL bar so it looks clean
    window.history.replaceState({}, document.title, window.location.pathname);
}

const I18N = {
    targetLang: localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en',
    translationMap: {},

    async init() {
        const basePath = location.protocol === 'file:' ? '../../assets/locales/' : '/assets/locales/';

        // 1. BULLETPROOF CACHE LOAD
        let cachedLangs = null;
        try {
            const rawCache = localStorage.getItem('ns_lang_list');
            if (rawCache) cachedLangs = JSON.parse(rawCache);

            // If the cache is corrupted or empty, force it to fail so we use the fallback
            if (typeof cachedLangs !== 'object' || Object.keys(cachedLangs).length === 0) {
                cachedLangs = null;
            }
        } catch (e) {
            console.warn("[i18n] Cache was corrupted. Wiping...");
            localStorage.removeItem('ns_lang_list');
        }

        // Render the cache, or render a safe default so the UI never physically breaks
        if (cachedLangs) {
            this.populateDropdown(cachedLangs);
        } else {
            this.populateDropdown({ 'en': 'English', [this.targetLang]: this.targetLang.toUpperCase() });
        }

        // 2. BACKGROUND SYNC
        try {
            const indexRes = await fetch(`${basePath}index.json`);
            if (indexRes.ok) {
                const availableLangs = await indexRes.json();

                // Save the fresh, valid list to memory
                localStorage.setItem('ns_lang_list', JSON.stringify(availableLangs));
                this.populateDropdown(availableLangs);
            } else {
                throw new Error(`HTTP Error: ${indexRes.status}`);
            }
        } catch (e) {
            console.error("[i18n] FAILED to load index.json! Check your locales folder.", e);
        }

        // 3. If the user is English, stop here. (The HTML is already English!)
        if (this.targetLang === 'en') return;

        // 4. Load the actual translation dictionaries
        try {
            const [enRes, targetRes] = await Promise.all([
                fetch(`${basePath}en.json`),
                                                         fetch(`${basePath}${this.targetLang}.json`)
            ]);

            if (!targetRes.ok) throw new Error('Language file not found');

            const enDict = await enRes.json();
            const targetDict = await targetRes.json();

            for (const key in enDict) {
                if (targetDict[key]) {
                    this.translationMap[enDict[key]] = targetDict[key];
                }
            }

            this.autoTranslateDOM();

        } catch (e) {
            console.warn(`[i18n] Could not load ${this.targetLang}.json`, e);
            localStorage.setItem('ns_lang', 'en');
            const select = document.getElementById('langSelect');
            if (select) select.value = 'en';
        }
    },

    // ── The Dynamic UI Builder ──
    populateDropdown(langs) {
        const select = document.getElementById('langSelect');
        if (!select) return; // Ignore if the page doesn't have a dropdown

        select.innerHTML = ''; // Wipe any existing hardcoded HTML

        for (const [code, name] of Object.entries(langs)) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = name;
            select.appendChild(opt);
        }

        // Ensure the dropdown shows the correct currently selected language
        select.value = this.targetLang;
    },

    autoTranslateDOM() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];
        let node;
        while (node = walker.nextNode()) textNodes.push(node);

        textNodes.forEach(node => {
            const originalText = node.nodeValue.trim();
            if (this.translationMap[originalText]) {
                node.nodeValue = node.nodeValue.replace(originalText, this.translationMap[originalText]);
            }
        });

        document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => {
            const originalText = el.getAttribute('placeholder');
            if (this.translationMap[originalText]) {
                el.setAttribute('placeholder', this.translationMap[originalText]);
            }
        });
    },

    t(englishText) {
        return this.translationMap[englishText] || englishText;
    },

    changeLanguage(langCode) {
        localStorage.setItem('ns_lang', langCode);
        location.reload();
    }
};

document.addEventListener('DOMContentLoaded', () => I18N.init());
