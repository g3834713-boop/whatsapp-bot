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

const CONFIG_PATH        = path.join(__dirname, '..', 'config', 'autoreply.json');
const MESSAGES_PATH      = path.join(__dirname, '..', 'config', 'messages.json');
const AGENT_MODE_FILE    = path.join(__dirname, '..', 'config', 'agentmode.json');
const SETTINGS_PATH      = path.join(__dirname, '..', 'config', 'settings.json');
const QUICKREPLIES_PATH  = path.join(__dirname, '..', 'config', 'quickreplies.json');

function loadQuickReplies() {
    try { return JSON.parse(fs.readFileSync(QUICKREPLIES_PATH, 'utf8')); }
    catch (e) { return []; }
}

const SETTINGS_DEFAULTS = {
    agentTimeoutHours:    8,
    discountCodePrefix:   'WELCOME-',
    legacyPaymentSubItems: [
        { key:'1', label:'💳 Pay for Order',    response:'💳 *Pay for Order*\n\nAfter payment, please submit your screenshot.\n\n_Enter *10* to exit_', image:'pay'  },
        { key:'2', label:'🚚 Pay for Shipping', response:'🚚 *Pay for Shipping*\n\nAfter payment, please submit your screenshot.\n\n_Enter *10* to exit_', image:'ship' },
    ],
    keywords: [],
};

function loadSettings() {
    try {
        return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
    } catch (e) { return SETTINGS_DEFAULTS; }
}

/** Build keyword→key map from settings, merging over numeric item-key pass-throughs */
function loadKeywords() {
    const settings = loadSettings();
    const map = {};
    for (const { word, target } of (settings.keywords || [])) {
        if (word) map[word.toLowerCase().trim()] = target;
    }
    return map;
}

/** Get agent-mode timeout in ms from settings */
function getAgentTimeoutMs() {
    return (loadSettings().agentTimeoutHours || 8) * 60 * 60 * 1000;
}

// Normalise old { responses:{...} } format to new { menuItems:[...] } format
function normalizeConfig(raw) {
    if (raw.menuItems && Array.isArray(raw.menuItems) && raw.menuItems.length) return raw;
    const ORDER = ['1','2','3','4','5','6','0'];
    const legacySubs = loadSettings().legacyPaymentSubItems || [];
    const menuItems = ORDER
        .filter(k => raw.responses && raw.responses[k])
        .map(k => ({
            key:       k,
            label:     (raw.responses[k].split('\n')[0] || '').replace(/\*/g,'').trim(),
            response:  raw.responses[k],
            agentMode: k === '0',
            subItems:  k === '6' ? legacySubs : [],
        }));
    return Object.assign({}, raw, { menuItems });
}

// ── Messages config ───────────────────────────────────────────────────────────
const MSG_DEFAULTS = {
    closed:      '🕐 *We\'re currently closed*\n\n📋 *Our working hours:*\n• Mon – Fri: 8am – 6pm\n• Saturday: 9am – 2pm\n• Sunday: 11am – 4pm\n\n✅ Your message has been received! We\'ll get back to you during any of the hours listed above.\nNext available: *{nextDay}* at *{nextOpen}*\n\n_Type *0* to reach an agent or *00* for menu_',
    menuGreeting:'🏪 Hello! Welcome to *{businessName}*\n\n🙋 *How can we help you today?*',
    menuFooter:  '👆 *Reply with a number* to choose an option\n_Type *00* anytime to see this menu again_',
    exit:        '🙏 *Thank you for your service!*\n\nEnter *0* to connect with an agent\nEnter *00* to go back to menu',
    nudge:       '*Not sure what to look for?*\n\nTalk with an agent directly:\nEnter *0* to connect with an agent\nEnter *00* for the menu.',
    agentNotify: '🔔 *New Agent Request*\n\n👤 Client: *{name}*\n📞 Number: +{number}\n🕐 Time: {time}\n\n_The bot is now silent for this conversation._',
    welcome:     '🎉 *Welcome to {businessName}!*\n\nHi {name}! We\'re so glad you reached out. 😊\n\n🎁 *Your exclusive first-time gift:*\nDiscount Code: *{discountCode}*\n\nMention this code when placing your order for a special discount!\nHere\'s our menu to get you started 👇',
    workHours: {
        '0': { open: 11, close: 16, enabled: true },
        '1': { open: 8,  close: 18, enabled: true },
        '2': { open: 8,  close: 18, enabled: true },
        '3': { open: 8,  close: 18, enabled: true },
        '4': { open: 8,  close: 18, enabled: true },
        '5': { open: 8,  close: 18, enabled: true },
        '6': { open: 9,  close: 14, enabled: true },
    },
};

