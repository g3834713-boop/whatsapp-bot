/**
 * Product Scraper -- made-in-china.com scraper (Puppeteer edition)
 *
 * Why made-in-china.com instead of Alibaba:
 *   - Server-side rendered HTML (actual product data in the page source)
 *   - Does NOT block Railway/datacenter IPs (no CAPTCHA)
 *   - No ScraperAPI needed → 100% free, unlimited runs
 *   - Shows real factory FOB prices and MOQ directly
 *
 * Puppeteer is used (rather than plain axios) so that lazy-loaded
 * product images are resolved before we extract src attributes.
 *
 * A single browser instance is launched per full scrape run, then closed.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');
const DEBUG_DIR     = path.join(__dirname, '..', 'config', 'scraper-debug');

const MAX_PER_CAT   = 6;
const REQ_DELAY_MIN = 4000;
const REQ_DELAY_MAX = 8000;

const CHROME_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--shm-size=256mb',
    '--window-size=1366,768',
    '--disable-blink-features=AutomationControlled',
];

// ---- made-in-china.com top-level categories ----------------------------------
// url: the direct product listing page for this category.
// The pattern {Slug}-Catalog/{Slug}.html is MIC's own catalog URL structure.
// A search fallback is also attempted if the catalog page returns no products.
const CATEGORIES = [
    {
        name: 'Apparel & Accessories',
        url:  'https://www.made-in-china.com/Apparel-Accessories-Catalog/Apparel-Accessories.html',
    },
    {
        name: 'Arts & Crafts',
        url:  'https://www.made-in-china.com/Gifts-Crafts-Catalog/Arts-Crafts.html',
    },
    {
        name: 'Auto, Motorcycle Parts & Accessories',
        url:  'https://www.made-in-china.com/Auto-Parts-Accessories-Catalog/Auto-Parts.html',
    },
    {
        name: 'Bags, Cases & Boxes',
        url:  'https://www.made-in-china.com/Luggage-Bags-Cases-Catalog/Bags-Cases-Boxes.html',
    },
    {
        name: 'Chemicals',
        url:  'https://www.made-in-china.com/Chemicals-Catalog/Chemicals.html',
    },
    {
        name: 'Computer Products',
        url:  'https://www.made-in-china.com/Consumer-Electronics-Catalog/Computer-Products.html',
    },
    {
        name: 'Construction & Decoration',
        url:  'https://www.made-in-china.com/Construction-Real-Estate-Catalog/Construction-Decoration.html',
    },
    {
        name: 'Consumer Electronics',
        url:  'https://www.made-in-china.com/Consumer-Electronics-Catalog/Consumer-Electronics.html',
    },
    {
        name: 'Electrical & Electronics',
        url:  'https://www.made-in-china.com/Electrical-Equipment-Supplies-Catalog/Electrical-Electronics.html',
    },
    {
        name: 'Furniture',
        url:  'https://www.made-in-china.com/Furniture-Catalog/Furniture.html',
    },
    {
        name: 'Health & Medicine',
        url:  'https://www.made-in-china.com/Health-Medical-Catalog/Health-Medicine.html',
    },
    {
        name: 'Industrial Equipment & Components',
        url:  'https://www.made-in-china.com/Industrial-Machinery-Catalog/Industrial-Equipment.html',
    },
    {
        name: 'Instruments & Meters',
        url:  'https://www.made-in-china.com/Instruments-Meters-Catalog/Instruments-Meters.html',
    },
    {
        name: 'Light Industry & Daily Use',
        url:  'https://www.made-in-china.com/Light-Industry-Daily-Use-Catalog/Light-Industry-Daily-Use.html',
    },
    {
        name: 'Lights & Lighting',
        url:  'https://www.made-in-china.com/Lights-Lighting-Catalog/Lights-Lighting.html',
    },
    {
        name: 'Manufacturing & Processing Machinery',
        url:  'https://www.made-in-china.com/Manufacturing-Processing-Machinery-Catalog/Manufacturing-Processing-Machinery.html',
    },
    {
        name: 'Metallurgy, Mineral & Energy',
        url:  'https://www.made-in-china.com/Metallurgy-Mineral-Energy-Catalog/Metallurgy-Mineral-Energy.html',
    },
    {
        name: 'Office Supplies',
        url:  'https://www.made-in-china.com/Office-Supplies-Catalog/Office-Supplies.html',
    },
    {
        name: 'Packaging & Printing',
        url:  'https://www.made-in-china.com/Packaging-Printing-Catalog/Packaging-Printing.html',
    },
    {
        name: 'Security & Protection',
        url:  'https://www.made-in-china.com/Security-Protection-Catalog/Security-Protection.html',
    },
    {
        name: 'Sporting Goods & Recreation',
        url:  'https://www.made-in-china.com/Sporting-Goods-Recreation-Catalog/Sporting-Goods-Recreation.html',
    },
    {
        name: 'Tools & Hardware',
        url:  'https://www.made-in-china.com/Tools-Hardware-Catalog/Tools-Hardware.html',
    },
    {
        name: 'Toys',
        url:  'https://www.made-in-china.com/Toys-Games-Catalog/Toys.html',
    },
    {
        name: 'Transportation',
        url:  'https://www.made-in-china.com/Transportation-Catalog/Transportation.html',
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
        fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), html.slice(0, 60000));
    } catch (_) {}
}

// ---- Stealth patches --------------------------------------------------------
async function applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });
}

// ---- Core scraper -----------------------------------------------------------
/**
 * Scrape one made-in-china.com category page.
 * MIC renders product titles, prices, and MOQ server-side, so they're in the
 * initial HTML.  Images are lazy-loaded; Puppeteer resolves them automatically.
 * No ScraperAPI proxy needed -- MIC does not block datacenter IPs.
 *
 * Fallback: if the catalog URL yields no cards, tries MIC's keyword search.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {{ name: string, url: string }} category
 * @returns {Promise<object[]>}
 */
