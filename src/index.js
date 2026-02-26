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
const { startDashboard, setBotClient, emitQR, emitReady, emitDisconnected, setReleaseCallback, emitEvent } = require('./dashboard');
const { startCampaigns } = require('./campaigns');
const { startProductFeedScheduler } = require('./productPoster');

// ── Simple concurrency-limited message queue ──────────────────────────────────
// Prevents overwhelming the Puppeteer/WhatsApp bridge when many clients
// message simultaneously. All incoming messages queue up and are processed
// MAX_CONCURRENT at a time.
const MAX_CONCURRENT = 3;
let _running = 0;
const _queue = [];

function enqueueMessage(fn) {
    return new Promise((resolve, reject) => {
        _queue.push({ fn, resolve, reject });
        _drainQueue();
    });
}

function _drainQueue() {
    while (_running < MAX_CONCURRENT && _queue.length > 0) {
        const { fn, resolve, reject } = _queue.shift();
        _running++;
        fn().then(resolve, reject).finally(() => {
            _running--;
            _drainQueue();
        });
    }
}

// ── Client factory ─────────────────────────────────────────────────────────────
// A fresh Client instance is required on every reconnect — reusing an old
// instance after destroy() does NOT re-emit a QR code reliably.
function createClient() {
    return new Client({
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
}

// ── Auto-retry initialize ─────────────────────────────────────────────────────
let _reconnecting = false;
let _activeClient = null; // always points to the current live Client instance

async function safeInitialize(attempts = 0) {
    if (_reconnecting && attempts === 0) {
        console.log('[BOT] Reconnect already in progress, skipping duplicate trigger.');
        return;
    }
    _reconnecting = true;

    // Always destroy the old instance and create a fresh one so that
    // whatsapp-web.js internal state is fully reset and a new QR is emitted.
    if (_activeClient) {
        try { await _activeClient.destroy(); } catch (_) { /* already dead */ }
        _activeClient = null;
    }
    const client = createClient();
    _activeClient = client;
    attachListeners(client);
    setBotClient(client);

    try {
        console.log(`[BOT] Starting WhatsApp bot... (attempt ${attempts + 1})`);
        await client.initialize();
        _reconnecting = false;
        console.log('[BOT] Initialized successfully.');
    } catch (err) {
        console.warn(`[BOT] Init error (attempt ${attempts + 1}): ${err.message.split('\n')[0]}`);
        _reconnecting = false;
        // Always retry — clamp backoff between 5s and 2 minutes
        const wait = Math.min(5000 * Math.pow(1.5, attempts), 120000);
        console.log(`[BOT] Retrying in ${Math.round(wait / 1000)}s...`);
        setTimeout(() => safeInitialize(attempts + 1), wait);
    }
}

function attachListeners(client) {
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
        startProductFeedScheduler(client, emitEvent);
    });

    // Handle messages FROM OTHERS (private chats, groups, channels)
    client.on('message', async (msg) => {
        const prefix = process.env.BOT_PREFIX || '!';

        if (msg.from === 'status@broadcast') return;

        // Auto-reply for private (non-group, non-channel) messages
        const isPrivate = !msg.from.endsWith('@g.us') && !msg.from.endsWith('@newsletter');
        if (isPrivate && !msg.fromMe) {
            // Queue the handler to prevent Puppeteer overload under high message volume
            enqueueMessage(async () => {
                try {
                    const handled = await handleAutoReply(client, msg);
                    if (handled) return;
                    // Not handled by auto-reply — try as a command
                    if (msg.body && msg.body.startsWith(prefix)) {
                        console.log(`[MSG] From: ${msg.from} | Body: ${msg.body}`);
                        await handleCommand(client, msg, prefix);
                    }
                } catch (err) {
                    console.error('[MSG] Error processing message from', msg.from, ':', err.message);
                }
            }).catch(err => console.error('[QUEUE] Unhandled error:', err.message));
            return;
        }

        if (!msg.body || !msg.body.startsWith(prefix)) return;

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
        console.log('[BOT] Will attempt reconnect in 10s...');
        setTimeout(() => safeInitialize(), 10000);
    });

    client.on('change_state', (state) => {
        console.log('[BOT] State changed:', state);
        // If WhatsApp signals it's no longer open/connected, trigger reconnect
        if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
            console.warn(`[BOT] Bad state "${state}" — reconnecting in 5s...`);
            emitDisconnected();
            setTimeout(() => safeInitialize(), 5000);
        }
    });

    // ── Watchdog: heartbeat every 30s ─────────────────────────────────────────
    // WhatsApp Web can silently lose its connection without firing 'disconnected'.
    // Pings the page every 30s to keep Puppeteer alive and detects dead sessions.
    const watchdog = setInterval(async () => {
        // Only run against the client this listener belongs to
        if (client !== _activeClient) { clearInterval(watchdog); return; }
        try {
            // Keep the Puppeteer page from going idle
            if (client.pupPage) {
                await client.pupPage.evaluate(() => true).catch(() => {});
            }
            const state = await client.getState();
            if (!state || state !== 'CONNECTED') {
                console.warn(`[WATCHDOG] State is "${state}" — reconnecting...`);
                clearInterval(watchdog);
                emitDisconnected();
                safeInitialize();
            }
        } catch (err) {
            console.warn('[WATCHDOG] Health check failed:', err.message, '— reconnecting...');
            clearInterval(watchdog);
            emitDisconnected();
            safeInitialize();
        }
    }, 30 * 1000); // every 30 seconds
    // ─────────────────────────────────────────────────────────────────────────
}

// ── Catch stale Puppeteer errors that escape mid-session ──────────────────────
// These show up as unhandledRejection when WhatsApp Web navigates while the
// client is already running. Trigger a reconnect instead of going silent.
process.on('unhandledRejection', (reason) => {
    const msg = reason && (reason.message || String(reason));
    if (!msg) return;
    const isPuppeteer =
        msg.includes('Execution context was destroyed') ||
        msg.includes('Protocol error') ||
        msg.includes('Target closed') ||
        msg.includes('Session closed') ||
        msg.includes('Navigation') ||
        msg.includes('detached Frame');
    if (isPuppeteer) {
        console.warn('[BOT] Puppeteer crash detected. Reconnecting in 10s...');
        emitDisconnected();
        setTimeout(() => safeInitialize(), 10000);
    } else {
        console.error('[BOT] Unhandled rejection:', msg);
    }
});

// Safety net: if something kills the event loop's natural activity,
// this timer ensures the process never exits on its own.
setInterval(() => {}, 60 * 60 * 1000);

startDashboard(3000);
setReleaseCallback(releaseContact); // Allow dashboard to release agent mode

safeInitialize();
