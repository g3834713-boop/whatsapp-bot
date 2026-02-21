/**
 * Auto-reply handler -- reads config from config/autoreply.json
 * Edit that file (or via the dashboard) without restarting.
 */

const fs   = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { recordCustomer, touchCustomer, markWelcomeSent } = require('./customers');
const { addToQueue, removeFromQueue } = require('./dashboard');
const { isOOO, getOOOMessage } = require('./ooo');

const CONFIG_PATH     = path.join(__dirname, '..', 'config', 'autoreply.json');
const AGENT_MODE_FILE = path.join(__dirname, '..', 'config', 'agentmode.json');
const OPTION_KEYS     = ['1', '2', '3', '4', '5', '6', '0'];

// Tracks which contacts have already been shown the menu this session
const menuShown = new Set();

// Tracks which contacts are currently in the payment sub-menu
const paymentSubMenu = new Set();

// ── Agent mode ────────────────────────────────────────────────────────────────
// Map: contactId → timestamp when agent mode was last refreshed
// Persisted to disk so it survives bot restarts.
const AGENT_MODE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours of inactivity

const agentMode = new Map();

function saveAgentMode() {
    try {
        const data = {};
        for (const [k, v] of agentMode) data[k] = v;
        fs.writeFileSync(AGENT_MODE_FILE, JSON.stringify(data, null, 2));
    } catch (e) { /* non-fatal */ }
}

function loadAgentMode() {
    try {
        const data = JSON.parse(fs.readFileSync(AGENT_MODE_FILE, 'utf8'));
        const now  = Date.now();
        for (const [k, v] of Object.entries(data)) {
            // Only restore entries that haven't expired yet
            if (now - v < AGENT_MODE_TIMEOUT_MS) agentMode.set(k, v);
        }
        if (agentMode.size) console.log(`[AUTO-REPLY] Restored ${agentMode.size} agent mode session(s) from disk`);
    } catch (e) { /* file missing on first run — fine */ }
}

loadAgentMode(); // run once at startup

// ── Working hours ─────────────────────────────────────────────────────────────
// Mon=1 Tue=2 Wed=3 Thu=4 Fri=5 Sat=6 Sun=0  (getDay() values)
const WORK_HOURS = {
    1: { open: 8,  close: 18 }, // Mon
    2: { open: 8,  close: 18 }, // Tue
    3: { open: 8,  close: 18 }, // Wed
    4: { open: 8,  close: 18 }, // Thu
    5: { open: 8,  close: 18 }, // Fri
    6: { open: 9,  close: 14 }, // Sat
    0: { open: 11, close: 16 }, // Sun — 11am–4pm
};

// ── Timezone-aware time helpers ───────────────────────────────────────────────
// Railway servers run UTC. Set BOT_TIMEZONE (e.g. "Africa/Johannesburg") so
// working-hours checks use your local time instead of the server clock.
function _localParts() {
    const tz  = process.env.BOT_TIMEZONE || 'UTC';
    const now  = new Date();
    // Intl gives us locale strings like "Fri, 21 Feb 2026, 10:35:00"
    const fmt  = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day  = dayMap[parts.weekday] ?? now.getDay();
    const hour = parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60;
    return { day, hour };
}

function isOpenNow() {
    const { day, hour } = _localParts();
    const slot = WORK_HOURS[day];
    if (!slot) return false;
    return hour >= slot.open && hour < slot.close;
}

