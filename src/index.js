const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// On Fly.io the persistent volume is mounted at /app/data
// Locally it falls back to the project root
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Chrome: use env var (set in Dockerfile for Linux) or fall back to Windows path
const CHROME_PATH = process.env.CHROMIUM_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { handleCommand } = require('./commands');
const { startScheduler } = require('./scheduler');
const { handleAutoReply, agentSentMessage, releaseContact } = require('./autoreply');
const { startDashboard, setBotClient, emitQR, emitReady, emitDisconnected, setReleaseCallback } = require('./dashboard');
const { startCampaigns } = require('./campaigns');

// Create client with persistent session (no re-scan after restart)
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'whatsapp-bot',
        dataPath: path.join(DATA_DIR, '.wwebjs_auth')
    }),
    puppeteer: {
        headless: true,
        executablePath: CHROME_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// Show QR code in terminal AND save as image
client.on('qr', async (qr) => {
    console.log('\n[BOT] QR code received! Saving as image...');
    
    // Save QR as PNG image file
    const qrPath = path.join(DATA_DIR, 'qrcode.png');
    try {
        await QRCode.toFile(qrPath, qr, { width: 300, margin: 2 });
        console.log(`[BOT] >>> QR code saved to: ${qrPath}`);
        console.log('[BOT] >>> Open qrcode.png and scan it with WhatsApp!');
    } catch (err) {
        console.error('[BOT] Failed to save QR image:', err.message);
    }
    
    // Also try terminal display
    qrcode.generate(qr, { small: true });
    emitQR(qr);
});

client.on('authenticated', () => {
    console.log('[BOT] Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('[BOT] Authentication failed:', msg);
});

client.on('ready', () => {
    console.log('[BOT] Bot is ready and listening...');
    emitReady();
    startScheduler(client);
    startCampaigns(client);
});

// Handle messages FROM OTHERS (private chats, groups, channels)
client.on('message', async (msg) => {
    const prefix = process.env.BOT_PREFIX || '!';

    if (msg.from === 'status@broadcast') return;

    // Auto-reply for private (non-group, non-channel) messages
    const isPrivate = !msg.from.endsWith('@g.us') && !msg.from.endsWith('@newsletter');
    if (isPrivate && !msg.fromMe) {
        const handled = await handleAutoReply(client, msg);
        if (handled) return; // don't process as a command if auto-reply handled it
    }

    if (!msg.body.startsWith(prefix)) return;

    console.log(`[MSG] From: ${msg.from} | Body: ${msg.body}`);
    await handleCommand(client, msg, prefix);
});

// Handle YOUR OWN messages so !commands work when you type them yourself
client.on('message_create', async (msg) => {
    if (!msg.fromMe) return; // already handled above

    const prefix = process.env.BOT_PREFIX || '!';

    if (msg.from === 'status@broadcast') return;

    // When agent manually messages a contact, turn on agent mode for 8hrs
    agentSentMessage(msg.id && msg.id._serialized, msg.to);

    if (!msg.body.startsWith(prefix)) return;

    console.log(`[MSG] FromMe | To: ${msg.to} | Body: ${msg.body}`);
    await handleCommand(client, msg, prefix);
});

client.on('disconnected', (reason) => {
    console.log('[BOT] Disconnected:', reason);
    emitDisconnected();
    // Don't exit — dashboard stays alive so user can reconnect via the Connect button
});

startDashboard(3000);
setBotClient(client);
setReleaseCallback(releaseContact); // Allow dashboard to release agent mode

// Remove stale Chromium lock files left by previous container runs
// (Railway restarts can leave these behind, blocking Chromium from starting)
const authDir = path.join(DATA_DIR, '.wwebjs_auth');
['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
    const p = path.join(authDir, 'session-whatsapp-bot', f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[BOT] Removed stale lock: ${f}`); }
});

console.log('[BOT] Starting WhatsApp bot...');
client.initialize();
