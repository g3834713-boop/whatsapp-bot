/**
 * Product Scraper — made-in-china.com (axios + regex edition)
 *
 * Why axios instead of Puppeteer:
 *   - MIC pages are fully server-side rendered — all product data (title,
 *     price, MOQ, image URL) is present in the raw HTML response.
 *   - Puppeteer + networkidle2 on Railway times out because MIC pages fire
 *     endless background XHRs after load.
 *   - axios is instant, needs no browser process, and works 100% reliably
 *     on Railway's headless environment.
 *
 * No ScraperAPI needed — MIC does not block datacenter IPs.
 */

'use strict';

const axios = require('axios');
const fs        = require('fs');
const path      = require('path');

const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');
const DEBUG_DIR     = path.join(__dirname, '..', 'config', 'scraper-debug');

const MAX_PER_CAT   = 6;
const REQ_DELAY_MIN = 2500;
const REQ_DELAY_MAX = 5000;

// Common browser-like headers so MIC accepts the request.
const REQUEST_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
};

// ---- made-in-china.com categories -------------------------------------------
// primary url: products-search/hot-china-products/{keyword} — SSR page with
//              real product listings (confirmed via live fetch).
// fallbackUrl: a known leaf subcategory catalog page if the primary returns no results.
const CATEGORIES = [
    {
        name:        'Apparel & Accessories',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Apparel.html',
        fallbackUrl: 'https://www.made-in-china.com/Apparel-Accessories-Catalog/T-Shirt.html',
    },
    {
        name:        'Arts & Crafts',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Arts_Crafts.html',
        fallbackUrl: 'https://www.made-in-china.com/Gifts-Crafts-Catalog/Handicraft.html',
    },
    {
        name:        'Auto, Motorcycle Parts & Accessories',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Auto_Parts.html',
        fallbackUrl: 'https://www.made-in-china.com/Auto-Parts-Accessories-Catalog/Auto-Parts.html',
    },
    {
        name:        'Bags, Cases & Boxes',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Bags.html',
        fallbackUrl: 'https://www.made-in-china.com/Bags-Cases-Boxes-Catalog/Handbag.html',
    },
    {
        name:        'Chemicals',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Chemicals.html',
        fallbackUrl: 'https://www.made-in-china.com/Chemicals-Catalog/Industrial-Chemical.html',
    },
    {
        name:        'Computer Products',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Computer_Products.html',
        fallbackUrl: 'https://www.made-in-china.com/Consumer-Electronics-Catalog/Computer-Peripherals.html',
    },
    {
        name:        'Construction & Decoration',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Construction_Material.html',
        fallbackUrl: 'https://www.made-in-china.com/Construction-Real-Estate-Catalog/Building-Material.html',
    },
    {
        name:        'Consumer Electronics',
        url:         'https://www.made-in-china.com/Consumer-Electronics-Catalog/Refrigerator-Freezer-Parts.html',
        fallbackUrl: 'https://www.made-in-china.com/Consumer-Electronics-Catalog/Mobile-Phone.html',
    },
    {
        name:        'Electrical & Electronics',
        url:         'https://www.made-in-china.com/products/catlist/listsubcat/123/00/mic/Electrical_Electronics.html',
        fallbackUrl: 'https://www.made-in-china.com/Electrical-Electronics-Catalog/Electric-Wire-Cable.html',
    },
    {
        name:        'Furniture',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Furniture.html',
        fallbackUrl: 'https://www.made-in-china.com/Furniture-Furnishing-Catalog/Home-Furniture.html',
    },
    {
        name:        'Health & Medicine',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Medical_Equipment.html',
        fallbackUrl: 'https://www.made-in-china.com/Health-Medicine-Catalog/Massager.html',
    },
    {
        name:        'Industrial Equipment & Components',
        url:         'https://www.made-in-china.com/Industrial-Equipment-Components-Catalog/Water-Pump.html',
        fallbackUrl: 'https://www.made-in-china.com/Industrial-Equipment-Components-Catalog/Power-Generating-Sets.html',
    },
    {
        name:        'Instruments & Meters',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Measuring_Instrument.html',
        fallbackUrl: 'https://www.made-in-china.com/Instruments-Meters-Catalog/Measuring-Instrument.html',
    },
    {
        name:        'Light Industry & Daily Use',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Household_Products.html',
        fallbackUrl: 'https://www.made-in-china.com/Light-Industry-Daily-Use-Catalog/Household-Product.html',
    },
    {
        name:        'Lights & Lighting',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/LED_Light.html',
        fallbackUrl: 'https://www.made-in-china.com/Lights-Lighting-Catalog/LED-Lights.html',
    },
    {
        name:        'Manufacturing & Processing Machinery',
        url:         'https://www.made-in-china.com/products/catlist/listsubcat/132/00/mic/Machinery.html',
        fallbackUrl: 'https://www.made-in-china.com/Manufacturing-Processing-Machinery-Catalog/Plastic-Machine.html',
    },
    {
        name:        'Metallurgy, Mineral & Energy',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Steel_Products.html',
        fallbackUrl: 'https://www.made-in-china.com/Metallurgy-Mineral-Energy-Catalog/Steel.html',
    },
    {
        name:        'Office Supplies',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Office_Supplies.html',
        fallbackUrl: 'https://www.made-in-china.com/Office-Supplies-Catalog/Office-Stationery.html',
    },
    {
        name:        'Packaging & Printing',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Packaging_Materials.html',
        fallbackUrl: 'https://www.made-in-china.com/Packaging-Printing-Catalog/Plastic-Packaging.html',
    },
    {
        name:        'Security & Protection',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Security_Equipment.html',
        fallbackUrl: 'https://www.made-in-china.com/Security-Protection-Catalog/CCTV-Camera.html',
    },
    {
        name:        'Sporting Goods & Recreation',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Sporting_Goods.html',
        fallbackUrl: 'https://www.made-in-china.com/Sporting-Goods-Recreation-Catalog/Sports-Equipment.html',
    },
    {
        name:        'Tools & Hardware',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Power_Tool.html',
        fallbackUrl: 'https://www.made-in-china.com/Tools-Hardware-Catalog/Power-Tool.html',
    },
    {
        name:        'Toys',
        url:         'https://www.made-in-china.com/products-search/hot-china-products/Toy.html',
        fallbackUrl: 'https://www.made-in-china.com/Toys-Games-Catalog/Educational-Toys.html',
    },
    {
        name:        'Transportation',
        url:         'https://www.made-in-china.com/Transportation-Catalog/Electric-Bike.html',
        fallbackUrl: 'https://www.made-in-china.com/products-search/hot-china-products/Electric_Bike.html',
    },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Cache helpers -----------------------------------------------------------
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

function getAllCachedProducts() { return loadCache().products || []; }

function saveDebugHtml(categoryName, html) {
    try {
        if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const safe = categoryName.replace(/[^a-z0-9]/gi, '_');
        fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), (html || '').slice(0, 80000));
    } catch (_) {}
}

