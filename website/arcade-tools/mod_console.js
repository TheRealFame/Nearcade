const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── 1. Define Secure Local Storage ────────────────────────────────────────────
const MOD_DIR = path.join(__dirname, 'mod_data');
const CONFIG_FILE = path.join(MOD_DIR, 'config.json');
const LOG_FILE = path.join(MOD_DIR, 'debug.log');

// Ensure the secure directory exists
if (!fs.existsSync(MOD_DIR)) {
    fs.mkdirSync(MOD_DIR, { recursive: true });
}

// ── 2. Setup Persistent Logging ───────────────────────────────────────────────
function writeLog(level, message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}`;

    // Print to terminal (with basic colors) and append to file
    const color = level === 'ERROR' ? '\x1b[31m' : level === 'SUCCESS' ? '\x1b[32m' : '\x1b[36m';
    console.log(`${color}${logLine}\x1b[0m`);
    fs.appendFileSync(LOG_FILE, logLine + '\n', 'utf-8');
}

// ── 3. Load or Initialize Configuration ───────────────────────────────────────
let config = { endpointUrl: "", secretToken: "" };

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } else {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4), 'utf-8');
    }
}
loadConfig();

// ── 4. Interactive Command Line Interface ─────────────────────────────────────
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[35mNearcade Mod> \x1b[0m'
});

async function sendModRequest(method, payload = null) {
    if (!config.endpointUrl || !config.secretToken) {
        writeLog('ERROR', 'Missing endpointUrl or secretToken. Run "setup" first.');
        return null;
    }

    try {
        const options = {
            method: method,
            headers: {
                'Authorization': `Bearer ${config.secretToken}`,
                'Content-Type': 'application/json'
            }
        };
        if (payload) options.body = JSON.stringify(payload);

        const response = await fetch(config.endpointUrl, options);
        const data = await response.json().catch(() => ({}));

        if (!response.ok) throw new Error(data.message || response.statusText);
        return data;

    } catch (error) {
        writeLog('ERROR', `Network request failed: ${error.message}`);
        return null;
    }
}

// ── 5. Command Router ─────────────────────────────────────────────────────────
console.clear();
writeLog('SYSTEM', 'Nearcade Arcade Moderator Console Initialized');
if (!config.endpointUrl) writeLog('INFO', 'Type "setup" to configure your remote endpoint and token.');

rl.prompt();

rl.on('line', async (line) => {
    const args = line.trim().split(' ');
    const command = args[0].toLowerCase();

    switch (command) {
        case 'setup':
            rl.question('Enter your Arcade domain (e.g., yourdomain.com): ', (url) => {
                let formattedUrl = url.trim();

                // 1. Auto-add https:// if they forgot it
                if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
                    formattedUrl = 'https://' + formattedUrl;
                }

                // 2. Strip trailing slashes just in case
                if (formattedUrl.endsWith('/')) {
                    formattedUrl = formattedUrl.slice(0, -1);
                }

                // 3. Auto-append the API route if they didn't type it
                if (!formattedUrl.endsWith('/api/mod')) {
                    formattedUrl += '/api/mod';
                }

                // 4. Auto-generate a secure 64-character hex token
                const crypto = require('crypto');
                const generatedToken = crypto.randomBytes(32).toString('hex');

                config.endpointUrl = formattedUrl;
                config.secretToken = generatedToken;

                fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4), 'utf-8');

                writeLog('SUCCESS', `Endpoint locked to: ${formattedUrl}`);
                console.log('\n=============================================================');
                console.log('\x1b[32mYOUR NEW SECURE MOD TOKEN HAS BEEN GENERATED:\x1b[0m');
                console.log(`\x1b[1;36m${generatedToken}\x1b[0m`);
                console.log('=============================================================');
                console.log('ACTION REQUIRED:');
                console.log('1. Go to your Cloudflare Dashboard -> Workers & Pages');
                console.log('2. Select your Arcade worker -> Settings -> Variables and Secrets');
                console.log('3. Add new secrets named \x1b[1mMOD_SECRET_TOKEN\x1b[0m (the token above),');
                console.log('   \x1b[1mMOD_WEBHOOK\x1b[0m (Discord webhook URL for moderation actions),');
                console.log('   and \x1b[1mARCADE_WEBHOOK\x1b[0m (Discord webhook for session listings).');
                console.log('4. Paste the exact blue string below into MOD_SECRET_TOKEN and save.');
                console.log('5. For the webhook URLs, use the full Discord webhook URL.');
                console.log('=============================================================\n');

                rl.prompt();
            });
            return;

        case 'ban':
            if (!args[1]) {
                writeLog('ERROR', 'Usage: ban <IP_ADDRESS>');
            } else {
                writeLog('INFO', `Attempting to ban IP: ${args[1]}...`);
                const res = await sendModRequest('POST', { ipToBan: args[1], action: 'ban' });
                if (res) writeLog('SUCCESS', `Banned: ${args[1]}`);
            }
            break;

        case 'unban':
            if (!args[1]) {
                writeLog('ERROR', 'Usage: unban <IP_ADDRESS>');
            } else {
                writeLog('INFO', `Attempting to unban IP: ${args[1]}...`);
                const res = await sendModRequest('POST', { ipToUnban: args[1], action: 'unban' });
                if (res) writeLog('SUCCESS', `Unbanned: ${args[1]}`);
            }
            break;

        case 'list':
            writeLog('INFO', 'Fetching active ban list...');
            const list = await sendModRequest('GET');
            if (list) {
                console.log('\n--- ACTIVE BANS ---');
                console.table(list);
                console.log('-------------------\n');
                writeLog('SUCCESS', `Fetched ${list.length || 0} banned records.`);
            }
            break;

        case 'clear':
            console.clear();
            writeLog('SYSTEM', 'Console cleared.');
            break;

        case 'exit':
            writeLog('SYSTEM', 'Shutting down console.');
            process.exit(0);
            break;

        default:
            if (command) writeLog('ERROR', `Unknown command: ${command}. Available: setup, ban, unban, list, clear, exit.`);
            break;
    }
    rl.prompt();
}).on('close', () => {
    writeLog('SYSTEM', 'Console closed.');
    process.exit(0);
});
