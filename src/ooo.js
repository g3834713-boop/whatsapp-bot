/**
 * Out of Office mode manager
 * Persisted to config/ooo.json
 * Commands: !ooo on | !ooo off | !ooo msg <text>
 * Dashboard: GET/POST /api/ooo
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'ooo.json');

const DEFAULT_MSG =
    `🏖️ *We're currently Out of Office*\n\n` +
    `Your message has been received and we'll respond as soon as we're back!\n\n` +
    `📋 *Our working hours:*\n` +
    `• Mon – Fri: 8am – 6pm\n` +
    `• Saturday: 9am – 2pm\n` +
    `• Sunday: 11am – 4pm\n\n` +
    `_Type *0* to reach an agent or *00* for menu_`;

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { return { enabled: false, message: DEFAULT_MSG }; }
}

function save(data) {
    try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('[OOO] Save failed:', e.message); }
}

function isOOO()         { return load().enabled === true; }
function getOOOMessage() { return load().message || DEFAULT_MSG; }
function getOOOConfig()  { return load(); }

function setOOO(enabled, message) {
    const data = load();
    data.enabled = !!enabled;
    if (message !== undefined && message !== null) data.message = message;
    save(data);
    console.log(`[OOO] Mode ${enabled ? 'ON' : 'OFF'}`);
}

module.exports = { isOOO, getOOOMessage, getOOOConfig, setOOO, DEFAULT_MSG };