function loadMessages() {
    try {
        const m = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
        return Object.assign({}, MSG_DEFAULTS, m, {
            workHours: Object.assign({}, MSG_DEFAULTS.workHours, m.workHours || {}),
        });
    } catch (e) { return MSG_DEFAULTS; }
}

/** Replace {placeholder} tokens in a template string */
function fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '{' + k + '}');
}

// Tracks which contacts have already been shown the menu this session
const menuShown = new Set();

// Map: contactId → parent item key (while user is navigating a sub-menu)
const submenuContext = new Map();

// ── Agent mode ────────────────────────────────────────────────────────────────
// Map: contactId → timestamp when agent mode was last refreshed
// Persisted to disk so it survives bot restarts.
// Timeout is read dynamically from config/settings.json (agentTimeoutHours).

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
            if (now - v < getAgentTimeoutMs()) agentMode.set(k, v);
        }
        if (agentMode.size) console.log(`[AUTO-REPLY] Restored ${agentMode.size} agent mode session(s) from disk`);
    } catch (e) { /* file missing on first run — fine */ }
}

loadAgentMode(); // run once at startup

// ── Working hours ─────────────────────────────────────────────────────────────
// Loaded dynamically from config/messages.json so they can be edited in dashboard.

// ── Timezone-aware time helpers ───────────────────────────────────────────────
// Railway servers run UTC. BOT_TIMEZONE env var sets the default, but the
// dashboard can override it via messages.json → timezone field.
function _localParts() {
    const tz  = loadMessages().timezone || process.env.BOT_TIMEZONE || 'UTC';
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
    const msgs = loadMessages();
    // If closed-hours checking is disabled, bot replies 24/7
    if (msgs.closedHoursEnabled === false) return true;
    const { day, hour } = _localParts();
    const wh   = msgs.workHours;
    const slot = wh[String(day)];
    if (!slot || slot.enabled === false) return false;
    return hour >= slot.open && hour < slot.close;
}

