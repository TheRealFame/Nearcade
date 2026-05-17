const fs = require('fs');

// The 5 target languages you wanted to build
const targets = [
    { name: 'Spanish', code: 'es' },
{ name: 'French', code: 'fr' },
{ name: 'German', code: 'de' },
{ name: 'Portuguese', code: 'pt' },
{ name: 'Japanese', code: 'ja' }
];

async function translateChunk(chunkObj, langName, batchIdx, totalBatches) {
    console.log(`    -> Processing batch ${batchIdx} of ${totalBatches}...`);

    const requestBody = {
        model: "qwen2.5-coder:7b",
        prompt: JSON.stringify(chunkObj),
        system: `You are a translation script. Translate ONLY the values (right-side strings) into ${langName}. Leave keys, colons, quotes, and structural brackets exactly identical. Output ONLY raw JSON. No chat, no warnings, no markdown wraps.`,
        stream: false,
        options: {
            temperature: 0,
            num_predict: -1
        }
    };

    const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    const json = await response.json();
    let rawResponse = json.response.trim();

    // Extract the valid JSON block from any potential text wrapping
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error(`Model returned unparseable text on batch ${batchIdx}`);
    }

    return JSON.parse(jsonMatch[0].trim());
}

async function startAFKTranslation() {
    try {
        // 1. Load the master English dictionary template
        const enRaw = fs.readFileSync('assets/locales/en.json', 'utf8');
        const enJSON = JSON.parse(enRaw);
        const entries = Object.entries(enJSON);
        const chunkSize = 25; // Keep it bite-sized for local VRAM stability

        console.log(`[Ollama Suite] Found en.json with ${entries.length} entries.`);
        console.log(`[Ollama Suite] Starting total automation for ${targets.length} languages.\n`);

        // 2. Loop through every language target sequentially
        for (const target of targets) {
            console.log(`==================================================`);
            console.log(`STARTING COMPILATION FOR: ${target.name.toUpperCase()} (${target.code})`);
            console.log(`==================================================`);

            const translatedJSON = {};

            for (let i = 0; i < entries.length; i += chunkSize) {
                const chunk = entries.slice(i, i + chunkSize);
                const chunkObj = Object.fromEntries(chunk);
                const batchIdx = Math.floor(i / chunkSize) + 1;
                const totalBatches = Math.ceil(entries.length / chunkSize);

                // Retry logic in case a local model stream glitches out momentarily
                let success = false;
                let retries = 2;

                while (!success && retries >= 0) {
                    try {
                        const cleanChunk = await translateChunk(chunkObj, target.name, batchIdx, totalBatches);
                        Object.assign(translatedJSON, cleanChunk);
                        success = true;
                    } catch (err) {
                        console.warn(`    ⚠️ Batch ${batchIdx} failed (${err.message}). Retries left: ${retries}`);
                        retries--;
                        if (retries < 0) throw err; // Crash out if it fails repeatedly
                        await new Promise(res => setTimeout(res, 2000)); // Cool down VRAM for 2 seconds
                    }
                }
            }

            // Write the fully completed file to disk before moving to the next language
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

// Run the automation engine
startAFKTranslation();
