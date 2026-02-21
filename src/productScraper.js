/**
 * Product Scraper â€” Alibaba search scraper (Puppeteer edition)
 *
 * Alibaba search pages are fully JS-rendered â€” axios+cheerio only gets
 * the bare HTML shell with no product data. This rewrite uses Puppeteer
 * (already installed via whatsapp-web.js) to render each page and extract
 * products from the live DOM.
 *
 * A single browser instance is launched per full scrape run, then closed.
 * It does NOT interfere with the WhatsApp client browser.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');

const MAX_PER_KW    = 6;
const REQ_DELAY_MIN = 5000;
const REQ_DELAY_MAX = 9000;

const CHROME_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-features=IsolateOrigins,site-per-process',
    '--shm-size=256mb',
];

const CATEGORY_KEYWORDS = [
    'ankara fabric wholesale',
    'african print fabric bulk',
    'ladies fashion tops wholesale',
    'men casual shirts bulk',
    'fashion jewelry wholesale',
    'ladies wristwatch bulk order',
    'sunglasses wholesale',
    'human hair wigs wholesale',
    'skin cream beauty products wholesale',
    'cosmetics makeup wholesale',
    'smartphone accessories wholesale',
    'wireless earbuds bulk order',
    'power bank wholesale',
    'kitchen utensils wholesale',
    'household cleaning products bulk',
    'bedding sets wholesale',
    'ladies handbags wholesale',
    'backpack bags bulk order',
    'sports equipment wholesale',
    'fitness accessories bulk',
    'ladies shoes wholesale',
    'sneakers bulk order',
    'lace fabric wholesale',
    'printed cotton fabric bulk',
    'gift items wholesale',
    'souvenir crafts bulk',
    'small home appliances wholesale',
    'electric fan bulk order',
    'children toys wholesale',
    'baby products bulk order',
    'hair care products wholesale',
    'beauty tools bulk order',
    'food packaging wholesale',
    'furniture accessories wholesale',
    'hand tools wholesale',
    'stationery wholesale',
    'school bags bulk order',
    'led lights wholesale',
    'electrical accessories bulk',
    'face masks wholesale',
    'medical gloves bulk',
    'pet accessories wholesale',
    'cctv cameras wholesale',
    'car accessories wholesale',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// â”€â”€ Cache helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Core scraper (Puppeteer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Scrape one Alibaba search keyword using a Puppeteer page.
 * @param {import('puppeteer').Browser} browser
 * @param {string} keyword
 */
async function scrapeKeyword(browser, keyword) {
    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        // Block images/fonts/media to speed up loading â€” we grab image URLs from DOM attrs
        await page.setRequestInterception(true);
        page.on('request', req => {
            const type = req.resourceType();
            if (['image', 'media', 'font'].includes(type)) req.abort();
            else req.continue();
        });

        const url = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(keyword)}&IndexArea=product_en&viewtype=G&page=1`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for any of the known product card containers
        const CARD_SELECTORS = [
            '.organic-gallery-offer-outter',
            '.J-offer-wrapper',
            '.list-no-v2-outter',
            '.offer-list-items .item',
            '.fy23-search-card',
            '[class*="SearchCard"]',
            '[class*="offer-item"]',
        ];
        const selectorStr = CARD_SELECTORS.join(', ');
        try {
            await page.waitForSelector(selectorStr, { timeout: 10000 });
        } catch (_) {
            // No product cards appeared â€” likely CAPTCHA or empty results
            console.warn(`[SCRAPER] No product cards after wait for "${keyword}"`);
        }

        // Extract products from the rendered DOM
        const products = await page.evaluate((max, keyword) => {
            const results = [];
            const cardSelectors = [
                '.organic-gallery-offer-outter',
                '.J-offer-wrapper',
                '.list-no-v2-outter',
                '.offer-list-items .item',
                '[class*="SearchCard"]',
                '[class*="offer-item"]',
                '.fy23-search-card',
            ];

            let cards = [];
            for (const sel of cardSelectors) {
                cards = Array.from(document.querySelectorAll(sel));
                if (cards.length > 0) break;
            }

            for (let i = 0; i < Math.min(cards.length, max); i++) {
                const el = cards[i];

                // Title â€” try various class patterns
                const titleEl =
                    el.querySelector('[class*="title"]') ||
                    el.querySelector('h2') || el.querySelector('h3') || el.querySelector('h4');
                const title = (titleEl ? titleEl.textContent : '').replace(/\s+/g, ' ').trim();
                if (!title || title.length < 5) continue;

                // Price
                const priceEl = el.querySelector('[class*="price"]');
                const price   = priceEl ? priceEl.textContent.replace(/\s+/g, ' ').trim() : 'Contact supplier';

                // MOQ
                const moqEl = el.querySelector('[class*="min-order"], [class*="moq"], [class*="minorder"]');
                const moq   = moqEl ? moqEl.textContent.replace(/\s+/g, ' ').trim() : 'MOQ negotiable';

                // Image â€” grab data-src / src; skip base64/placeholder
                let imageUrl = '';
                const img = el.querySelector('img');
                if (img) {
                    const raw = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
                    if (raw && !raw.startsWith('data:') && raw.length > 30) {
                        imageUrl = raw.startsWith('//') ? 'https:' + raw : raw;
                    }
                }

                // Link
                const anchor  = el.querySelector('a[href]');
                const href    = anchor ? anchor.getAttribute('href') : '';
                const linkUrl = href
                    ? (href.startsWith('http') ? href : 'https://www.alibaba.com' + href)
                    : '';

                results.push({
                    id:         `ab-${Date.now().toString(36)}-${i}`,
                    title:      title.slice(0, 130),
                    price:      price.slice(0, 80),
                    minOrder:   moq.slice(0, 60),
                    imageUrl,
                    category:   keyword,
                    productUrl: linkUrl,
                    scrapedAt:  new Date().toISOString(),
                });
            }
            return results;
        }, MAX_PER_KW, keyword);

        console.log(`[SCRAPER] "${keyword}" â†’ ${products.length} product(s)`);
        return products;
    } catch (e) {
        console.warn(`[SCRAPER] Error for "${keyword}": ${e.message}`);
        return [];
    } finally {
        await page.close();
    }
}

// â”€â”€ Public: full cache refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function refreshProductCache(progressCb) {
    console.log('[SCRAPER] Launching browser for product cache refreshâ€¦');
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: CHROME_PATH,
            args: PUPPETEER_ARGS,
        });
    } catch (e) {
        console.error('[SCRAPER] Failed to launch browser:', e.message);
        throw e;
    }

    const newProducts = [];
    let done = 0;

    try {
        for (const keyword of CATEGORY_KEYWORDS) {
            const batch = await scrapeKeyword(browser, keyword);
            newProducts.push(...batch);
            done++;
            if (progressCb) progressCb(done, CATEGORY_KEYWORDS.length, keyword, batch.length);
            const delay = REQ_DELAY_MIN + Math.random() * (REQ_DELAY_MAX - REQ_DELAY_MIN);
            await sleep(delay);
        }
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    const combined = newProducts.slice(0, 1000);
    const cache = {
        lastUpdated:  new Date().toISOString(),
        totalScraped: newProducts.length,
        products:     combined,
    };
    saveCache(cache);
    console.log(`[SCRAPER] Refresh complete â€” ${combined.length} products cached.`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
