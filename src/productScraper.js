/**
 * Product Scraper -- Alibaba category scraper (Puppeteer edition)
 *
 * Alibaba pages are fully JS-rendered -- axios+cheerio only gets the bare
 * HTML shell with no product data.  This module uses Puppeteer (already
 * installed via whatsapp-web.js) to render each category page and extract
 * products from the live DOM.
 *
 * Categories are Alibaba's official top-level categories, NOT niche
 * keyword searches.  Each entry has a browse-page slug; if the browse
 * page yields no cards the scraper falls back to a trade-search URL
 * using the category name as the query.
 *
 * A single browser instance is launched per full scrape run, then closed.
 * It does NOT interfere with the WhatsApp client browser.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const PRODUCTS_FILE = path.join(__dirname, '..', 'config', 'products.json');

const MAX_PER_CAT   = 6;
const REQ_DELAY_MIN = 6000;
const REQ_DELAY_MAX = 11000;

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
    '--window-size=1280,800',
];

// ---- Official Alibaba top-level categories -----------------------------------
// slug is the path segment used in both browse and search URLs.
const CATEGORIES = [
    { name: 'Apparel & Accessories',             slug: 'Apparel-Accessories'                },
    { name: 'Consumer Electronics',              slug: 'Consumer-Electronics'               },
    { name: 'Luggage, Bags & Cases',             slug: 'Luggage-Bags-Cases'                 },
    { name: 'Parents, Kids & Toys',              slug: 'Toys-Games'                         },
    { name: 'Commercial Equipment & Machinery',  slug: 'Commercial-Equipment-Machinery'     },
    { name: 'Home & Garden',                     slug: 'Home-Garden'                        },
    { name: 'Sports & Entertainment',            slug: 'Sports-Entertainment'               },
    { name: 'Sportswear & Outdoor Apparel',      slug: 'Sportswear-Outdoor-Apparel'         },
    { name: 'Beauty',                            slug: 'Beauty'                             },
    { name: 'Jewelry, Eyewear & Watches',        slug: 'Jewelry-Eyewear-Watches'            },
    { name: 'Shoes & Accessories',               slug: 'Shoes-Accessories'                  },
    { name: 'Packaging & Printing',              slug: 'Packaging-Printing'                 },
    { name: 'Personal Care & Home Care',         slug: 'Personal-Care-Home-Care'            },
    { name: 'Health & Medical',                  slug: 'Health-Medical'                     },
    { name: 'Gifts & Crafts',                    slug: 'Gifts-Crafts'                       },
    { name: 'Pet Supplies',                      slug: 'Pet-Supplies'                       },
    { name: 'School & Office Supplies',          slug: 'School-Office-Supplies'             },
    { name: 'Industrial Machinery',              slug: 'Industrial-Machinery'               },
    { name: 'Construction & Building Machinery', slug: 'Construction-Building-Machinery'    },
    { name: 'Construction & Real Estate',        slug: 'Construction-Real-Estate'           },
    { name: 'Furniture',                         slug: 'Furniture'                          },
    { name: 'Lights & Lighting',                 slug: 'Lights-Lighting'                    },
    { name: 'Home Appliances',                   slug: 'Home-Appliances'                    },
    { name: 'Automotive Supplies & Tools',       slug: 'Automotive-Supplies-Tools'          },
    { name: 'Vehicle Parts & Accessories',       slug: 'Vehicle-Parts-Accessories'          },
    { name: 'Tools & Hardware',                  slug: 'Tools-Hardware'                     },
    { name: 'Renewable Energy',                  slug: 'Renewable-Energy'                   },
    { name: 'Electrical Equipment & Supplies',   slug: 'Electrical-Equipment-Supplies'      },
    { name: 'Safety & Security',                 slug: 'Safety-Security'                    },
    { name: 'Material Handling',                 slug: 'Material-Handling'                  },
    { name: 'Testing Instrument & Equipment',    slug: 'Testing-Instruments-Equipment'      },
    { name: 'Power Transmission',                slug: 'Power-Transmission'                 },
    { name: 'Electronic Components',             slug: 'Electronic-Components-Supplies'     },
    { name: 'Vehicles & Transportation',         slug: 'Vehicles-Transportation'            },
    { name: 'Agriculture, Food & Beverage',      slug: 'Agriculture-Food-Beverage'          },
    { name: 'Raw Materials',                     slug: 'Raw-Materials'                      },
    { name: 'Fabrication Services',              slug: 'Manufacturing-Processing-Machinery' },
];

// Comprehensive selector list covering Alibaba DOM from 2022 through 2025
const CARD_SELECTORS = [
    // Current Alibaba (2024-2025 redesign)
    '.search-card-e-offer',
    '.search-card-e',
    '[class*="search-card"]',
    // FY23 search cards
    '.fy23-search-card',
    // Organic gallery (2022-2023)
    '.organic-gallery-offer-outter',
    '.J-offer-wrapper',
    '.list-no-v2-outter',
    // Generic attribute fallbacks
    '[class*="SearchCard"]',
    '[class*="offer-item"]',
    '[class*="offerItem"]',
    '.offer-list-items .item',
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

// ---- Core scraper (Puppeteer) ------------------------------------------------
/**
 * Scrape one Alibaba category using a Puppeteer page.
 * 1. Tries the official category browse page (e.g. /Apparel-Accessories_p1.html)
 * 2. Falls back to trade-search with the category name as the query.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {{ name: string, slug: string }} category
 * @returns {Promise<object[]>}
 */
