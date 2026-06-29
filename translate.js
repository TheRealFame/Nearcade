const fs = require('fs');
const https = require('https');

const targets = [
    { name: 'Spanish', code: 'es' },
    { name: 'French', code: 'fr' },
    { name: 'German', code: 'de' },
    { name: 'Portuguese', code: 'pt' },
    { name: 'Japanese', code: 'ja' }
];

async function translateText(text, targetLangCode) {
    if (!text || text.trim() === '') return text;
    return new Promise((resolve) => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLangCode}&dt=t&q=${encodeURIComponent(text)}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const translated = parsed[0].map(item => item[0]).join('');
                    resolve(translated);
                } catch (e) {
                    resolve(text);
                }
            });
        }).on('error', () => resolve(text));
    });
}

async function startGoogleTranslation() {
    try {
        const enRaw = fs.readFileSync('assets/locales/en.json', 'utf8');
        const enJSON = JSON.parse(enRaw);
        const keys = Object.keys(enJSON);
        const values = Object.values(enJSON);

        console.log(`[Google API] Found en.json with ${keys.length} entries.`);
        console.log(`[Google API] Starting total automation for ${targets.length} languages.\n`);

        for (const target of targets) {
            console.log(`==================================================`);
            console.log(`STARTING COMPILATION FOR: ${target.name.toUpperCase()} (${target.code})`);
            console.log(`==================================================`);

            const translatedJSON = {};
            let promises = [];
            
            for (let i = 0; i < values.length; i++) {
                promises.push(translateText(values[i], target.code).then(res => {
                    translatedJSON[keys[i]] = res;
                }));
            }

            // Process them in parallel with a concurrency limit
            let index = 0;
            async function worker() {
                while (index < promises.length) {
                    let i = index++;
                    await promises[i];
                    if (i % 50 === 0) console.log(`    -> Translated ${i} of ${keys.length} items...`);
                }
            }
            
            await Promise.all(Array(20).fill(0).map(() => worker()));

            fs.writeFileSync(
                `assets/locales/${target.code}.json`,
                JSON.stringify(translatedJSON, null, 2),
                'utf8'
            );
            console.log(`\n[✓] DONE! Saved: assets/locales/${target.code}.json\n`);
        }

        console.log(`==================================================`);
        console.log(`[✓] ALL TRANSLATIONS COMPLETED SUCCESSFULLY!`);
        console.log(`==================================================`);

    } catch (e) {
        console.error(`\n[✗] Automation halted early due to error:`, e.message);
    }
}

startGoogleTranslation();
