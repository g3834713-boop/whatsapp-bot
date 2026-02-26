/**
 * Product Scraper — jd-fx-imports.vercel.app
 *
 * Strategy:
 *   1. Fetch shop listing pages (/shop?page=N) to collect product page URLs.
 *   2. Visit each product page to extract: title (h1), price (GH₵), image URL.
 *   3. Images are hosted on Cloudinary or Jumia CDN — extracted by regex.
 *
 * Why per-product page fetching:
 *   - The listing page uses Next.js Image optimization, encoding real URLs as
 *     /_next/image?url=... which can be unreliable across deploys.
 *   - Product pages always expose the direct CDN image URL.
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const SHOP_BASE    = 'https://jd-fx-imports.vercel.app';
const MAX_PAGES    = 5;   // listing pages to scan (~12 products each ≈ 60 total)
const MAX_PRODUCTS = 60;  // hard cap on products cached per refresh

const REQ_DELAY_MIN = 1500;
const REQ_DELAY_MAX = 3000;

const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');
const DEBUG_DIR     = path.join(__dirname, '..', 'config', 'scraper-debug');

const REQUEST_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
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

function getAllCachedProducts() { return loadCache().products || []; }

function saveDebugHtml(label, html) {
    try {
        if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const safe = label.replace(/[^a-z0-9]/gi, '_');
        fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), (html || '').slice(0, 80000));
    } catch (_) {}
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Strip HTML tags and decode common entities from a string.
 */
function stripHtml(str) {
    return str
        .replace(/<[^>]+>/g,  ' ')
        .replace(/&amp;/g,    '&')
        .replace(/&lt;/g,     '<')
        .replace(/&gt;/g,     '>')
        .replace(/&#039;/g,   "'")
        .replace(/&quot;/g,   '"')
        .replace(/&nbsp;/g,   ' ')
        .replace(/\s+/g,      ' ')
        .trim();
}

/**
 * Decode a Next.js /_next/image?url=... encoded URL back to the original CDN URL.
 */
function decodeNextImageUrl(encoded) {
    try {
        const decoded = decodeURIComponent(encoded);
        if (decoded.startsWith('http')) return decoded.split('&')[0];
    } catch (_) {}
    return '';
}

// ── Listing page parser ───────────────────────────────────────────────────────
/**
 * Collect unique product path strings from a shop listing page HTML.
 * Returns an array like ['/product/jo20nsxyc', ...]
 */
function extractProductPaths(html) {
    const paths = new Set();
    const re    = /href="(\/product\/[a-z0-9]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        paths.add(m[1]);
    }
    return [...paths];
}

// ── Product page parser ───────────────────────────────────────────────────────
/**
 * Extract title, price, and image URL from a single product page HTML.
 */
function parseProductPage(html, productUrl) {
    // --- Title ---
    let title = '';
    const h1Match = html.match(/<h1[^>]*>([\s\S]{5,300}?)<\/h1>/i);
    if (h1Match) {
        title = stripHtml(h1Match[1]).slice(0, 150);
    }
    if (!title) {
        const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]{5,200})"/i)
                     || html.match(/<meta[^>]+content="([^"]{5,200})"[^>]+property="og:title"/i);
        if (ogMatch) title = ogMatch[1].trim().slice(0, 150);
    }
    if (!title) {
        const slug = productUrl.match(/\/product\/([a-z0-9]+)$/i);
        if (slug) title = slug[1];
    }

    // --- Price ---
    // Matches: GH₵5,340.00  or  GH₵60.06
    const priceMatch = html.match(/GH[₵\u20B5]([\d,]+\.?\d*)/);
    const price = priceMatch ? `GH₵${priceMatch[1]}` : '';

    // --- Image ---
    let imageUrl = '';

    // 1. Direct Cloudinary or Jumia CDN URLs
    const cdnRe    = /(https:\/\/res\.cloudinary\.com\/[^"'\s\\>]+|https:\/\/gh\.jumia\.is\/[^"'\s\\>]+)/;
    const cdnMatch = html.match(cdnRe);
    if (cdnMatch) {
        imageUrl = cdnMatch[1].replace(/\\u0026/g, '&');
    }

    // 2. Next.js encoded image URL fallback
    if (!imageUrl) {
        const nextImgMatch = html.match(/\/_next\/image\?url=([^&"'\s]+)/);
        if (nextImgMatch) {
            imageUrl = decodeNextImageUrl(nextImgMatch[1]);
        }
    }

    return { title, price, imageUrl };
}

// ── Core scraper ──────────────────────────────────────────────────────────────
async function refreshProductCache(progressCb) {
    console.log(`[SCRAPER] Starting jd-fx-imports.vercel.app scrape (max ${MAX_PAGES} pages, ${MAX_PRODUCTS} products)...`);

    // Step 1: Collect product paths from listing pages
    const allPaths = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
        const url = page === 1 ? `${SHOP_BASE}/shop` : `${SHOP_BASE}/shop?page=${page}`;
        console.log(`[SCRAPER] Scanning listing page ${page}/${MAX_PAGES} ...`);
        try {
            const html  = await fetchHtml(url);
            const paths = extractProductPaths(html);
            if (paths.length === 0) {
                console.warn(`[SCRAPER] No product links on page ${page} — stopping pagination.`);
                saveDebugHtml(`listing-page-${page}`, html);
                break;
            }
            paths.forEach(p => allPaths.add(p));
            console.log(`[SCRAPER] Page ${page}: ${paths.length} links found (${allPaths.size} total)`);
        } catch (e) {
            console.warn(`[SCRAPER] Page ${page} fetch failed: ${e.message}`);
        }
        if (allPaths.size >= MAX_PRODUCTS) break;
        await sleep(REQ_DELAY_MIN + Math.random() * (REQ_DELAY_MAX - REQ_DELAY_MIN));
    }

    const pathList = [...allPaths].slice(0, MAX_PRODUCTS);
    console.log(`[SCRAPER] Collected ${pathList.length} product URLs — fetching details...`);

    // Step 2: Visit each product page to get title, price, image
    const products = [];
    let done = 0;

    for (const relPath of pathList) {
        const productUrl = SHOP_BASE + relPath;
        const id         = relPath.replace('/product/', '');

        try {
            const html  = await fetchHtml(productUrl);
            const { title, price, imageUrl } = parseProductPage(html, productUrl);

            if (!title || !price) {
                console.warn(`[SCRAPER] Skipping ${id} — missing title or price`);
                saveDebugHtml(`product-${id}`, html);
            } else {
                products.push({
                    id:        `jd-${id}`,
                    title,
                    price,
                    minOrder:  '1 Piece',
                    imageUrl,
                    category:  'Jordan Imports',
                    productUrl,
                    scrapedAt: new Date().toISOString(),
                    source:    'jd-fx-imports.vercel.app',
                });
                console.log(`[SCRAPER] ✓ (${products.length}) ${title.slice(0, 50)}`);
            }
        } catch (e) {
            console.warn(`[SCRAPER] Product fetch failed ${id}: ${e.message}`);
        }

        done++;
        if (progressCb) progressCb(done, pathList.length, `Product ${done}`, 1);
        await sleep(REQ_DELAY_MIN + Math.random() * (REQ_DELAY_MAX - REQ_DELAY_MIN));
    }

    const cache = {
        lastUpdated:  new Date().toISOString(),
        totalScraped: products.length,
        products,
        source:       'jd-fx-imports.vercel.app',
    };
    saveCache(cache);
    console.log(`[SCRAPER] Done — ${products.length} products cached from jd-fx-imports.vercel.app`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