async function scrapeCategory(browser, category) {
    const page = await browser.newPage();
    try {
        // Randomise viewport to reduce bot fingerprint
        await page.setViewport({
            width:  1280 + Math.floor(Math.random() * 120),
            height: 800  + Math.floor(Math.random() * 100),
        });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        });

        // Block images/fonts/media -- we pull image URLs from DOM attributes
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Primary: category browse page
        const browseUrl = `https://www.alibaba.com/${category.slug}_p1.html`;
        // Fallback: trade-search with category name
        const searchUrl = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(category.name)}&IndexArea=product_en&viewtype=G&page=1`;

        const selectorStr = CARD_SELECTORS.join(', ');
        let found = false;

        // -- Try browse URL first --
        try {
            await page.goto(browseUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
            await page.waitForSelector(selectorStr, { timeout: 12000 });
            found = true;
        } catch (_) {
            console.warn(`[SCRAPER] Browse page empty for "${category.name}", trying search URL...`);
        }

        // -- Fallback to search URL --
        if (!found) {
            try {
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                await page.waitForSelector(selectorStr, { timeout: 12000 });
                found = true;
            } catch (_) {
                console.warn(`[SCRAPER] No product cards for "${category.name}" (both URLs tried)`);
            }
        }

        if (!found) return [];

        // Extract products from the live DOM
        const products = await page.evaluate((max, categoryName, selectors) => {
            const results = [];

            let cards = [];
            for (const sel of selectors) {
                cards = Array.from(document.querySelectorAll(sel));
                if (cards.length > 0) break;
            }

            for (let i = 0; i < Math.min(cards.length, max); i++) {
                const el = cards[i];

                // Title
                const titleEl =
                    el.querySelector('.search-card-e-title')    ||
                    el.querySelector('[class*="title"]')         ||
                    el.querySelector('h2')                       ||
                    el.querySelector('h3')                       ||
                    el.querySelector('h4');
                const title = (titleEl ? titleEl.textContent : '').replace(/\s+/g, ' ').trim();
                if (!title || title.length < 4) continue;

                // Price
                const priceEl =
                    el.querySelector('.search-card-e-price-main') ||
                    el.querySelector('[class*="price"]');
                const price = priceEl
                    ? priceEl.textContent.replace(/\s+/g, ' ').trim()
                    : 'Contact supplier';

                // MOQ
                const moqEl =
                    el.querySelector('.search-card-e-min-order') ||
                    el.querySelector('[class*="min-order"]')      ||
                    el.querySelector('[class*="moq"]')            ||
                    el.querySelector('[class*="minorder"]');
                const moq = moqEl
                    ? moqEl.textContent.replace(/\s+/g, ' ').trim()
                    : 'MOQ negotiable';

                // Image
                let imageUrl = '';
                const img = el.querySelector('img');
                if (img) {
                    const raw =
                        img.getAttribute('data-src')      ||
                        img.getAttribute('data-lazy-src') ||
                        img.getAttribute('src')           || '';
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
                    category:   categoryName,
                    productUrl: linkUrl,
                    scrapedAt:  new Date().toISOString(),
                });
            }
            return results;
        }, MAX_PER_CAT, category.name, CARD_SELECTORS);

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
    console.log('[SCRAPER] Launching browser for product cache refresh...');
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
    };
    saveCache(cache);
    console.log(`[SCRAPER] Refresh complete -- ${combined.length} products cached.`);
    return cache;
}

module.exports = { getAllCachedProducts, refreshProductCache, loadCache, saveCache };