function fmtHour(h) {
    if (h === 12) return '12pm';
    if (h === 0)  return '12am';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function closedMessage() {
    const { day } = _localParts();
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    // Find next open day
    for (let i = 1; i <= 7; i++) {
        const next = WORK_HOURS[(day + i) % 7];
        if (next) {
            const nextDay = days[(day + i) % 7];
            return (
                `🕐 *We're currently closed*\n\n` +
                `📋 *Our working hours:*\n` +
                `• Mon – Fri: 8am – 6pm\n` +
                `• Saturday: 9am – 2pm\n` +
                `• Sunday: 11am – 4pm\n\n` +
                `✅ Your message has been received! We'll get back to you during any of the hours listed above.\n` +
                `Next available: *${nextDay}* at *${fmtHour(next.open)}*\n\n` +
                `_Type *0* to reach an agent or *00* for menu_`
            );
        }
    }
    return `🕐 *We're currently closed.* We'll respond next business day.`;
}
// ─────────────────────────────────────────────────────────────────────────────

// Set of message IDs the bot itself sent — used to ignore bot messages in message_create
// so they never accidentally refresh or clear agent mode.
const botSentIds = new Set();

// Set of contactIds the bot is currently auto-replying to.
// message_create fires BEFORE sendMessage resolves, so trackBotMessage is too slow.
// This flag blocks agentSentMessage during the entire handleAutoReply call.
const botReplying = new Set();

/** Register a sent message so releaseAgentMode ignores it. */
function trackBotMessage(sentMsg) {
    if (!sentMsg) return;
    const id = sentMsg.id && sentMsg.id._serialized;
    if (id) {
        botSentIds.add(id);
        // Auto-clean after 30 seconds to avoid unbounded growth
        setTimeout(() => botSentIds.delete(id), 30000);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { enabled: false, businessName: 'My Business', responses: {} };
    }
}

const KEYWORDS = {
    'hi': 'menu', 'hello': 'menu', 'hey': 'menu', 'hii': 'menu', 'hiii': 'menu',
    'menu': 'menu', 'help': 'menu', 'start': 'menu', 'info': 'menu', '00': 'menu',
    '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '0': '0',
    'order': '2', 'price': '1', 'prices': '1', 'product': '1', 'products': '1',
    'hours': '5', 'track': '3', 'support': '4', 'agent': '0', 'human': '0',
    'pay': '6', 'payment': '6', 'payments': '6', 'paying': '6',
    '10': 'exit', 'exit': 'exit', 'bye': 'exit', 'done': 'exit',
};

/** Strips emojis / symbols, lowercases — used for label matching */
function normalize(str) {
    return str
        .replace(/[\u{1F300}-\u{1FFFF}]/gu, '') // remove emojis
        .replace(/[^a-z0-9\s]/gi, ' ')           // symbols → space
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Builds { normalizedLabel → key } from live config so typing the menu
 * item text (or a close match) returns the right response.
 */
function buildLabelMap(cfg) {
    const map = {};
    const r   = cfg.responses || {};
    OPTION_KEYS.forEach(k => {
        if (!r[k]) return;
        const label = normalize(r[k].split('\n')[0]);
        if (label) map[label] = k;
    });
    return map;
}

/** Returns a response key if the input fuzzy-matches a label, else null */
function matchLabel(input, labelMap) {
    const norm = normalize(input);
    if (!norm) return null;
    // Exact label match
    if (labelMap[norm]) return labelMap[norm];
    // Input is contained in a label or label is contained in input
    for (const [label, key] of Object.entries(labelMap)) {
        if (label.includes(norm) || norm.includes(label)) return key;
    }
    return null;
}

function buildMenuText(cfg) {
    const name    = cfg.businessName || 'My Business';
    const r       = cfg.responses || {};
    const divider = '';
    const emoji   = { '1':'1️⃣', '2':'2️⃣', '3':'3️⃣', '4':'4️⃣', '5':'5️⃣', '6':'6️⃣', '0':'0️⃣' };
    const lines = OPTION_KEYS.filter(k => r[k]).map(k => {
        const label = r[k].split('\n')[0].replace(/\*/g, '').trim();
        return `${emoji[k]} ${label.slice(0, 60)}`;
    });
    return [
        `🏪 Hello! Welcome to *${name}*`,
        divider,
        '🙋 *How can we help you today?*',
        '',
        ...lines,
        '',
        divider,
        '👆 *Reply with a number* to choose an option',
        '_Type *00* anytime to see this menu again_'
    ].join('\n');
}

/** Send a one-time welcome message with discount code to a brand-new customer */
async function sendWelcome(client, from, newCust, cfg) {
    if (!newCust || newCust.welcomeSent) return;
    const name    = newCust.name ? `*${newCust.name}*` : 'there';
    const bizName = cfg.businessName || 'our store';
    trackBotMessage(await client.sendMessage(from,
        `🎉 *Welcome to ${bizName}!*\n\n` +
        `Hi ${name}! We're so glad you reached out. 😊\n\n` +
        `🎁 *Your exclusive first-time gift:*\n` +
        `Discount Code: *${newCust.discountCode}*\n\n` +
        `Mention this code when placing your order for a special discount!\n` +
        `Here's our menu to get you started 👇`
    ));
    markWelcomeSent(from);
}

async function handleAutoReply(client, msg) {
    const from = msg.from;
    botReplying.add(from);
    try {
        const cfg = loadConfig();
        if (!cfg.enabled) return false;

        // ── Record / touch customer ───────────────────────────────────────────
        let contactName  = '';
        let newCustomer  = null; // set for first-time customers
        try {
            const contact = await msg.getContact();
            contactName   = contact.pushname || contact.name || '';
            newCustomer   = recordCustomer(from, contactName); // returns obj if new, null if existing
            touchCustomer(from);
        } catch (e) { /* non-fatal */ }
        // ─────────────────────────────────────────────────────────────────────

        // ── Agent mode: stay silent unless user sends a command, or 8hrs expire ──
        if (agentMode.has(from)) {
            const bodyRawCheck = (msg.body || '').trim();
            const bodyLowCheck = bodyRawCheck.toLowerCase();
            const elapsed = Date.now() - agentMode.get(from);

            if (elapsed >= AGENT_MODE_TIMEOUT_MS) {
                // 8 hours of inactivity — release
                agentMode.delete(from);
                saveAgentMode();
                removeFromQueue(from);
                console.log('[AGENT] Expired (8hr inactivity) for ' + from);
                // fall through to normal handling
            } else if (KEYWORDS[bodyLowCheck] || KEYWORDS[bodyRawCheck] || matchLabel(bodyRawCheck, buildLabelMap(cfg))) {
                // User deliberately sent a bot command — release agent mode
                agentMode.delete(from);
                saveAgentMode();
                removeFromQueue(from);
                console.log('[AGENT] OFF — user sent command for ' + from);
                // fall through to normal handling
            } else {
                // Active agent conversation — stay silent
                console.log('[AGENT] Silent (agent mode active) for ' + from);
                return true;
            }
        }
        // ─────────────────────────────────────────────────────────────────

        const bodyRaw = (msg.body || '').trim();
        const bodyLow = bodyRaw.toLowerCase();

        if (!bodyRaw) return false;

        // Resolve the menu key early so we can decide whether to bypass hours checks.
        // Any recognised command (numbers, keywords, label text) bypasses hours/OOO
        // so customers can still browse the menu and get replies at any time.
        const _labelMap    = buildLabelMap(cfg);
        const _resolvedKey = KEYWORDS[bodyLow] || KEYWORDS[bodyRaw] || matchLabel(bodyRaw, _labelMap);
        const isBypassCmd  = !!_resolvedKey;

        // ── Out of Office check (overrides working hours) ─────────────────────
        if (isOOO() && !isBypassCmd) {
            if (!menuShown.has(from)) {
                trackBotMessage(await client.sendMessage(from, getOOOMessage()));
                menuShown.add(from);
                console.log('[OOO] Message sent to ' + from);
            }
            return true;
        }
        // ─────────────────────────────────────────────────────────────────────
        if (!isOpenNow() && !isBypassCmd) {
            // Only send closed message once per session to avoid spamming
            if (!menuShown.has(from)) {
                trackBotMessage(await client.sendMessage(from, closedMessage()));
                menuShown.add(from);
                console.log('[AUTO-REPLY] Closed-hours message sent to ' + from);
            }
            return true;
        }
        // ─────────────────────────────────────────────────────────────────────
        if (paymentSubMenu.has(from)) {
            paymentSubMenu.delete(from);
            const imgDir  = path.join(__dirname, '..', 'images');
            const exitHint = '\n\n_Enter *10* to exit_';

            if (bodyLow === '1' || bodyLow.includes('order')) {
                try {
                    const media = MessageMedia.fromFilePath(path.join(imgDir, 'pay.png'));
                    trackBotMessage(await client.sendMessage(from, media, { caption: '💳 *Pay for Order*\n\nAfter payment, please submit your screenshot.' + exitHint }));
                } catch (e) {
                    trackBotMessage(await client.sendMessage(from, '💳 *Pay for Order*\n\nPlease send payment to our account.\n\nAfter payment, please submit your screenshot.' + exitHint));
                }
                return true;
            }

            if (bodyLow === '2' || bodyLow.includes('ship')) {
                try {
                    const media = MessageMedia.fromFilePath(path.join(imgDir, 'ship.png'));
                    trackBotMessage(await client.sendMessage(from, media, { caption: '🚚 *Pay for Shipping*\n\nAfter payment, please submit your screenshot.' + exitHint }));
                } catch (e) {
                    trackBotMessage(await client.sendMessage(from, '🚚 *Pay for Shipping*\n\nPlease send payment to our shipping account.\n\nAfter payment, please submit your screenshot.' + exitHint));
                }
                return true;
            }

            // didn't pick a valid payment option — re-show payment sub-menu
            paymentSubMenu.add(from);
            trackBotMessage(await client.sendMessage(from, cfg.responses['6'] || '💳 *Make Payment*\n\n1️⃣ Pay for Order\n2️⃣ Pay for Shipping'));
            return true;
        }
        // ─────────────────────────────────────────────────────────────────

        const key = _resolvedKey;

        if (key === 'exit') {
            paymentSubMenu.delete(from);
            menuShown.delete(from);
            trackBotMessage(await client.sendMessage(from,
                '🙏 *Thank you for your service!*\n\n' +
                'Enter *0* to connect with an agent\n' +
                'Enter *00* to go back to menu'
            ));
            console.log('[AUTO-REPLY] Exit sent to ' + from);
            return true;
        }

        if (key === 'menu') {
            paymentSubMenu.delete(from);
            if (newCustomer && !newCustomer.welcomeSent) {
                await sendWelcome(client, from, newCustomer, cfg);
            }
            trackBotMessage(await client.sendMessage(from, buildMenuText(cfg)));
            menuShown.add(from);
            console.log('[AUTO-REPLY] Menu sent to ' + from);
            return true;
        }

        if (key && cfg.responses[key]) {
            if (key === '0') {
                agentMode.set(from, Date.now());
                saveAgentMode();
                console.log('[AGENT] ON for ' + from);
                // Notify the agent (bot owner) and add to the queue
                try {
                    const ownerJid = client.info.wid._serialized;
                    const disp     = contactName || from.split('@')[0];
                    const notif    =
                        `🔔 *New Agent Request*\n\n` +
                        `👤 Client: *${disp}*\n` +
                        `📞 Number: +${from.split('@')[0]}\n` +
                        `🕐 Time: ${new Date().toLocaleString()}\n\n` +
                        `_The bot is now silent for this conversation._`;
                    trackBotMessage(await client.sendMessage(ownerJid, notif));
                    addToQueue(from, disp);
                } catch (e) { console.error('[AGENT] Notify error:', e.message); }
            }
            trackBotMessage(await client.sendMessage(from, cfg.responses[key]));
            menuShown.add(from);
            if (key === '6') paymentSubMenu.add(from);
            console.log('[AUTO-REPLY] Replied "' + key + '" to ' + from);
            return true;
        }

        // Unrecognised message — show menu on first contact, nudge after that
        if (!menuShown.has(from)) {
            if (newCustomer && !newCustomer.welcomeSent) {
                await sendWelcome(client, from, newCustomer, cfg);
            }
            trackBotMessage(await client.sendMessage(from, buildMenuText(cfg)));
            menuShown.add(from);
            console.log('[AUTO-REPLY] Menu sent to ' + from);
        } else {
            trackBotMessage(await client.sendMessage(from,
                '*Not sure what to look for?*\n\n' +
                'Talk with an agent directly:\n' +
                'Enter *0* to connect with an agent\n' +
                'Enter *00* for the menu.'
            ));
            console.log('[AUTO-REPLY] Nudge sent to ' + from);
        }
        return true;

    } catch (err) {
        console.error('[AUTO-REPLY] Error:', err.message);
        return false;
    } finally {
        botReplying.delete(from);
    }
}

/**
 * Called from message_create when YOU send a message to a contact.
 * - If the message ID was sent by the bot automatically → ignore it.
 * - Otherwise → you are the agent. Turn ON agent mode (or reset the 8hr
 *   timer if already on) so the bot stays silent for that conversation.
 */
function agentSentMessage(msgId, contactId) {
    // Ignore events fired while the bot is in the middle of auto-replying
    // (message_create races ahead of sendMessage's resolved promise)
    if (botReplying.has(contactId)) return false;

    // Ignore bot's own auto-sent messages
    if (msgId && botSentIds.has(msgId)) {
        botSentIds.delete(msgId); // consume
        return false;
    }

    // Agent manually sent a message — activate / refresh agent mode
    agentMode.set(contactId, Date.now());
    saveAgentMode();
    console.log('[AGENT] ON / timer reset (agent messaged) for ' + contactId);
    return true;
}

/**
 * Release a contact from agent mode and remove from the dashboard queue.
 * Called when the agent clicks "Release" in the dashboard.
 */
function releaseContact(contactId) {
    agentMode.delete(contactId);
    saveAgentMode();
    removeFromQueue(contactId);
    console.log('[AGENT] Released from dashboard for ' + contactId);
}

module.exports = { handleAutoReply, agentSentMessage, releaseContact };

