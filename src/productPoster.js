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

const fs    = require('fs');
const path  = require('path');
const cron  = require('node-cron');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const { getAllCachedProducts } = require('./productScraper');

// Use DATA_DIR so files survive Railway redeploys (persistent volume at /app/data).
// Falls back to project root for local dev.
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '..');
const CONFIG_DIR  = path.join(DATA_DIR, 'config');
const FEED_FILE   = path.join(CONFIG_DIR, 'productfeed.json');
const POSTED_FILE = path.join(CONFIG_DIR, 'productfeed_posted.json');

const DEFAULTS = {
    enabled:         false,
    groupId:         '',
    groupName:       '',
    startHour:       8,
    startMinute:     0,
    postsPerDay:     12,
    intervalMinutes: 2,
    namesPerPost:    5,
    autoScrapeDaily: true,   // re-scrape shop once a week (Sunday midnight)
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



// ── Config helpers ────────────────────────────────────────────────────────────
function loadFeedConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')) }; }
    catch (_) { return { ...DEFAULTS }; }
}

function saveFeedConfig(data) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(FEED_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[FEED] Config save failed:', e.message); }
}

// ── Posted log ────────────────────────────────────────────────────────────────
/** Normalise a title for deduplication: lowercase, collapse whitespace, strip punctuation */
function normalizeTitle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function loadPosted() {
    try {
        const d = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8'));
        // back-compat: ensure titles array exists
        if (!d.titles) d.titles = [];
        return d;
    } catch (_) { return { ids: [], titles: [] }; }
}

function clearPosted() {
    try { fs.writeFileSync(POSTED_FILE, JSON.stringify({ ids: [], titles: [] }, null, 2)); }
    catch (_) {}
}

function markPosted(id, title) {
    const d = loadPosted();
    d.ids    = [id,                   ...d.ids   ].slice(0, 5000);
    d.titles = [normalizeTitle(title), ...d.titles].slice(0, 5000);
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
 *
 * Shows a fixed number of order slots (namesPerPost).
 * Some slots are filled with random Ghanaian names (a few marked ✅ paid),
 * the remaining slots are left empty (e.g. "4.") to invite new orders.
 */
function buildCaption(product, cfg) {
    const totalSlots  = Math.max(3, cfg.namesPerPost || 5);

    // Fill 1 to (totalSlots - 1) slots, leaving at least one empty
    const filledCount = Math.floor(Math.random() * (totalSlots - 1)) + 1;
    const names       = shuffle(NAMES_POOL).slice(0, filledCount);
    const paidCount   = Math.max(1, Math.floor(Math.random() * Math.ceil(filledCount / 2)));
    const paidSet     = new Set(shuffle([...names]).slice(0, paidCount));

    const orderLines = [];
    for (let i = 1; i <= totalSlots; i++) {
        const name = names[i - 1]; // undefined for empty slots
        orderLines.push(name ? `${i}. ${name}${paidSet.has(name) ? ' ✅' : ''}` : `${i}.`);
    }

    // Price comes directly from the site (GH₵XX.XX) — strip the "GH" prefix to show ₵XX.XX
    const displayPrice = (product.price || 'Contact seller').replace(/^GH/, '');

    const lines = [
        `🛍️ *${product.title}*`,
        ``,
        `💰 Price: ${displayPrice}`,
        `📦 MOQ: ${product.minOrder}`,
        ``,
        `📋 *Current Order List:*`,
        ...orderLines,
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

    let posted    = loadPosted();
    const cache    = getAllCachedProducts();

    if (cache.length === 0) {
        console.log('[FEED] No products in cache. Trigger a scrape first.');
        if (emitFn) emitFn('feed-status', { message: '⚠️ No products in cache. Please run Refresh Cache.' });
        return;
    }

    // Filter out already-posted products by BOTH id AND normalised title
    let all = cache.filter(p =>
        !posted.ids.includes(p.id) &&
        !posted.titles.includes(normalizeTitle(p.title))
    );

    // When every product in the cache has been posted, reset and cycle through again
    if (all.length === 0) {
        console.log('[FEED] All products have been posted — resetting cycle and starting fresh.');
        if (emitFn) emitFn('feed-status', { message: '🔄 All products cycled. Starting fresh round.' });
        clearPosted();
        posted = loadPosted();
        all    = [...cache];
    }

    const toPost     = shuffle(all).slice(0, cfg.postsPerDay);
    const intervalMs = Math.max(30000, (cfg.intervalMinutes || 2) * 60 * 1000);

    console.log(`[FEED] Starting: ${toPost.length} posts → group "${cfg.groupName || cfg.groupId}"`);
    if (emitFn) emitFn('feed-status', { message: `🚀 Daily feed started — ${toPost.length} products to post.` });

    for (let i = 0; i < toPost.length; i++) {
        const product = toPost[i];
        try {
            // Fetch image server-side with axios and pass base64 directly to WhatsApp.
            // Using MessageMedia.fromUrl() makes Puppeteer download the image internally
            // which often produces 'Waiting for this message…' that never resolves.
            let media = null;
            if (product.imageUrl) {
                try {
                    const imgRes = await axios.get(product.imageUrl, {
                        responseType: 'arraybuffer',
                        timeout:      15000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Referer':    'https://jd-fx-imports.vercel.app/',
                        },
                    });
                    const mime   = imgRes.headers['content-type'] || 'image/jpeg';
                    const b64    = Buffer.from(imgRes.data).toString('base64');
                    media = new MessageMedia(mime.split(';')[0].trim(), b64);
                } catch (imgErr) {
                    console.warn(`[FEED] Image fetch failed: ${imgErr.message} — posting text only`);
                }
            }

            const caption = buildCaption(product, cfg);
            const chat    = await client.getChatById(cfg.groupId);

            if (media) {
                await chat.sendMessage(media, { caption });
            } else {
                await chat.sendMessage(caption);
            }

            markPosted(product.id, product.title);
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

    // Check every minute.
    // Uses a "ran today" flag so:
    //   - It fires reliably even if the bot restarts AFTER the scheduled minute.
    //   - It never double-fires within the same calendar day.
    _cronJob = cron.schedule('* * * * *', () => {
        const cfg = loadFeedConfig();
        if (!cfg.enabled) return;

        const now      = new Date();
        const todayStr = now.toDateString();                 // e.g. "Thu Feb 26 2026"
        const startH   = Number(cfg.startHour);
        const startM   = Number(cfg.startMinute);
        const nowH     = now.getHours();
        const nowM     = now.getMinutes();

        // True once the configured time has been reached today
        const timeReached = nowH > startH || (nowH === startH && nowM >= startM);

        if (timeReached && cfg.lastRunDate !== todayStr) {
            // Stamp BEFORE running so a crash/restart mid-feed doesn't re-trigger
            saveFeedConfig({ ...cfg, lastRunDate: todayStr });
            console.log(`[FEED] Scheduled run triggered at ${nowH}:${String(nowM).padStart(2,'0')} (target ${startH}:${String(startM).padStart(2,'0')})`);
            runDailyFeed(client, emitFn).catch(e => console.error('[FEED] Error:', e.message));

            // Auto-scrape weekly: Sunday midnight
            if (cfg.autoScrapeDaily && now.getDay() === 0 && nowH === 0) {
                const { refreshProductCache } = require('./productScraper');
                refreshProductCache().catch(e => console.error('[SCRAPER] Auto-refresh error:', e.message));
            }
        }
    });

    console.log('[FEED] Product feed scheduler started.');
}

module.exports = { startProductFeedScheduler, runDailyFeed, loadFeedConfig, saveFeedConfig };
