const DiscordRPC = require('discord-rpc');
const clientId = '1241907722765324391'; // Nearcade Client ID

DiscordRPC.register(clientId);

const rpc = new DiscordRPC.Client({ transport: 'ipc' });

rpc.on('ready', () => {
    console.log('[Discord RPC Test] Successfully connected and ready!');
    rpc.setActivity({
        details: 'Testing Discord RPC',
        state: 'Isolating the issue',
        startTimestamp: Date.now(),
        largeImageKey: 'nearsec_logo',
        largeImageText: 'Nearcade Test'
    }).then(() => {
        console.log('[Discord RPC Test] Activity set successfully!');
        setTimeout(() => process.exit(0), 2000);
    }).catch(err => {
        console.error('[Discord RPC Test] Failed to set activity:', err);
        process.exit(1);
    });
});

rpc.login({ clientId }).catch(err => {
    console.error('[Discord RPC Test] Login failed:', err.message);
    if (err.message.includes('Could not connect')) {
        console.error('This usually means the Discord client is not running, or the IPC socket could not be found.');
    }
    process.exit(1);
});
