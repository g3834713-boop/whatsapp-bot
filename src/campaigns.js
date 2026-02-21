/**
 * Campaigns — Promo Blasts + Re-engagement
 *
 * Promos: scheduled broadcasts to all customers
 *   config/promos.json → [ { id, name, message, day, hour, minute, enabled, lastSent } ]
 *   day: -1 = every day, 0-6 = Sun–Sat
 *
 * Re-engagement: automatically message customers inactive for X days
 *   config/reengagement.json → { enabled, daysInactive, message, lastCheck }
 *   Supports {name} placeholder in message.
 */

const fs   = require('fs');
const path = require('path');
const { getAllCustomers } = require('./customers');

const PROMOS_FILE   = path.join(__dirname, '..', 'config', 'promos.json');
const REENGAGE_FILE = path.join(__dirname, '..', 'config', 'reengagement.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Promos ────────────────────────────────────────────────────────────────────
function loadPromos() {
    try { return JSON.parse(fs.readFileSync(PROMOS_FILE, 'utf8')); }
    catch (e) { return []; }
}
function savePromos(d) {
    try { fs.writeFileSync(PROMOS_FILE, JSON.stringify(d, null, 2)); }
    catch (e) { console.error('[PROMOS] Save failed:', e.message); }
}

function getAllPromos() { return loadPromos(); }

function addPromo({ name, message, day, hour, minute }) {
    const list = loadPromos();
    const id   = Date.now().toString(36);
    list.push({
        id,
        name:     name    || 'New Promo',
        message:  message || '',
        day:      day     != null ? Number(day)    : -1, // -1 = every day
        hour:     hour    != null ? Number(hour)   : 9,
        minute:   minute  != null ? Number(minute) : 0,
        enabled:  false,
        lastSent: null,
    });
    savePromos(list);
    return id;
}

function updatePromo(id, updates) {
    const list = loadPromos();
    const i    = list.findIndex(p => p.id === id);
    if (i < 0) return false;
    list[i] = { ...list[i], ...updates };
    savePromos(list);
    return true;
}

function deletePromo(id) { savePromos(loadPromos().filter(p => p.id !== id)); }

// ── Re-engagement ─────────────────────────────────────────────────────────────
const DEFAULT_REENGAGE_MSG =
    `👋 *Hey {name}!*\n\n` +
    `We noticed it\'s been a while since you last visited us — we miss you! 💚\n\n` +
    `We have new products and updates waiting for you.\n\n` +
    `Reply *00* to browse our menu or *0* to speak with us directly. We\'d love to hear from you! 🛍️`;

function loadReengage() {
    try { return JSON.parse(fs.readFileSync(REENGAGE_FILE, 'utf8')); }
    catch (e) {
        return { enabled: false, daysInactive: 30, message: DEFAULT_REENGAGE_MSG, lastCheck: null };
    }
}
function saveReengage(d) {
    try { fs.writeFileSync(REENGAGE_FILE, JSON.stringify(d, null, 2)); }
    catch (e) { console.error('[REENGAGE] Save failed:', e.message); }
}

function getReengageConfig()        { return loadReengage(); }
function setReengageConfig(updates) { saveReengage({ ...loadReengage(), ...updates }); }

// ── Broadcast helper ──────────────────────────────────────────────────────────
async function broadcastText(client, text) {
    const customers = getAllCustomers();
    let sent = 0, failed = 0;
    for (const c of customers) {
        try {
            await client.sendMessage(c.id, text);
            sent++;
            await sleep(1200);
        } catch (e) {
            failed++;
            console.error(`[CAMPAIGNS] Failed ${c.id}:`, e.message);
        }
    }
    return { sent, failed, total: customers.length };
}

// ── Promo scheduler helpers ───────────────────────────────────────────────────
function isPromoDue(promo) {
    const now    = new Date();
    const day    = now.getDay();
    const hour   = now.getHours();
    const minute = now.getMinutes();
    if (promo.day !== -1 && promo.day !== day) return false;
    if (promo.hour   !== hour)                 return false;
    if (promo.minute !== minute)               return false;
    // Prevent double-fire within the same minute
    if (promo.lastSent && Date.now() - new Date(promo.lastSent).getTime() < 90000) return false;
    return true;
}

// ── Re-engagement runner ──────────────────────────────────────────────────────
async function runReengage(client) {
    const cfg = loadReengage();
    if (!cfg.enabled) return;

    // Only run once per day (23-hour cooldown)
    if (cfg.lastCheck && Date.now() - new Date(cfg.lastCheck).getTime() < 23 * 3600 * 1000) return;

    const threshold = cfg.daysInactive * 24 * 3600 * 1000;
    const inactive  = getAllCustomers().filter(c => {
        if (!c.lastSeen || !c.firstSeen) return false;
        // Both lastSeen AND firstSeen must be older than the threshold
        // (avoids re-engaging brand-new customers who just happen to be quiet)
        return (
            Date.now() - new Date(c.lastSeen).getTime()  >= threshold &&
            Date.now() - new Date(c.firstSeen).getTime() >= threshold
        );
    });

    console.log(`[REENGAGE] ${inactive.length} inactive customer(s) to contact`);
    let sent = 0;
    for (const c of inactive) {
        const name = c.name || c.id.split('@')[0];
        const text = cfg.message.replace(/\{name\}/g, name);
        try {
            await client.sendMessage(c.id, text);
            sent++;
            await sleep(1200);
        } catch (e) {
            console.error(`[REENGAGE] Failed ${c.id}:`, e.message);
        }
    }
    if (sent) console.log(`[REENGAGE] Sent to ${sent}/${inactive.length}`);
    saveReengage({ ...cfg, lastCheck: new Date().toISOString() });
}

// ── Main start ────────────────────────────────────────────────────────────────
function startCampaigns(client) {
    console.log('[CAMPAIGNS] Started');

    // Promo tick — check every minute
    setInterval(async () => {
        const list = loadPromos();
        for (const promo of list) {
            if (!promo.enabled || !isPromoDue(promo)) continue;
            const customers = getAllCustomers();
            if (!customers.length) { console.log('[PROMOS] No customers yet'); continue; }
            console.log(`[PROMOS] Firing "${promo.name}" → ${customers.length} customer(s)`);
            const r = await broadcastText(client, promo.message);
            updatePromo(promo.id, { lastSent: new Date().toISOString() });
            console.log(`[PROMOS] "${promo.name}" done — sent:${r.sent} failed:${r.failed}`);
        }
    }, 60000);

    // Re-engagement check: 30s after startup, then every hour
    setTimeout(() => {
        runReengage(client);
        setInterval(() => runReengage(client), 3600 * 1000);
    }, 30000);
}

module.exports = {
    getAllPromos, addPromo, updatePromo, deletePromo,
    getReengageConfig, setReengageConfig,
    broadcastText, startCampaigns,
    DEFAULT_REENGAGE_MSG,
};
