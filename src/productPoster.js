/**
 * Product Feed Poster
 *
 * Sends daily product listings to a WhatsApp group.
 * Each post = product image + caption (name, price, MOQ, order list of Ghanaian names).
 *
 * Config:  config/productfeed.json
 * Products: config/products.json  (filled by productScraper.js)
 * Posted log: config/productfeed_posted.json (tracks which IDs already sent)
 */

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const { MessageMedia } = require('whatsapp-web.js');
const { getAllCachedProducts } = require('./productScraper');

const FEED_FILE   = path.join(__dirname, '..', 'config', 'productfeed.json');
const POSTED_FILE = path.join(__dirname, '..', 'config', 'productfeed_posted.json');

const DEFAULTS = {
    enabled:         false,
    groupId:         '',
    groupName:       '',
    startHour:       8,
    startMinute:     0,
    postsPerDay:     12,
    intervalMinutes: 2,
    namesPerPost:    6,
    autoScrapeDaily: true,   // re-scrape Alibaba once a week (Sunday midnight)
};

// ── Ghanaian names pool ───────────────────────────────────────────────────────
const NAMES_POOL = [
    'Akosua Mensah',    'Kwame Boateng',    'Abena Owusu',      'Kofi Asante',
    'Yaa Appiah',       'Kweku Darko',      'Ama Osei',         'Kojo Frimpong',
    'Adwoa Antwi',      'Yaw Acheampong',   'Akua Nkrumah',     'Fiifi Quaye',
    'Efua Tetteh',      'Nana Adjei',       'Serwaa Lartey',    'Kwabena Ntim',
    'Maame Sarkodie',   'Nii Ankrah',       'Esi Djan',         'Kwasi Opoku',
    'Adjoa Kyei',       'Kofi Adepa',       'Akosua Asamoah',   'Kweku Bonsu',
    'Abena Poku',       'Yaw Gyamfi',       'Ama Afriyie',      'Kojo Nimako',
    'Adwoa Baffour',    'Nana Adu',         'Kwame Takyi',      'Afua Owusu',
    'Kwesi Kumi',       'Akua Twum',        'Yaa Fordjour',     'Kofi Amponsah',
    'Abena Sarpong',    'Kweku Manu',       'Maame Dankwah',    'Kojo Aseidu',
    'Akosua Peprah',    'Kwame Asubonteng', 'Ama Brempong',     'Yaw Adusei',
    'Adjoa Quansah',    'Fiifi Asumadu',    'Serwaa Addae',     'Nana Atta',
    'Esi Opam',         'Kwabena Awuah',    'Akua Gyan',        'Kofi Domfeh',
    'Abena Ohene',      'Kwesi Attah',      'Efua Asante',      'Akosua Donkor',
    'Kwame Ofori',      'Yaa Nyarko',       'Kojo Asomaning',   'Nana Aba',
    'Kweku Boakye',     'Adwoa Sefah',      'Yaw Anokye',       'Ama Wiredu',
    'Kofi Prempeh',     'Abena Larbi',      'Akosua Barimah',   'Kwame Yeboah',
    'Adjoa Ampem',      'Nana Okyere',      'Kwesi Otchere',    'Ama Dwamena',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Price conversion ─────────────────────────────────────────────────────────
/**
 * Parse a MIC USD price string, divide by 2, and return formatted Ghana Cedis.
 * e.g. "US$200.00-600.00 / Piece" → "₵100.00 – ₵300.00"
 *      "US$50.00"                  → "₵25.00"
 */
function convertToGhsCedis(priceStr) {
    if (!priceStr || priceStr === 'Contact supplier') return priceStr || 'Contact supplier';
    const match = priceStr.match(/US\$\s*([\d,.]+)(?:\s*[-\u2013]\s*([\d,.]+))?/);
    if (!match) return priceStr;
    const parseNum = s => parseFloat(s.replace(/,/g, ''));
    const lo = parseNum(match[1]) / 2;
    const hi = match[2] ? parseNum(match[2]) / 2 : null;
    const fmt = n => '\u20B5' + n.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return hi ? `${fmt(lo)} \u2013 ${fmt(hi)}` : fmt(lo);
}

// ── Config helpers ────────────────────────────────────────────────────────────
function loadFeedConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')) }; }
    catch (_) { return { ...DEFAULTS }; }
}

