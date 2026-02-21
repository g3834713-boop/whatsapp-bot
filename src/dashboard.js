/**
 * Dashboard server — Express + Socket.io
 * Opens at http://localhost:3000
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const fs       = require('fs');
const path     = require('path');
const QRCode   = require('qrcode');
const { getOOOConfig, setOOO } = require('./ooo');
const { getAllPromos, addPromo, updatePromo, deletePromo, getReengageConfig, setReengageConfig } = require('./campaigns');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

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

    const ok = botStatus === 'connected';
    res.status(ok ? 200 : 503).json({
        status:    ok ? 'ok' : 'degraded',
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
app.get('/api/autoreply', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(AUTOREPLY_PATH, 'utf8'))); }
    catch (_) { res.json({ enabled: true, businessName: 'My Business', responses: {} }); }
});

app.post('/api/autoreply', (req, res) => {
    try {
        fs.writeFileSync(AUTOREPLY_PATH, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Socket.io: send current state to new connections ─────────────────────────
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
    server.listen(port, () => {
        console.log(`[DASHBOARD] Open http://localhost:${port} in your browser`);
    });
}

module.exports = { startDashboard, setBotClient, emitQR, emitReady, emitDisconnected, addToQueue, removeFromQueue, setReleaseCallback };