function fmtHour(h) {
    if (h === 12) return '12pm';
    if (h === 0)  return '12am';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function closedMessage() {
    const msgs    = loadMessages();
    const wh      = msgs.workHours;
    const { day } = _localParts();
    const days    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    let nextDay = '', nextOpen = '';
    for (let i = 1; i <= 7; i++) {
        const slot = wh[String((day + i) % 7)];
        if (slot && slot.enabled !== false) {
            nextDay  = days[(day + i) % 7];
            nextOpen = fmtHour(slot.open);
            break;
        }
    }
    return fill(msgs.closed, { nextDay, nextOpen });
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
        return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (e) {
        return { enabled: false, businessName: 'My Business', menuItems: [] };
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

// Kept as a static fallback — loadKeywords() overrides with settings.json values at runtime.

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
 * Builds { normalizedLabel → key } from live menuItems config so typing
 * the menu item text (or a close match) returns the right response.
 */
function buildLabelMap(cfg) {
    const map = {};
    (cfg.menuItems || []).forEach(item => {
        const label = normalize(item.label || (item.response || '').split('\n')[0]);
        if (label && item.key) map[label] = item.key;
    });
    return map;
}

/** Returns a response key if the input fuzzy-matches a label, else null */
function matchLabel(input, labelMap) {
    const norm = normalize(input);
    if (!norm) return null;
    if (labelMap[norm]) return labelMap[norm];
    for (const [label, key] of Object.entries(labelMap)) {
        if (label.includes(norm) || norm.includes(label)) return key;
    }
    return null;
}

function buildMenuText(cfg) {
    const msgs  = loadMessages();
    const name  = cfg.businessName || 'My Business';
    const items = cfg.menuItems || [];
    const EMOJI = {'0':'0️⃣','1':'1️⃣','2':'2️⃣','3':'3️⃣','4':'4️⃣','5':'5️⃣','6':'6️⃣','7':'7️⃣','8':'8️⃣','9':'9️⃣'};
    const lines = items.map(item => {
        const icon  = EMOJI[item.key] || `${item.key}.`;
        const label = (item.label || (item.response || '').split('\n')[0]).replace(/\*/g,'').trim();
        return `${icon} ${label.slice(0, 60)}`;
    });
    const greeting = fill(msgs.menuGreeting, { businessName: name });
    return [greeting, '', ...lines, '', msgs.menuFooter].join('\n');
}

/** Send a one-time welcome message with discount code to a brand-new customer */
async function sendWelcome(client, from, newCust, cfg) {
    if (!newCust || newCust.welcomeSent) return;
    const msgs    = loadMessages();
    const bizName = cfg.businessName || 'our store';
    const name    = newCust.name ? `*${newCust.name}*` : 'there';
    trackBotMessage(await client.sendMessage(from,
        fill(msgs.welcome, { businessName: bizName, name, discountCode: newCust.discountCode })
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

        const bodyRaw = (msg.body || '').trim();
        const bodyLow = bodyRaw.toLowerCase();

        if (!bodyRaw) return false;

        // ── 00 = absolute menu override — beats EVERYTHING including agent mode ─
        if (bodyRaw === '00' || bodyLow === '00') {
            agentMode.delete(from);
            saveAgentMode();
            removeFromQueue(from);
            submenuContext.delete(from);
            menuShown.delete(from);
            if (newCustomer && !newCustomer.welcomeSent) {
                await sendWelcome(client, from, newCustomer, cfg);
            }
            trackBotMessage(await client.sendMessage(from, buildMenuText(cfg)));
            menuShown.add(from);
            console.log('[AUTO-REPLY] 00 → Menu (override) sent to ' + from);
            return true;
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── Agent mode: stay silent unless user sends a command, or timeout expires ──
        if (agentMode.has(from)) {
            const elapsed = Date.now() - agentMode.get(from);
            const kw      = loadKeywords();

            // isCmd = true if the message matches any bot keyword (hardcoded OR custom)
            const isCmd = KEYWORDS[bodyLow] || KEYWORDS[bodyRaw]
                || kw[bodyLow] || kw[bodyRaw]
                || matchLabel(bodyRaw, buildLabelMap(cfg));

            if (elapsed >= getAgentTimeoutMs()) {
                // Timeout expired — release
                agentMode.delete(from);
                saveAgentMode();
                removeFromQueue(from);
                console.log('[AGENT] Expired (inactivity) for ' + from);
                // fall through to normal handling
            } else if (isCmd) {
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

        // Resolve the menu key early so we can decide whether to bypass hours checks
        // and whether to skip quick replies (menu commands always take priority).
        // IMPORTANT: check hardcoded KEYWORDS first so hi/hello/menu/1-6 etc. are
        // always recognised even if not added as custom keywords in settings.json.
        const kw           = loadKeywords();
        const _labelMap    = buildLabelMap(cfg);
        const _itemKeys    = new Set((cfg.menuItems || []).map(i => i.key));
        const _resolvedKey = KEYWORDS[bodyLow] || KEYWORDS[bodyRaw]
            || kw[bodyLow] || kw[bodyRaw]
            || (_itemKeys.has(bodyLow) ? bodyLow : null)
            || (_itemKeys.has(bodyRaw) ? bodyRaw : null)
            || matchLabel(bodyRaw, _labelMap);
        const isBypassCmd  = !!_resolvedKey;

        // ── Quick replies: only run when the message is NOT a menu command ─────
        // This ensures 00, 0, 1-9, hi, hello, etc. always reach the menu handler.
        if (!isBypassCmd && !submenuContext.has(from)) {
            const quickRules = loadQuickReplies();
            for (const rule of quickRules) {
                if (!rule.trigger || !rule.response) continue;
                const matchType  = rule.matchType || 'contains';
                const triggerLow = rule.trigger.toLowerCase().trim();
                const hit = matchType === 'exact'
                    ? bodyLow === triggerLow
                    : bodyLow.includes(triggerLow);
                if (hit) {
                    trackBotMessage(await client.sendMessage(from, rule.response));
                    console.log(`[QUICK-REPLY] Rule "${rule.trigger}" matched for ${from}`);
                    return true;
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── Out of Office check (overrides working hours) ─────────────────────
        if (isOOO() && !isBypassCmd) {
            trackBotMessage(await client.sendMessage(from, getOOOMessage()));
            console.log('[OOO] Message sent to ' + from);
            return true;
        }
        // ─────────────────────────────────────────────────────────────────────
        if (!isOpenNow() && !isBypassCmd) {
            // Always tell the customer we're closed so they're never left in silence.
            trackBotMessage(await client.sendMessage(from, closedMessage()));
            menuShown.add(from);
            console.log('[AUTO-REPLY] Closed-hours message sent to ' + from);
            return true;
        }
        // ─────────────────────────────────────────────────────────────────────
        // ── Generic sub-menu handler ───────────────────────────────────────────
        if (submenuContext.has(from)) {
            const parentKey  = submenuContext.get(from);
            const parentItem = (cfg.menuItems || []).find(i => i.key === parentKey);
            if (parentItem && parentItem.subItems && parentItem.subItems.length) {
                const subItem = parentItem.subItems.find(s =>
                    s.key === bodyLow || s.key === bodyRaw ||
                    normalize(s.label || '').includes(normalize(bodyRaw)) ||
                    normalize(bodyRaw).includes(normalize(s.label || ''))
                );
                if (subItem) {
                    submenuContext.delete(from);
                    const imgDir = path.join(__dirname, '..', 'images');
                    if (subItem.image) {
                        const imgFile = path.join(imgDir, subItem.image + '.png');
                        try {
                            const media = MessageMedia.fromFilePath(imgFile);
                            trackBotMessage(await client.sendMessage(from, media, { caption: subItem.response || subItem.label }));
                        } catch (_) {
                            trackBotMessage(await client.sendMessage(from, subItem.response || subItem.label));
                        }
                    } else {
                        trackBotMessage(await client.sendMessage(from, subItem.response || subItem.label));
                    }
                    console.log(`[AUTO-REPLY] Sub-item "${subItem.key}" of "${parentKey}" sent to ${from}`);
                    return true;
                } else {
                    // Invalid selection — re-show parent response
                    trackBotMessage(await client.sendMessage(from, parentItem.response));
                    return true;
                }
            } else {
                submenuContext.delete(from); // parent no longer has subItems
            }
        }
        // ─────────────────────────────────────────────────────────────────

        const key = _resolvedKey;

        if (key === 'exit') {
            submenuContext.delete(from);
            menuShown.delete(from);
            trackBotMessage(await client.sendMessage(from, loadMessages().exit));
            console.log('[AUTO-REPLY] Exit sent to ' + from);
            return true;
        }

        if (key === 'menu') {
            submenuContext.delete(from);
            if (newCustomer && !newCustomer.welcomeSent) {
                await sendWelcome(client, from, newCustomer, cfg);
            }
            trackBotMessage(await client.sendMessage(from, buildMenuText(cfg)));
            menuShown.add(from);
            console.log('[AUTO-REPLY] Menu sent to ' + from);
            return true;
        }

        if (key) {
            const matchedItem = (cfg.menuItems || []).find(i => i.key === key);
            const responseText = matchedItem ? matchedItem.response : null;
            if (responseText) {
                if (matchedItem.agentMode) {
                    agentMode.set(from, Date.now());
                    saveAgentMode();
                    console.log('[AGENT] ON for ' + from);
                    try {
                        const ownerJid = (client.info.wid.user || '') + '@c.us';
                        const disp     = contactName || from.split('@')[0];
                        const notif    = fill(loadMessages().agentNotify, {
                            name:   disp,
                            number: from.split('@')[0],
                            time:   new Date().toLocaleString(),
                        });
                        botReplying.add(ownerJid);
                        try {
                            trackBotMessage(await client.sendMessage(ownerJid, notif));
                        } finally {
                            botReplying.delete(ownerJid);
                        }
                        addToQueue(from, disp);
                    } catch (e) { console.error('[AGENT] Notify error:', e.message); }
                }
                trackBotMessage(await client.sendMessage(from, responseText));
                menuShown.add(from);
                // If this item has sub-items, enter sub-menu context
                if (matchedItem.subItems && matchedItem.subItems.length) {
                    submenuContext.set(from, key);
                }
                console.log('[AUTO-REPLY] Replied "' + key + '" to ' + from);
                return true;
            }
        }

        // If it was a recognised menu command but no item matched (e.g. key with
        // no response configured), always show the menu — never the nudge.
        if (isBypassCmd) {
            submenuContext.delete(from);
            if (newCustomer && !newCustomer.welcomeSent) {
                await sendWelcome(client, from, newCustomer, cfg);
            }
            trackBotMessage(await client.sendMessage(from, buildMenuText(cfg)));
            menuShown.add(from);
            console.log('[AUTO-REPLY] Menu sent (key had no response) to ' + from);
            return true;
        }

        // Truly unrecognised message — show menu on first contact, nudge after that
        if (!menuShown.has(from)) {
            if (newCustomer && !newCustomer.welcomeSent) {
                await sendWelcome(client, from, newCustomer, cfg);
            }
            trackBotMessage(await client.sendMessage(from, buildMenuText(cfg)));
            menuShown.add(from);
            console.log('[AUTO-REPLY] Menu sent to ' + from);
        } else {
            trackBotMessage(await client.sendMessage(from, loadMessages().nudge));
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

