/**
 * Product Scraper — Alibaba search scraper
 *
 * Fetches products from alibaba.com using keyword searches per category.
 * Results are cached in config/products.json.
 * No second browser needed — uses axios + cheerio (plain HTTP).
 *
 * NOTE: Alibaba frequently changes their HTML class names. This scraper
 * tries multiple selector patterns and JSON-LD fallback. If a scrape
 * returns 0 results for a keyword it will log a warning but continue.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');

// Max products to keep per keyword search
const MAX_PER_KW = 6;

// Polite delay between requests (ms) — Alibaba rate-limits aggressively
const REQ_DELAY_MIN = 4000;
const REQ_DELAY_MAX = 7000;

// ── Category → keyword map ────────────────────────────────────────────────────
// Each keyword becomes one search query. Rotate through them for variety.
const CATEGORY_KEYWORDS = [
    // Apparel & Accessories
    'ankara fabric wholesale',
    'african print fabric bulk',
    'ladies fashion tops wholesale',
    'men casual shirts bulk',
    // Jewelry, Eyewear, Watches & Accessories
    'fashion jewelry wholesale',
    'ladies wristwatch bulk order',
    'sunglasses wholesale',
    // Beauty & Personal Care
    'human hair wigs wholesale',
    'skin cream beauty products wholesale',
    'cosmetics makeup wholesale',
    // Consumer Electronics
    'smartphone accessories wholesale',
    'wireless earbuds bulk order',
    'power bank wholesale',
    // Home & Garden
    'kitchen utensils wholesale',
    'household cleaning products bulk',
    'bedding sets wholesale',
    // Luggage, Bags & Cases
    'ladies handbags wholesale',
    'backpack bags bulk order',
    // Sports & Entertainment
    'sports equipment wholesale',
    'fitness accessories bulk',
    // Shoes & Accessories
    'ladies shoes wholesale',
    'sneakers bulk order',
    // Fabric & Textile Raw Material
    'lace fabric wholesale',
    'printed cotton fabric bulk',
    // Gifts & Crafts
    'gift items wholesale',
    'souvenir crafts bulk',
    // Home Appliances
    'small home appliances wholesale',
    'electric fan bulk order',
    // Mother, Kids & Toys
    'children toys wholesale',
    'baby products bulk order',
    // Personal Care & Household Cleaning
    'hair care products wholesale',
    'beauty tools bulk order',
    // Food & Beverage
    'food packaging wholesale',
    // Furniture
    'furniture accessories wholesale',
    // Tools & Hardware
    'hand tools wholesale',
    // School & Office Supplies
    'stationery wholesale',
    'school bags bulk order',
    // Electrical Equipment
    'led lights wholesale',
    'electrical accessories bulk',
    // Medical Devices & Supplies
    'face masks wholesale',
    'medical gloves bulk',
    // Pet Supplies
    'pet accessories wholesale',
    // Security Products
    'cctv cameras wholesale',
    // Vehicle Parts
    'car accessories wholesale',
];

// ── HTTP headers that mimic a real browser ───────────────────────────────────
const HEADERS = {
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-CH-UA':                 '"Not A(Brand";v="99", "Google Chrome";v="121"',
    'Sec-CH-UA-Mobile':          '?0',
    'Sec-CH-UA-Platform':        '"Windows"',
    'Cache-Control':             'max-age=0',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Cache helpers ─────────────────────────────────────────────────────────────
function loadCache() {
    try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
    catch (_) { return { lastUpdated: null, totalScraped: 0, products: [] }; }
}

function saveCache(data) {
    try {
        const dir = path.dirname(PRODUCTS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[SCRAPER] Save failed:', e.message); }
}

function getAllCachedProducts() {
    return loadCache().products || [];
}

// ── Text helpers ──────────────────────────────────────────────────────────────
function cleanText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

function extractImageUrl($el, $) {
    const img = $el.find('img').first();
    // Images are often lazy-loaded — check data-src before src
    const url = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src') || '';
    // Filter out obvious non-product images (1px trackers, SVG placeholders, base64)
    if (!url || url.startsWith('data:') || url.length < 30) return '';
    // Normalise protocol-relative URLs
    return url.startsWith('//') ? 'https:' + url : url;
}

// ── Core scraper ──────────────────────────────────────────────────────────────
/**
 * Scrape one Alibaba search keyword.
 * Returns array of product objects.
 */