// ---- HTML fetch --------------------------------------------------------------
async function fetchHtml(url) {
    const res = await axios.get(url, {
        headers:        REQUEST_HEADERS,
        timeout:        20000,
        maxRedirects:   5,
        responseType:   'text',
        validateStatus: s => s < 500,
    });
    return res.data || '';
}

// ---- HTML → products parser --------------------------------------------------
/**
 * Parse product listings out of a raw MIC HTML string.
 *
 * Confirmed HTML structure (from live fetches of search + catalog pages):
 *
 *   <a href="https://SUPPLIER.en.made-in-china.com/product/ID/China-TITLE.html">
 *     TITLE TEXT
 *   </a>
 *   ... nearby text contains price and MOQ ...
 *   US$XX.XX-XX.XX / Unit    (catalog pages)
 *   US$XX.XX 5 Sets(MOQ)     (search pages)
 *
 * Images appear as:
 *   <img src="https://image.made-in-china.com/...jpg" ...>
 *   <img data-src="https://image.made-in-china.com/...jpg" ...>   (lazy)
 */
function parseProducts(html, categoryName, max) {
    const results = [];
    const seen    = new Set();

    // Find every product link in the page.
    const linkRe = /href="(https?:\/\/[\w-]+\.en\.made-in-china\.com\/product\/[^"]+)"/g;
    let match;

    while ((match = linkRe.exec(html)) !== null && results.length < max) {
        const productUrl = match[1].split('?')[0]; // strip ad-tracking query params
        if (seen.has(productUrl)) continue;
        seen.add(productUrl);

        // --- Grab a context window of HTML around this link ---
        const ctxStart = Math.max(0, match.index - 400);
        const ctxEnd   = Math.min(html.length, match.index + 1100);
        const ctx      = html.slice(ctxStart, ctxEnd);

        // --- Title: text inside the <a> tag that contains this href ---
        const titleRe = new RegExp(
            'href="' + productUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '[^"]*"[^>]*>\\s*([^<]{5,150}?)\\s*<',
            'i'
        );
        const titleMatch = titleRe.exec(ctx);
        let title = titleMatch ? titleMatch[1].trim() : '';

        // Fallback: extract title slug from URL
        if (!title || title.length < 5) {
            const slugMatch = productUrl.match(/\/China-([^/]+)\.html/);
            if (slugMatch) title = slugMatch[1].replace(/-/g, ' ');
        }
        if (!title || title.length < 5) continue;

        // Decode common HTML entities
        title = title
            .replace(/&amp;/g,  '&')
            .replace(/&lt;/g,   '<')
            .replace(/&gt;/g,   '>')
            .replace(/&#039;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g,    ' ')
            .trim()
            .slice(0, 140);

        // --- Price ---
        // Matches: "US$200.00-600.00 / Piece"  OR  "US$200.00-600.00"
        const priceMatch = ctx.match(
            /US\$\s*[\d,.]+(?:\s*[-–]\s*[\d,.]+)?(?:\s*\/\s*[\w.]+)?/
        );
        const price = priceMatch ? priceMatch[0].replace(/\s+/g, ' ').trim() : 'Contact supplier';

        // --- MOQ ---
        // Matches: "5 Sets(MOQ)"  "1000 Meters  (MOQ)"  "200 pieces(MOQ)"
        const moqMatch = ctx.match(/([\d,]+\s+[\w()]+)\s*\(MOQ\)/i);
        const moq      = moqMatch ? moqMatch[0].trim() : 'MOQ negotiable';

        // --- Image ---
        let imageUrl = '';
        const imgRe  = /(?:data-src|src)="(https?:\/\/image\.made-in-china\.com\/[^"]+)"/g;
        const imgCtx = html.slice(
            Math.max(0, match.index - 200),
            Math.min(html.length, match.index + 800)
        );
        const imgMatch = imgRe.exec(imgCtx);
        if (imgMatch) imageUrl = imgMatch[1];

        results.push({
            id:        `mic-${Date.now().toString(36)}-${results.length}`,
            title,
            price,
            minOrder:  moq,
            imageUrl,
            category:  categoryName,
            productUrl,
            scrapedAt: new Date().toISOString(),
            source:    'made-in-china.com',
        });
    }

    return results;
}

