/**
 * Dashboard server — Express + Socket.io
 * Opens at http://localhost:3000
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const QRCode   = require('qrcode');
const AdmZip = require('adm-zip');
const { getOOOConfig, setOOO } = require('./ooo');
const { getAllPromos, addPromo, updatePromo, deletePromo, getReengageConfig, setReengageConfig } = require('./campaigns');
const { loadCache: loadProductCache, refreshProductCache } = require('./productScraper');
const { loadFeedConfig, saveFeedConfig, runDailyFeed } = require('./productPoster');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── Auth helpers ──────────────────────────────────────────────────────────────
// If DASHBOARD_PASSWORD env var is set, all /api routes (except /api/auth and
// /api/login) require a Bearer token.  Socket connections require the same token
// via handshake.auth.token.  Without the env var the dashboard stays fully open
// (local dev, no password set).
function _makeToken(pwd) {
    return crypto.createHash('sha256').update('wbot:' + pwd).digest('hex');
}

function _authMiddleware(req, res, next) {
    const pwd = process.env.DASHBOARD_PASSWORD;
    if (!pwd) return next();
    if (req.path === '/auth' || req.path === '/login') return next();
    const auth  = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token === _makeToken(pwd)) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

io.use((socket, next) => {
    const pwd = process.env.DASHBOARD_PASSWORD;
    if (!pwd) return next();
    const token = socket.handshake.auth.token || socket.handshake.query.token || '';
    if (token === _makeToken(pwd)) return next();
    next(new Error('Unauthorized'));
});

app.use(express.json());
app.use('/api', _authMiddleware);
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// ── Public: auth probe + login ────────────────────────────────────────────────
app.get('/api/auth', (req, res) => {
    res.json({ required: !!process.env.DASHBOARD_PASSWORD });
});

app.post('/api/login', (req, res) => {
    const pwd = process.env.DASHBOARD_PASSWORD;
    if (!pwd) return res.json({ ok: true, token: '' });
    if (req.body.password === pwd) {
        res.json({ ok: true, token: _makeToken(pwd) });
    } else {
        res.status(401).json({ ok: false, error: 'Wrong password' });
    }
});

// ── State ────────────────────────────────────────────────────────────────────
let botClient  = null;
let botStatus  = 'disconnected'; // 'disconnected' | 'qr' | 'connected'
let lastQRData = null; // base64 PNG data URL

// ── Agent Queue ───────────────────────────────────────────────────────────────
// Tracks contacts waiting for a human agent: contactId → { name, time }
const agentQueue  = new Map();
let _releaseCallback = null; // fn(contactId) — set from index.js to release agent mode

function setReleaseCallback(fn) { _releaseCallback = fn; }

function _emitQueue() {
    const arr = Array.from(agentQueue.entries()).map(([id, info]) => ({
        id, name: info.name, time: info.time,
    }));
    io.emit('agent-queue', arr);
}

function addToQueue(contactId, name) {
    agentQueue.set(contactId, { name: name || contactId.split('@')[0], time: Date.now() });
    _emitQueue();
}

function removeFromQueue(contactId) {
    agentQueue.delete(contactId);
    _emitQueue();
}

// ── Bot event hooks (called from index.js) ───────────────────────────────────
function setBotClient(client) {
    botClient = client;
}

async function emitQR(qrString) {
    try {
        lastQRData = await QRCode.toDataURL(qrString);
        botStatus  = 'qr';
        io.emit('qr',     lastQRData);
        io.emit('status', botStatus);
    } catch (e) {
        console.error('[DASHBOARD] QR gen error:', e.message);
    }
}

function emitReady() {
    lastQRData = null;
    botStatus  = 'connected';
    io.emit('status', 'connected');
}

function emitDisconnected() {
    botStatus = 'disconnected';
    io.emit('status', 'disconnected');
}

// ── API: status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, qr: lastQRData });
});

// ── Health check — for uptime monitors & hosting platforms ───────────────────
const _startTime = Date.now();
app.get('/health', (req, res) => {
    const uptimeSec = Math.floor((Date.now() - _startTime) / 1000);
    const hh = Math.floor(uptimeSec / 3600);
    const mm = Math.floor((uptimeSec % 3600) / 60);
    const ss = uptimeSec % 60;
    const uptime = `${hh}h ${mm}m ${ss}s`;

    res.status(200).json({
        status:    botStatus === 'connected' ? 'ok' : 'degraded',
        bot:       botStatus,
        uptime,
        timestamp: new Date().toISOString(),
    });
});

// ── API: agent queue ─────────────────────────────────────────────────────────
app.get('/api/agent-queue', (req, res) => {
    const arr = Array.from(agentQueue.entries()).map(([id, info]) => ({
        id, name: info.name, time: info.time,
    }));
    res.json(arr);
});

// Release a contact from agent mode via the dashboard
app.delete('/api/agent-queue/:contactId', (req, res) => {
    const contactId = decodeURIComponent(req.params.contactId);
    removeFromQueue(contactId);
    if (_releaseCallback) _releaseCallback(contactId);
    res.json({ ok: true });
});

// ── API: chats (groups + channels) ───────────────────────────────────────────
app.get('/api/chats', async (req, res) => {
    if (!botClient || botStatus !== 'connected') {
        return res.json({ groups: [], channels: [] });
    }
    try {
        const chats    = await botClient.getChats();
        const groups   = chats
            .filter(c => c.isGroup || (c.id && c.id._serialized && c.id._serialized.endsWith('@g.us')))
            .map(c => ({
                id:                c.id._serialized,
                name:              c.name || c.id._serialized,
                participantsCount: Array.isArray(c.participants) ? c.participants.length : 0,
                description:       c.description || '',
            }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        let channels = [];
        try {
            const newsletters = await botClient.getSubscribedNewsletters();
            channels = newsletters.map(n => ({
                id:          n.id._serialized,
                name:        n.name || n.id._serialized,
                description: n.description || '',
            }));
        } catch (_) {}

        res.json({ groups, channels });
    } catch (err) {
        res.status(500).json({ groups: [], channels: [], error: err.message });
    }
});

// ── API: schedules ────────────────────────────────────────────────────────────
const SCHEDULES_PATH  = path.join(__dirname, '..', 'config', 'schedules.json');
const AUTOREPLY_PATH  = path.join(__dirname, '..', 'config', 'autoreply.json');

app.get('/api/schedules', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'))); }
    catch (_) { res.json([]); }
});

app.post('/api/schedules', (req, res) => {
    try {
        fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Add a brand-new schedule entry
app.post('/api/schedules/add', (req, res) => {
    try {
        const list = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
        const { name, chatId, type, mode, intervalSeconds } = req.body;
        const isChannel = chatId && chatId.endsWith('@newsletter');
        list.push({
            name:            name || 'New Schedule',
            type:            type || (isChannel ? 'channel' : 'group'),
            mode:            mode || 'rotating',
            chatId:          chatId || '',
            intervalSeconds: intervalSeconds || 120,
            enabled:         false,
            tasks: [{ type: 'text', message: 'Hello from the bot! ✅' }]
        });
        fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(list, null, 2));
        res.json({ ok: true, schedule: list[list.length - 1], index: list.length - 1 });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Delete a schedule by index
app.delete('/api/schedules/:index', (req, res) => {
    try {
        const list = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
        const idx = parseInt(req.params.index);
        if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(list, null, 2));
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── API: connect / disconnect ────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
    if (!botClient) return res.json({ ok: false, error: 'No client instance available' });
    if (botStatus === 'connected') return res.json({ ok: false, error: 'Already connected' });
    try {
        botStatus = 'connecting';
        io.emit('status', 'connecting');
        await botClient.initialize();
        res.json({ ok: true });
    } catch (e) {
        console.error('[DASHBOARD] Connect error:', e.message);
        res.json({ ok: false, error: e.message });
    }
});

app.post('/api/disconnect', async (req, res) => {
    if (!botClient) return res.json({ ok: false, error: 'No client instance available' });
    if (botStatus === 'disconnected') return res.json({ ok: false, error: 'Already disconnected' });
    try {
        await botClient.destroy();
        botStatus  = 'disconnected';
        lastQRData = null;
        io.emit('status', 'disconnected');
        res.json({ ok: true });
    } catch (e) {
        console.error('[DASHBOARD] Disconnect error:', e.message);
        res.json({ ok: false, error: e.message });
    }
});

// ── API: OOO ──────────────────────────────────────────────────────────────────
app.get('/api/ooo', (req, res) => res.json(getOOOConfig()));
app.post('/api/ooo', (req, res) => {
    const { enabled, message } = req.body;
    setOOO(!!enabled, message);
    res.json({ ok: true });
});

// ── API: Promo blasts ─────────────────────────────────────────────────────────
app.get('/api/promos', (req, res) => res.json(getAllPromos()));
app.post('/api/promos', (req, res) => {
    const id = addPromo(req.body);
    res.json({ ok: true, id });
});
app.put('/api/promos/:id', (req, res) => {
    const ok = updatePromo(req.params.id, req.body);
    res.json({ ok });
});
app.delete('/api/promos/:id', (req, res) => {
    deletePromo(req.params.id);
    res.json({ ok: true });
});

// ── API: Re-engagement ────────────────────────────────────────────────────────
app.get('/api/reengagement', (req, res) => res.json(getReengageConfig()));
app.post('/api/reengagement', (req, res) => {
    setReengageConfig(req.body);
    res.json({ ok: true });
});

// ── API: autoreply config ─────────────────────────────────────────────────────
// Convert legacy { responses:{} } format to { menuItems:[] } on the fly
function _normalizeAutoReply(raw) {
    if (raw.menuItems && Array.isArray(raw.menuItems) && raw.menuItems.length) return raw;
    const ORDER = ['1','2','3','4','5','6','0'];
    const menuItems = ORDER
        .filter(k => raw.responses && raw.responses[k])
        .map(k => ({
            key:       k,
            label:     (raw.responses[k].split('\n')[0] || '').replace(/\*/g,'').trim(),
            response:  raw.responses[k],
            agentMode: k === '0',
            subItems:  k === '6' ? [
                { key:'1', label:'\ud83d\udcb3 Pay for Order',    response:'After payment, please submit your screenshot.\n\n_Enter *10* to exit_', image:'pay'  },
                { key:'2', label:'\ud83d\ude9a Pay for Shipping', response:'After payment, please submit your screenshot.\n\n_Enter *10* to exit_', image:'ship' },
            ] : [],
        }));
    return Object.assign({}, raw, { menuItems });
}