async function scrapeCategory(browser, category) {
    const page = await browser.newPage();
    try {
        await applyStealthPatches(page);
        await page.setViewport({
            width:  1366 + Math.floor(Math.random() * 80),
            height: 768  + Math.floor(Math.random() * 60),
        });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        });

        // Block fonts/media only (allow images for lazy-load resolution)
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (['media', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // MIC search fallback URL (keyword search, underscores for spaces)
        const keyword     = category.name.replace(/[^a-z0-9]+/gi, '_');
        const searchUrl   = `https://www.made-in-china.com/products-search/hot-china-products/${keyword}.html`;

        // Selector for product cards: MIC renders each item in a list container.
        // The most stable anchor is links pointing to *.en.made-in-china.com/product/
        // We look for the parent container of any such link.
        const PRODUCT_LINK_SEL = 'a[href*=".en.made-in-china.com/product/"]';

        let found = false;

        // -- Try primary catalog URL --
        try {
            await page.goto(category.url, { waitUntil: 'networkidle2', timeout: 40000 });
            await sleep(2000);
            await page.waitForSelector(PRODUCT_LINK_SEL, { timeout: 12000 });
            found = true;
        } catch (_) {
            console.warn(`[SCRAPER] Catalog page empty for "${category.name}", trying search URL...`);
        }

        // -- Fallback to keyword search --
        if (!found) {
            try {
                await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 40000 });
                await sleep(2000);
                await page.waitForSelector(PRODUCT_LINK_SEL, { timeout: 12000 });
                found = true;
            } catch (_) {
                const html      = await page.content();
                const title     = await page.title();
                const bodySnip  = await page.evaluate(() =>
                    (document.body ? document.body.innerText : '').slice(0, 600)
                );
                console.warn(`[SCRAPER] No products for "${category.name}"`);
                console.warn(`[SCRAPER] Page title: "${title}"`);
                console.warn(`[SCRAPER] Body snippet:\n${bodySnip}\n---`);
                saveDebugHtml(category.name, html);
            }
        }

        if (!found) return [];

        // ---- Extract products from the live DOM --------------------------------
        const products = await page.evaluate((max, categoryName, linkSel) => {
            const results   = [];
            const linkEls   = Array.from(document.querySelectorAll(linkSel));
            // Deduplicate: only one link per product card (first link in card)
            const seen      = new Set();
            const uniqueLinks = linkEls.filter(a => {
                const href = a.getAttribute('href') || '';
                if (seen.has(href)) return false;
                seen.add(href);
                return true;
            });

            for (let i = 0; i < uniqueLinks.length && results.length < max; i++) {
                const anchor   = uniqueLinks[i];
                const href     = anchor.getAttribute('href') || '';
                const linkUrl  = href.startsWith('http') ? href : 'https:' + href;

                // Title: text of the anchor itself, or the closest heading
                let title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
                if (!title || title.length < 5) {
                    const heading = anchor.closest('h2,h3,h4');
                    if (heading) title = (heading.textContent || '').replace(/\s+/g, ' ').trim();
                }
                if (!title || title.length < 5) continue;

                // Walk up the DOM to find the card container (stop at 8 levels)
                let card = anchor;
                for (let depth = 0; depth < 8; depth++) {
                    if (!card.parentElement) break;
                    card = card.parentElement;
                    const text = card.innerText || '';
                    // Stop once we find a container that has BOTH a price and an MOQ
                    if (/US\$[\d,.]+/.test(text) && /MOQ|Pieces?\s*\(/.test(text)) break;
                }

                const cardText = card.innerText || '';

                // Price: e.g. "US$68.00-101.00 / Piece" or "US$68.00 / Piece"
                const priceMatch = cardText.match(/US\$[\d,.]+(?:\s*[-–]\s*[\d,.]+)?\s*\/\s*\w+/);
                const price      = priceMatch ? priceMatch[0].trim() : 'Contact supplier';

                // MOQ: e.g. "10 Pieces  (MOQ)" or "1 Set (MOQ)"
                const moqMatch = cardText.match(/(\d[\d,]*\s+\w+)\s+\(MOQ\)/i);
                const moq      = moqMatch ? moqMatch[0].trim() : 'MOQ negotiable';

                // Image: prefer data-src (lazy) then src; skip space.png placeholders
                let imageUrl = '';
                const imgs   = Array.from(card.querySelectorAll('img'));
                for (const img of imgs) {
                    const raw = img.getAttribute('data-src') ||
                                img.getAttribute('data-lazy-src') ||
                                img.getAttribute('src') || '';
                    if (raw && !raw.includes('space.png') && !raw.startsWith('data:') && raw.length > 20) {
                        imageUrl = raw.startsWith('//') ? 'https:' + raw : raw;
                        break;
                    }
                }

                results.push({
                    id:         `mic-${Date.now().toString(36)}-${i}`,
                    title:      title.slice(0, 130),
                    price:      price.slice(0, 80),
                    minOrder:   moq.slice(0, 60),
                    imageUrl,
                    category:   categoryName,
                    productUrl: linkUrl,
                    scrapedAt:  new Date().toISOString(),
                    source:     'made-in-china.com',
                });
            }
            return results;
        }, MAX_PER_CAT, category.name, PRODUCT_LINK_SEL);

        console.log(`[SCRAPER] "${category.name}" -> ${products.length} product(s)`);
        return products;
    } catch (e) {
        console.warn(`[SCRAPER] Error for "${category.name}": ${e.message}`);
        return [];
    } finally {
        await page.close();
    }
}

// ---- Public: full cache refresh ---------------------------------------------
async function refreshProductCache(progressCb) {
    console.log('[SCRAPER] Launching browser for made-in-china.com product cache refresh...');
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
        for (const category of CATEGORIES) {
            const batch = await scrapeCategory(browser, category);
            newProducts.push(...batch);
            done++;
            if (progressCb) progressCb(done, CATEGORIES.length, category.name, batch.length);
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
        source:       'made-in-china.com',
    };
    saveCache(cache);
    console.log(`[SCRAPER] Refresh complete -- ${combined.length} products cached.`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