async function scrapeKeyword(keyword) {
    const searchUrl = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(keyword)}&IndexArea=product_en&viewtype=G&page=1`;
    let html;
    try {
        const resp = await axios.get(searchUrl, {
            headers: HEADERS,
            timeout: 20000,
            maxRedirects: 3,
            // axios auto-decompresses gzip/br
        });
        html = resp.data;
    } catch (e) {
        console.warn(`[SCRAPER] HTTP error for "${keyword}": ${e.message}`);
        return [];
    }

    const $ = cheerio.load(html);
    const products = [];

    // ── Attempt 1: Modern product card selectors ──────────────────────────────
    // Alibaba uses various class patterns — try them all
    const cardSelectors = [
        '.organic-gallery-offer-outter',
        '.J-offer-wrapper',
        '[data-content="main-product-list"] > div',
        '.list-no-v2-outter',
        '.offer-list-items .item',
        '.product-item',
    ];

    for (const sel of cardSelectors) {
        if (products.length >= MAX_PER_KW) break;
        $(sel).each((i, el) => {
            if (products.length >= MAX_PER_KW) return false;
            const $el = $(el);

            const title = cleanText(
                $el.find('[class*="title"]').first().text() ||
                $el.find('h2, h3, h4').first().text()
            );
            if (!title || title.length < 5) return;

            const priceRaw = cleanText($el.find('[class*="price"]').first().text());
            const moqRaw   = cleanText(
                $el.find('[class*="min-order"], [class*="moq"], [class*="minorder"]').first().text()
            );
            const imageUrl = extractImageUrl($el, $);
            const href     = $el.find('a[href]').first().attr('href') || '';
            const absUrl   = href.startsWith('http') ? href : href ? `https://www.alibaba.com${href}` : '';

            products.push({
                id:         `kw-${Date.now().toString(36)}-${i}`,
                title:      title.slice(0, 130),
                price:      priceRaw.slice(0, 80) || 'Contact supplier',
                minOrder:   moqRaw.slice(0, 60)  || 'MOQ negotiable',
                imageUrl,
                category:   keyword,
                productUrl: absUrl,
                scrapedAt:  new Date().toISOString(),
            });
        });
        if (products.length > 0) break; // selector worked, stop trying others
    }

    // ── Attempt 2: JSON-LD structured data in <script> tags ──────────────────
    if (products.length === 0) {
        $('script[type="application/ld+json"]').each((i, el) => {
            if (products.length >= MAX_PER_KW) return false;
            try {
                const raw  = $(el).html() || '';
                const data = JSON.parse(raw);
                const items = Array.isArray(data) ? data
                    : data['@graph'] ? data['@graph']
                    : [data];
                for (const item of items) {
                    if (products.length >= MAX_PER_KW) break;
                    if (item['@type'] !== 'Product') continue;
                    const img = Array.isArray(item.image) ? item.image[0] : (item.image || '');
                    products.push({
                        id:         `ld-${Date.now().toString(36)}-${i}`,
                        title:      cleanText(item.name || '').slice(0, 130),
                        price:      item.offers?.price ? `$${item.offers.price} / pc` : 'Contact supplier',
                        minOrder:   'MOQ negotiable',
                        imageUrl:   typeof img === 'string' ? img : '',
                        category:   keyword,
                        productUrl: item.url || '',
                        scrapedAt:  new Date().toISOString(),
                    });
                }
            } catch (_) {}
        });
    }

    console.log(`[SCRAPER] "${keyword}" → ${products.length} product(s)`);
    return products;
}

// ── Public: full cache refresh ─────────────────────────────────────────────────
/**
 * Scrapes all category keywords and updates the products cache.
 * @param  {Function} progressCb  (done, total, keyword, count) — optional
 * @returns {Object} updated cache object
 */
async function refreshProductCache(progressCb) {
    console.log('[SCRAPER] Starting full product cache refresh…');
    const newProducts = [];
    let done = 0;

    for (const keyword of CATEGORY_KEYWORDS) {
        const batch = await scrapeKeyword(keyword);
        newProducts.push(...batch);
        done++;
        if (progressCb) progressCb(done, CATEGORY_KEYWORDS.length, keyword, batch.length);
        // Polite delay — avoid Alibaba rate-limit / CAPTCHA
        const delay = REQ_DELAY_MIN + Math.random() * (REQ_DELAY_MAX - REQ_DELAY_MIN);
        await sleep(delay);
    }

    // Keep up to 1000 products total; merge new with any that survived
    const combined = newProducts.slice(0, 1000);

    const cache = {
        lastUpdated:  new Date().toISOString(),
        totalScraped: newProducts.length,
        products:     combined,
    };
    saveCache(cache);
    console.log(`[SCRAPER] Refresh complete — ${combined.length} products cached.`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