// ── Config validation ────────────────────────────────────────────────────────
function validateConfig(type, body) {
    if (type === 'autoreply') {
        if (!body || typeof body !== 'object') return 'Body must be an object.';
        if (!body.businessName || !String(body.businessName).trim())
            return 'Business name must not be empty.';
        if (!Array.isArray(body.menuItems)) return 'menuItems must be an array.';
        const topKeys = [];
        for (let i = 0; i < body.menuItems.length; i++) {
            const item = body.menuItems[i];
            if (!item.key || !String(item.key).trim())
                return `Menu item #${i + 1}: key must not be empty.`;
            if (!item.label || !String(item.label).trim())
                return `Menu item #${i + 1} (key "${item.key}"): label must not be empty.`;
            if (topKeys.includes(item.key))
                return `Duplicate menu key "${item.key}" — each top-level key must be unique.`;
            topKeys.push(item.key);
            if (Array.isArray(item.subItems)) {
                const subKeys = [];
                for (let j = 0; j < item.subItems.length; j++) {
                    const sub = item.subItems[j];
                    if (!sub.key || !String(sub.key).trim())
                        return `Menu item "${item.key}", sub-item #${j + 1}: key must not be empty.`;
                    if (!sub.label || !String(sub.label).trim())
                        return `Menu item "${item.key}", sub-item "${sub.key}": label must not be empty.`;
                    if (subKeys.includes(sub.key))
                        return `Menu item "${item.key}": duplicate sub-item key "${sub.key}".`;
                    subKeys.push(sub.key);
                }
            }
        }
        return null; // valid
    }

    if (type === 'messages') {
        const wh = body && body.workHours;
        if (wh) {
            const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
            if (wh.start && !timeRe.test(wh.start))
                return `workHours.start "${wh.start}" is not a valid HH:MM time.`;
            if (wh.end && !timeRe.test(wh.end))
                return `workHours.end "${wh.end}" is not a valid HH:MM time.`;
        }
        return null; // valid
    }

    if (type === 'settings') {
        if (!body || typeof body !== 'object') return 'Body must be an object.';
        const t = Number(body.agentTimeoutHours);
        if (isNaN(t) || t <= 0)
            return 'agentTimeoutHours must be a positive number.';
        if (!body.discountCodePrefix || !String(body.discountCodePrefix).trim())
            return 'discountCodePrefix must not be empty.';
        if (Array.isArray(body.keywords)) {
            const seen = new Set();
            for (let i = 0; i < body.keywords.length; i++) {
                const kw = body.keywords[i];
                if (!kw.word || !String(kw.word).trim())
                    return `Keyword #${i + 1}: word must not be empty.`;
                if (!kw.target || !String(kw.target).trim())
                    return `Keyword "${kw.word}": target must not be empty.`;
                const w = kw.word.trim().toLowerCase();
                if (seen.has(w)) return `Duplicate keyword "${w}" — each keyword must be unique.`;
                seen.add(w);
            }
        }
        if (Array.isArray(body.legacyPaymentSubItems)) {
            const seen = new Set();
            for (let i = 0; i < body.legacyPaymentSubItems.length; i++) {
                const s = body.legacyPaymentSubItems[i];
                if (!s.key || !String(s.key).trim())
                    return `Legacy sub-item #${i + 1}: key must not be empty.`;
                if (!s.label || !String(s.label).trim())
                    return `Legacy sub-item "${s.key}": label must not be empty.`;
                if (seen.has(s.key)) return `Duplicate legacy sub-item key "${s.key}".`;
                seen.add(s.key);
            }
        }
        return null; // valid
    }

    return null; // unknown type — pass through
}

