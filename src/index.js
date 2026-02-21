const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// On Railway the persistent volume is mounted at /app/data
// Locally it falls back to the project root
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Chrome: use env var (set in Dockerfile for Linux) or fall back to Windows path
const CHROME_PATH = process.env.CHROMIUM_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Each Railway service gets its own CLIENT_ID so sessions don't collide.
// Default keeps backwards-compat for local dev.
const CLIENT_ID = process.env.CLIENT_ID || 'whatsapp-bot';

const { handleCommand } = require('./commands');
const { startScheduler } = require('./scheduler');
const { handleAutoReply, agentSentMessage, releaseContact } = require('./autoreply');
const { startDashboard, setBotClient, emitQR, emitReady, emitDisconnected, setReleaseCallback } = require('./dashboard');
const { startCampaigns } = require('./campaigns');

// Create client with persistent session (no re-scan after restart)
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: CLIENT_ID,
        dataPath: path.join(DATA_DIR, '.wwebjs_auth')
    }),
    // Increase CDP protocol timeout — default 30s is too short on Railway cold starts
    // where WhatsApp Web may navigate/redirect before script injection completes.
    protocolTimeout: 120000,
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
            '--disable-gpu',
            // Prevent page isolation from destroying execution contexts mid-inject
            '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor',
            '--disable-site-isolation-trials',
            '--shm-size=256mb',
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
    // Auto-reconnect after 10s — destroy the old browser instance first
    console.log('[BOT] Will attempt reconnect in 10s...');
    setTimeout(async () => {
        try { await client.destroy(); } catch (_) { /* already dead */ }
        safeInitialize();
    }, 10000);
});

startDashboard(3000);
setBotClient(client);
setReleaseCallback(releaseContact); // Allow dashboard to release agent mode

// ── Auto-retry initialize ─────────────────────────────────────────────────────
// WhatsApp Web sometimes navigates mid-injection on first cold start in a
// container, or crashes mid-session. Retry up to 5 times with back-off.
let _reconnecting = false;

async function safeInitialize(attempts = 0) {
    if (_reconnecting && attempts === 0) {
        console.log('[BOT] Reconnect already in progress, skipping duplicate trigger.');
        return;
    }
    _reconnecting = true;
    const MAX = 5;
    try {
        console.log(`[BOT] Starting WhatsApp bot... (attempt ${attempts + 1}/${MAX})`);
        await client.initialize();
        _reconnecting = false;
    } catch (err) {
        const isRetryable =
            err.message && (
                err.message.includes('Execution context was destroyed') ||
                err.message.includes('Protocol error') ||
                err.message.includes('Target closed') ||
                err.message.includes('Session closed') ||
                err.message.includes('Navigation')
            );
        if (isRetryable && attempts < MAX - 1) {
            const wait = (attempts + 1) * 5000;
            console.warn(`[BOT] Init failed (${err.message.split('\n')[0]}). Retrying in ${wait / 1000}s...`);
            try { await client.destroy(); } catch (_) {}
            await new Promise(r => setTimeout(r, wait));
            return safeInitialize(attempts + 1);
        }
        console.error('[BOT] Failed to initialize after retries:', err.message);
        _reconnecting = false;
        // Keep process alive so dashboard remains accessible
    }
}

// ── Catch stale Puppeteer errors that escape mid-session ──────────────────────
// These show up as unhandledRejection when WhatsApp Web navigates while the
// client is already running. Trigger a reconnect instead of going silent.
process.on('unhandledRejection', (reason) => {
    const msg = reason && (reason.message || String(reason));
    const isPuppeteer =
        msg && (
            msg.includes('Execution context was destroyed') ||
            msg.includes('Protocol error') ||
            msg.includes('Target closed') ||
            msg.includes('Session closed')
        );
    if (isPuppeteer) {
        console.warn('[BOT] Puppeteer mid-session crash detected. Reconnecting in 10s...');
        emitDisconnected();
        setTimeout(async () => {
            try { await client.destroy(); } catch (_) {}
            safeInitialize();
        }, 10000);
    } else {
        console.error('[BOT] Unhandled rejection:', msg);
    }
});

safeInitialize();