function saveFeedConfig(data) {
    try { fs.writeFileSync(FEED_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('[FEED] Config save failed:', e.message); }
}

// ── Posted log ────────────────────────────────────────────────────────────────
function loadPosted() {
    try { return JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8')); }
    catch (_) { return { ids: [] }; }
}

function markPosted(id) {
    const d = loadPosted();
    d.ids = [id, ...d.ids].slice(0, 3000); // rolling window of 3000
    try { fs.writeFileSync(POSTED_FILE, JSON.stringify(d, null, 2)); }
    catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Build the WhatsApp caption for a product post.
 * Includes product info + randomised order list with some names marked ✅ paid.
 */
function buildCaption(product, cfg) {
    const count     = Math.max(2, cfg.namesPerPost || 6);
    const names     = shuffle(NAMES_POOL).slice(0, count);
    // Randomly mark 1 to ~half the names as paid
    const paidCount = Math.max(1, Math.floor(Math.random() * Math.ceil(count / 2)));
    const paidSet   = new Set(shuffle([...names]).slice(0, paidCount));

    const orderLines = names.map((name, i) =>
        `${i + 1}. ${name}${paidSet.has(name) ? ' ✅' : ''}`
    ).join('\n');

    const ghsPrice = convertToGhsCedis(product.price);

    const lines = [
        `🛍️ *${product.title}*`,
        ``,
        `💰 *Price:* ${ghsPrice}`,
        `📦 *MOQ:* ${product.minOrder}`,
        ``,
        `📋 *Current Order List:*`,
        orderLines,
        ``,
        `_Reply with your name to join this order!_`,
    ];

    return lines.join('\n');
}

// ── Feed runner ───────────────────────────────────────────────────────────────
/**
 * Execute one full daily feed session.
 * Picks up to `postsPerDay` un-posted products from cache, sends them to the group.
 */
async function runDailyFeed(client, emitFn) {
    const cfg = loadFeedConfig();
    if (!cfg.enabled)  { console.log('[FEED] Disabled — skipping run.'); return; }
    if (!cfg.groupId)  { console.log('[FEED] No group set — skipping run.'); return; }

    const posted = loadPosted();
    const all    = getAllCachedProducts().filter(p => !posted.ids.includes(p.id));

    if (all.length === 0) {
        console.log('[FEED] No un-posted products available. Trigger a scrape first.');
        if (emitFn) emitFn('feed-status', { message: '⚠️ No products in cache. Please run Refresh Cache.' });
        return;
    }

    const toPost     = shuffle(all).slice(0, cfg.postsPerDay);
    const intervalMs = Math.max(30000, (cfg.intervalMinutes || 2) * 60 * 1000);

    console.log(`[FEED] Starting: ${toPost.length} posts → group "${cfg.groupName || cfg.groupId}"`);
    if (emitFn) emitFn('feed-status', { message: `🚀 Daily feed started — ${toPost.length} products to post.` });

    for (let i = 0; i < toPost.length; i++) {
        const product = toPost[i];
        try {
            let media = null;
            if (product.imageUrl) {
                try {
                    media = await MessageMedia.fromUrl(product.imageUrl, {
                        unsafeMime: true,
                        reqOptions: {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Referer':    'https://www.made-in-china.com/',
                            },
                        },
                    });
                } catch (imgErr) {
                    console.warn(`[FEED] Image load failed: ${imgErr.message} — posting text only`);
                }
            }

            const caption = buildCaption(product, cfg);
            const chat    = await client.getChatById(cfg.groupId);

            if (media) {
                await chat.sendMessage(media, { caption });
            } else {
                await chat.sendMessage(caption);
            }

            markPosted(product.id);
            console.log(`[FEED] ✓ ${i + 1}/${toPost.length}: ${product.title.slice(0, 50)}`);
            if (emitFn) emitFn('feed-progress', { done: i + 1, total: toPost.length });

            if (i < toPost.length - 1) await sleep(intervalMs);
        } catch (e) {
            console.error(`[FEED] Post failed for "${product.title}": ${e.message}`);
        }
    }

    console.log('[FEED] Daily feed complete.');
    if (emitFn) emitFn('feed-status', { message: '✅ Daily feed complete!' });
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
let _cronJob = null;

function startProductFeedScheduler(client, emitFn) {
    if (_cronJob) { _cronJob.stop(); _cronJob = null; }

    // Check every minute if it's time to run
    _cronJob = cron.schedule('* * * * *', () => {
        const cfg = loadFeedConfig();
        if (!cfg.enabled) return;
        const now = new Date();
        if (now.getHours() === Number(cfg.startHour) && now.getMinutes() === Number(cfg.startMinute)) {
            runDailyFeed(client, emitFn).catch(e => console.error('[FEED] Error:', e.message));

            // Auto-scrape weekly: runs once a week on Sunday at midnight
            if (cfg.autoScrapeDaily && now.getDay() === 0 && now.getHours() === 0 && now.getMinutes() === 0) {
                const { refreshProductCache } = require('./productScraper');
                refreshProductCache().catch(e => console.error('[SCRAPER] Auto-refresh error:', e.message));
            }
        }
    });

    console.log('[FEED] Product feed scheduler started.');
}

module.exports = { startProductFeedScheduler, runDailyFeed, loadFeedConfig, saveFeedConfig };