app.get('/api/autoreply', (req, res) => {
    try { res.json(_normalizeAutoReply(JSON.parse(fs.readFileSync(AUTOREPLY_PATH, 'utf8')))); }
    catch (_) { res.json({ enabled: true, businessName: 'My Business', menuItems: [] }); }
});

app.post('/api/autoreply', (req, res) => {
    try {
        const err = validateConfig('autoreply', req.body);
        if (err) return res.json({ ok: false, error: err });
        fs.writeFileSync(AUTOREPLY_PATH, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── API: messages config ──────────────────────────────────────────────────────
const MESSAGES_PATH = path.join(__dirname, '..', 'config', 'messages.json');

app.get('/api/messages', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'))); }
    catch (_) { res.json({}); }
});

app.post('/api/messages', (req, res) => {
    try {
        const err = validateConfig('messages', req.body);
        if (err) return res.json({ ok: false, error: err });
        fs.writeFileSync(MESSAGES_PATH, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});
// ── API: bot settings ─────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'settings.json');

app.get('/api/settings', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))); }
    catch (_) { res.json({}); }
});

app.post('/api/settings', (req, res) => {
    try {
        const err = validateConfig('settings', req.body);
        if (err) return res.json({ ok: false, error: err });
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── API: backup & restore ─────────────────────────────────────────────────────
const CONFIG_DIR = path.join(__dirname, '..', 'config');

// Files included in backup (config JSONs + all images)
const BACKUP_CONFIG_FILES = [
    'autoreply.json', 'messages.json', 'settings.json', 'schedules.json', 'customers.json',
];

app.get('/api/backup', (req, res) => {
    try {
        const zip = new AdmZip();
        // Add each config file if it exists
        for (const fname of BACKUP_CONFIG_FILES) {
            const fpath = path.join(CONFIG_DIR, fname);
            if (fs.existsSync(fpath)) zip.addLocalFile(fpath, 'config');
        }
        // Add all images
        if (fs.existsSync(IMAGES_DIR)) {
            const imgs = fs.readdirSync(IMAGES_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
            for (const img of imgs) zip.addLocalFile(path.join(IMAGES_DIR, img), 'images');
        }
        const buf = zip.toBuffer();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="wbot-backup-${timestamp}.zip"`);
        res.send(buf);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/restore', (req, res) => {
    try {
        const { data } = req.body; // base64-encoded zip
        if (!data) return res.status(400).json({ ok: false, error: 'No zip data provided.' });
        const buf = Buffer.from(data, 'base64');
        const zip = new AdmZip(buf);
        const entries = zip.getEntries();
        const allowed = new Set(BACKUP_CONFIG_FILES);
        const restored = [];
        const skipped  = [];
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const entryName = entry.entryName; // e.g. "config/autoreply.json" or "images/pay.png"
            const parts = entryName.split('/');
            const folder = parts[0];
            const fname  = parts[parts.length - 1];
            if (!fname || /\.\.|[<>:"|?*]/.test(fname)) { skipped.push(entryName); continue; }
            if (folder === 'config') {
                if (!allowed.has(fname)) { skipped.push(entryName); continue; }
                // Validate before writing
                let parsed;
                try { parsed = JSON.parse(entry.getData().toString('utf8')); }
                catch (_) { return res.json({ ok: false, error: `${fname} contains invalid JSON.` }); }
                const type = fname.replace('.json', '');
                const err = validateConfig(type, parsed);
                if (err) return res.json({ ok: false, error: `${fname}: ${err}` });
                if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
                fs.writeFileSync(path.join(CONFIG_DIR, fname), JSON.stringify(parsed, null, 2));
                restored.push(entryName);
            } else if (folder === 'images') {
                if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/i.test(fname)) { skipped.push(entryName); continue; }
                if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
                fs.writeFileSync(path.join(IMAGES_DIR, fname), entry.getData());
                restored.push(entryName);
            } else {
                skipped.push(entryName);
            }
        }
        res.json({ ok: true, restored, skipped });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── API: payment images ───────────────────────────────────────────────────────
const IMAGES_DIR = path.join(__dirname, '..', 'images');

// Serve an image by slug (pay, ship, teller …)
app.get('/api/images/:name', (req, res) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.name)) return res.status(400).end();
    const candidates = [req.params.name + '.png', req.params.name + '.PNG']
        .map(n => path.join(IMAGES_DIR, n));
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) return res.status(404).end();
    res.sendFile(found);
});

// Upload a new image via base64 JSON: { name: "pay"|"ship", data: "<base64>" }
app.post('/api/images/upload', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: 'Invalid name' });
        if (!data) return res.status(400).json({ ok: false, error: 'No data' });
        if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
        fs.writeFileSync(path.join(IMAGES_DIR, name + '.png'), Buffer.from(data, 'base64'));
        // Remove old uppercase variant if present to avoid confusion
        const upper = path.join(IMAGES_DIR, name + '.PNG');
        if (fs.existsSync(upper)) fs.unlinkSync(upper);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── API: product feed ────────────────────────────────────────────────────────
let _scrapeInProgress = false;

app.get('/api/productfeed/config', (req, res) => {
    res.json(loadFeedConfig());
});

app.post('/api/productfeed/config', (req, res) => {
    try {
        const cfg = { ...loadFeedConfig(), ...req.body };
        saveFeedConfig(cfg);
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/productfeed/cache', (req, res) => {
    const cache = loadProductCache();
    res.json({
        lastUpdated:   cache.lastUpdated  || null,
        totalProducts: (cache.products   || []).length,
        totalScraped:  cache.totalScraped || 0,
    });
});

app.post('/api/productfeed/scrape', (req, res) => {
    if (_scrapeInProgress) return res.json({ ok: false, error: 'A scrape is already running.' });
    _scrapeInProgress = true;
    res.json({ ok: true, message: 'Scrape started.' });
    refreshProductCache((done, total, keyword, count) => {
        io.emit('scrape-progress', { done, total, keyword, count });
    }).then(cache => {
        _scrapeInProgress = false;
        io.emit('scrape-complete', { total: (cache.products || []).length, lastUpdated: cache.lastUpdated });
    }).catch(e => {
        _scrapeInProgress = false;
        io.emit('scrape-error', { error: e.message });
    });
});

app.post('/api/productfeed/test', (req, res) => {
    if (!botClient) return res.json({ ok: false, error: 'Bot is not connected.' });
    runDailyFeed(botClient, (evt, data) => io.emit(evt, data)).catch(e => console.error('[FEED] Test run error:', e.message));
    res.json({ ok: true, message: 'Test feed started. Check the group!' });
});

io.on('connection', (socket) => {
    socket.emit('status', botStatus);
    if (lastQRData) socket.emit('qr', lastQRData);
    // Send current agent queue
    const arr = Array.from(agentQueue.entries()).map(([id, info]) => ({
        id, name: info.name, time: info.time,
    }));
    socket.emit('agent-queue', arr);
    console.log('[DASHBOARD] Browser connected');
});

// ── Start ─────────────────────────────────────────────────────────────────────
function startDashboard(port = 3000) {
    const actualPort = process.env.PORT || port;
    server.listen(actualPort, () => {
        console.log(`[DASHBOARD] Open http://localhost:${actualPort} in your browser`);
    });
}

function emitEvent(event, data) { io.emit(event, data); }

module.exports = { startDashboard, setBotClient, emitQR, emitReady, emitDisconnected, addToQueue, removeFromQueue, setReleaseCallback, emitEvent };
