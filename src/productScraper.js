/**
 * Product Scraper — backend-jd.vercel.app REST API
 *
 * The shop (jd-fx-imports.vercel.app) is a client-side Vite/React SPA whose
 * data comes from a REST API at https://backend-jd.vercel.app/api/products.
 * That endpoint returns all 620+ products as JSON in one call — no HTML
 * parsing, no pagination, no Puppeteer needed.
 *
 * Field mapping from API → cache:
 *   id               → id  (prefixed "jd-")
 *   name             → title
 *   price            → price  (number in GH₵, formatted on display)
 *   image            → imageUrl  (direct Cloudinary URL)
 *   status           → status
 *   estimatedDelivery→ delivery
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const API_URL       = 'https://backend-jd.vercel.app/api/products';
const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');

const REQUEST_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

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

// ── API fetch ─────────────────────────────────────────────────────────────────
async function fetchProducts() {
    const res = await axios.get(API_URL, {
        headers:        REQUEST_HEADERS,
        timeout:        20000,
        validateStatus: s => s < 500,
    });
    if (!Array.isArray(res.data)) {
        throw new Error(`Unexpected response: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return res.data;
}

// ── Price formatter ───────────────────────────────────────────────────────────
/** Format a raw GH₵ number from the API into a display string: 1841 → "GH₵1,841" */
function formatPrice(price) {
    if (price == null) return 'Contact seller';
    return 'GH\u20B5' + Number(price).toLocaleString('en-GH');
}

// ── Core: refresh cache from API ──────────────────────────────────────────────
async function refreshProductCache(progressCb) {
    console.log('[SCRAPER] Fetching products from backend-jd.vercel.app API...');

    let raw;
    try {
        raw = await fetchProducts();
    } catch (e) {
        console.error('[SCRAPER] API fetch failed:', e.message);
        throw e;
    }

    console.log(`[SCRAPER] API returned ${raw.length} products — mapping to cache...`);

    const products = raw.map((p, i) => {
        if (progressCb && i % 50 === 0) progressCb(i, raw.length, p.name || p.id, 1);
        return {
            id:        `jd-${p.id}`,
            title:     (p.name || '').trim(),
            price:     formatPrice(p.price),
            minOrder:  '1 Piece',
            imageUrl:  p.image || '',
            category:  'Jordan Imports',
            productUrl: `https://jd-fx-imports.vercel.app/product/${p.id}`,
            scrapedAt: new Date().toISOString(),
            source:    'jd-fx-imports.vercel.app',
        };
    }).filter(p => p.title && p.price);

    const cache = {
        lastUpdated:  new Date().toISOString(),
        totalScraped: products.length,
        products,
        source:       'jd-fx-imports.vercel.app',
    };
    saveCache(cache);
    console.log(`[SCRAPER] Done — ${products.length} products cached from API.`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