// ---- Core category scraper --------------------------------------------------
async function scrapeCategory(category) {
    for (const targetUrl of [category.url, category.fallbackUrl].filter(Boolean)) {
        let html = '';
        try {
            html = await fetchHtml(targetUrl);
        } catch (e) {
            console.warn(`[SCRAPER] Fetch error "${category.name}" @ ${targetUrl}: ${e.message}`);
            continue;
        }

        if (!html.includes('.en.made-in-china.com/product/')) {
            const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
            console.warn(
                `[SCRAPER] No product links found for "${category.name}" @ ${targetUrl}\n` +
                `[SCRAPER] Snippet: ${snippet}`
            );
            saveDebugHtml(category.name, html);
            continue;
        }

        const products = parseProducts(html, category.name, MAX_PER_CAT);
        if (products.length > 0) {
            console.log(`[SCRAPER] "${category.name}" → ${products.length} product(s)`);
            return products;
        }

        console.warn(`[SCRAPER] Parser returned 0 for "${category.name}" @ ${targetUrl} — saving debug HTML`);
        saveDebugHtml(category.name, html);
    }

    console.warn(`[SCRAPER] Skipping "${category.name}" — no products from any URL`);
    return [];
}

// ---- Public: full cache refresh ---------------------------------------------
async function refreshProductCache(progressCb) {
    console.log('[SCRAPER] Starting made-in-china.com product cache refresh (axios)...');

    const newProducts = [];
    let done = 0;

    for (const category of CATEGORIES) {
        const batch = await scrapeCategory(category);
        newProducts.push(...batch);
        done++;
        if (progressCb) progressCb(done, CATEGORIES.length, category.name, batch.length);
        const delay = REQ_DELAY_MIN + Math.random() * (REQ_DELAY_MAX - REQ_DELAY_MIN);
        await sleep(delay);
    }

    // Deduplicate across categories by normalised title
    const seenTitles = new Set();
    const deduped = newProducts.filter(p => {
        const key = p.title.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
    });

    const cache = {
        lastUpdated:  new Date().toISOString(),
        totalScraped: deduped.length,
        products:     deduped.slice(0, 1000),
        source:       'made-in-china.com',
    };
    saveCache(cache);
    console.log(`[SCRAPER] Refresh complete — ${cache.products.length} unique products cached (${newProducts.length - deduped.length} duplicates removed).`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
