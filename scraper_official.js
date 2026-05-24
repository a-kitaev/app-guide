/**
 * Official Site Price Scraper
 * 
 * Loads building data from buildings.json, scrapes each official_url
 * using Playwright + CDP (your real Chrome). Handles the main leasing
 * platform types: Entrata, Cortland, Dittmar, AvalonBay, Bozzuto, etc.
 * 
 * Usage:
 *   node scraper_official.js                   # all buildings
 *   node scraper_official.js --id b3           # single building by id
 *   node scraper_official.js --type entrata    # all entrata buildings
 *   node scraper_official.js --headful         # show browser
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const BUILDINGS = JSON.parse(readFileSync('./buildings.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// ─── EXTRACTORS ──────────────────────────────────────────────────────────────
// Each extractor knows how to pull floor plan prices from a specific platform.
// All return: { price2_min, price2_max, price3_min, price3_max, plans, source }

// Generic: works for most Entrata-based sites
// Entrata renders floor plans as JSON in a <script id="entrata-data"> tag
// or in window.__ENTRATA_DATA__ after JS loads
async function extractEntrata(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(1500, 2500)); // let JS render

  // Try window.__ENTRATA_DATA__ first (fastest)
  const data = await page.evaluate(() => {
    if (window.__ENTRATA_DATA__) return window.__ENTRATA_DATA__;
    // Fall back: look for floorplan cards in the DOM
    const cards = document.querySelectorAll('[class*="floorplan"],[class*="floor-plan"],[data-beds]');
    if (!cards.length) return null;
    const results = [];
    cards.forEach(card => {
      const bedsEl = card.querySelector('[class*="bed"],[data-beds]');
      const priceEl = card.querySelector('[class*="price"],[class*="rent"]');
      if (bedsEl && priceEl) {
        const beds = parseInt(bedsEl.textContent);
        const price = parseInt(priceEl.textContent.replace(/[^0-9]/g, ''));
        if (!isNaN(beds) && !isNaN(price)) results.push({ beds, price });
      }
    });
    return results.length ? { domParsed: results } : null;
  });

  if (!data) return { error: 'no entrata data found' };

  // Handle Entrata API format
  if (data.result?.floorplans || data.floorplans) {
    const fps = data.result?.floorplans || data.floorplans;
    return groupByBeds(fps, fp => ({
      beds: fp.bedrooms || fp.beds,
      min: fp.priceMin || fp.minPrice || fp.price,
      max: fp.priceMax || fp.maxPrice || fp.price,
      name: fp.floorplanName || fp.name,
    }));
  }

  // Handle DOM-parsed fallback
  if (data.domParsed) {
    return groupByBeds(data.domParsed, fp => ({
      beds: fp.beds,
      min: fp.price, max: fp.price, name: null,
    }));
  }

  return { error: 'unknown entrata format', raw: JSON.stringify(data).substring(0, 200) };
}

// Cortland: confirmed working, uses __NEXT_DATA__ 
// Path: props.pageProps.componentProps.initialReduxState.gdp.building.floorPlans
async function extractCortland(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(1000, 2000));

  const fps = await page.evaluate(() => {
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return null;
    try {
      const data = JSON.parse(nd.textContent);
      return data?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building?.floorPlans || null;
    } catch { return null; }
  });

  if (!fps) return { error: 'no Cortland floorPlans in __NEXT_DATA__' };
  return groupByBeds(fps, fp => ({
    beds: fp.beds, min: fp.minPrice, max: fp.maxPrice, name: fp.name,
  }));
}

// J·Sol: confirmed working, uses custom JS
// Path: same Entrata-style floor plan viewer
async function extractJSol(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2000, 3000)); // needs more time for JS

  // Use the confirmed working approach from debug.js
  const fps = await page.evaluate(() => {
    // Look for floor plan data in any script tags
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      if (s.textContent.includes('floorPlan') || s.textContent.includes('minPrice')) {
        try {
          const match = s.textContent.match(/floorPlans["\s:]+(\[.+?\])/s);
          if (match) return JSON.parse(match[1]);
        } catch {}
      }
    }
    // Fall back to visible floor plan cards
    const cards = [];
    document.querySelectorAll('.floor-plan-card, [data-beds], .floorplan').forEach(el => {
      const text = el.innerText;
      const bedsM = text.match(/(\d)\s*bed/i);
      const priceM = text.match(/\$([\d,]+)/);
      if (bedsM && priceM) {
        cards.push({ beds: parseInt(bedsM[1]), price: parseInt(priceM[1].replace(',','')) });
      }
    });
    return cards.length ? cards : null;
  });

  if (!fps) return { error: 'no JSol floor plan data found' };
  if (fps[0]?.price) {
    return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
  }
  return groupByBeds(fps, fp => ({
    beds: fp.beds, min: fp.minPrice, max: fp.maxPrice, name: fp.name,
  }));
}

// AvalonBay: server-rendered, prices are in HTML
async function extractAvalon(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(1000, 2000));

  const fps = await page.evaluate(() => {
    const results = [];
    // AvalonBay uses data attributes on tier/plan elements
    document.querySelectorAll('[data-bedroom-count], .tiers__bedroom').forEach(el => {
      const beds = parseInt(el.dataset.bedroomCount || el.getAttribute('data-bedroom-count'));
      const priceEl = el.querySelector('[class*="price"], .tiers__price');
      const priceText = priceEl?.textContent || '';
      const price = parseInt(priceText.replace(/[^0-9]/g, ''));
      if (!isNaN(beds) && !isNaN(price) && price > 0) {
        results.push({ beds, price });
      }
    });
    // Also try the header summary (e.g. "2 Bed from $3,459")
    const summaryText = document.body.innerText;
    const matches = summaryText.matchAll(/(\d)\s*Bed\s+from\s+\$([\d,]+)/gi);
    for (const m of matches) {
      results.push({ beds: parseInt(m[1]), price: parseInt(m[2].replace(',', '')) });
    }
    return results;
  });

  if (!fps?.length) return { error: 'no Avalon floor plan data found' };
  return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
}

// Bozzuto: uses custom React app, wait for cards to render
async function extractBozzuto(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
  await sleep(rand(1500, 2500));

  const fps = await page.evaluate(() => {
    const results = [];
    // Bozzuto floor plan cards
    document.querySelectorAll('.FloorPlan, [class*="floorplan"], [class*="floor-plan"]').forEach(el => {
      const text = el.innerText;
      const bedsM = text.match(/(\d)\s*(?:bed|br)/i);
      const priceM = text.match(/(?:from|starting)?\s*\$([\d,]+)/i);
      if (bedsM && priceM) {
        results.push({ beds: parseInt(bedsM[1]), price: parseInt(priceM[1].replace(',', '')) });
      }
    });
    // Try __NEXT_DATA__ as well
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      try {
        const data = JSON.parse(nd.textContent);
        const str = JSON.stringify(data);
        const fp = str.match(/"floorPlans":\[(.+?)\]/);
        if (fp) return { nextDataRaw: fp[1] };
      } catch {}
    }
    return results;
  });

  if (!fps?.length && !fps?.nextDataRaw) return { error: 'no Bozzuto floor plan data' };
  if (fps?.nextDataRaw) {
    try {
      const parsed = JSON.parse(`[${fps.nextDataRaw}]`);
      return groupByBeds(parsed, fp => ({ beds: fp.beds || fp.bedrooms, min: fp.minPrice, max: fp.maxPrice, name: fp.name }));
    } catch {}
  }
  return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
}

// Dittmar: iframe-based (Yardi), try to intercept the iframe API call
async function extractDittmar(page, url) {
  let yardiData = null;

  // Listen for Yardi API responses
  page.on('response', async res => {
    const u = res.url();
    if ((u.includes('yardi') || u.includes('entrata') || u.includes('floorplan')) && 
        res.status() === 200) {
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          yardiData = await res.json();
        }
      } catch {}
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
  await sleep(rand(2000, 3000));

  if (yardiData) {
    // Try to extract from Yardi/Entrata response
    const fps = yardiData?.result?.floorplans || yardiData?.floorplans || [];
    if (fps.length) {
      return groupByBeds(fps, fp => ({
        beds: fp.bedrooms || fp.beds,
        min: fp.priceMin || fp.minPrice,
        max: fp.priceMax || fp.maxPrice,
        name: fp.floorplanName || fp.name,
      }));
    }
  }

  // Fall back to reading visible text from page/iframe
  const text = await page.evaluate(() => document.body.innerText);
  const fps = [];
  const matches = text.matchAll(/(\d)\s*(?:Bed|BR|Bedroom)[^\n]*\n[^\n]*\$([\d,]+)/gi);
  for (const m of matches) {
    fps.push({ beds: parseInt(m[1]), price: parseInt(m[2].replace(',','')) });
  }
  if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));

  return { error: 'Dittmar iframe blocked — try Zillow fallback for these buildings' };
}

// Generic fallback: try to read any visible price + bed count from the page
async function extractGeneric(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2000, 3000));

  const fps = await page.evaluate(() => {
    const text = document.body.innerText;
    const results = [];
    // Match patterns like "2 Bed ... $3,500" or "2BR from $3,500"
    const patterns = [
      /(\d)\s*(?:bed|BR|bedroom)[^\n$]{0,50}\$([\d,]+)/gi,
      /\$([\d,]+)[^\n$]{0,50}(\d)\s*(?:bed|BR|bedroom)/gi,
    ];
    for (const pat of patterns) {
      for (const m of text.matchAll(pat)) {
        const beds = parseInt(m[1]);
        const price = parseInt(m[2].replace(',',''));
        if (!isNaN(beds) && !isNaN(price) && price > 1000 && price < 20000) {
          results.push({ beds, price });
        }
      }
    }
    return results;
  });

  if (!fps?.length) return { error: 'no prices found by generic extractor' };
  return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function groupByBeds(fps, mapper) {
  const byBeds = {};
  for (const fp of fps) {
    const { beds, min, max, name } = mapper(fp);
    if (beds == null || !(min > 0)) continue;
    if (!byBeds[beds]) byBeds[beds] = { mins: [], maxs: [], plans: [] };
    byBeds[beds].mins.push(min);
    byBeds[beds].maxs.push(max || min);
    if (name) byBeds[beds].plans.push(name);
  }

  const result = { all_beds: {}, source: 'official_site' };
  for (const [beds, d] of Object.entries(byBeds)) {
    if (!d.mins.length) continue;
    result.all_beds[`${beds}BR`] = {
      min: Math.min(...d.mins), max: Math.max(...d.maxs), plans: d.plans,
    };
  }
  if (byBeds[2]) {
    result.price2_min   = Math.min(...byBeds[2].mins);
    result.price2_max   = Math.max(...byBeds[2].maxs);
    result.price2_plans = byBeds[2].plans;
  }
  if (byBeds[3]) {
    result.price3_min   = Math.min(...byBeds[3].mins);
    result.price3_max   = Math.max(...byBeds[3].maxs);
    result.price3_plans = byBeds[3].plans;
  }
  return result;
}

// Route to the right extractor
async function extract(page, building) {
  const url  = building.official_url;
  const type = building.scraper?.type;

  if (!url) return { error: 'no official_url configured' };

  try {
    switch (type) {
      case 'cortland': return await extractCortland(page, url);
      case 'avalon':   return await extractAvalon(page, url);
      case 'bozzuto':  return await extractBozzuto(page, url);
      case 'dittmar':  return await extractDittmar(page, url);
      case 'entrata':
      case 'equity':
      case 'akelius':
      case 'millcreek':
      case 'greystar':
        // J·Sol uses its own Entrata install
        if (url.includes('j-solapartments.com')) return await extractJSol(page, url);
        return await extractEntrata(page, url);
      case 'none':     return { error: 'no official site' };
      default:         return await extractGeneric(page, url);
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const singleId  = args.includes('--id')   ? args[args.indexOf('--id') + 1]   : null;
  const typeFilter= args.includes('--type') ? args[args.indexOf('--type') + 1] : null;
  const headful   = args.includes('--headful');
  const startIdx  = args.includes('--start')? parseInt(args[args.indexOf('--start')+1])-1 : 0;

  let targets = BUILDINGS;
  if (singleId)   targets = targets.filter(b => b.id === singleId);
  if (typeFilter) targets = targets.filter(b => b.scraper?.type === typeFilter);
  targets = targets.slice(startIdx);
  targets = targets.filter(b => b.scraper?.type !== 'none' && b.official_url);

  if (!targets.length) {
    console.error('No buildings match filters.');
    console.log('Available ids:', BUILDINGS.map(b=>b.id).join(', '));
    process.exit(1);
  }

  console.log('Connecting to Chrome on port 9222...');
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    console.log('✓ Connected\n');
  } catch (err) {
    console.error(`✗ Could not connect: ${err.message}`);
    console.error('Launch Chrome: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug');
    process.exit(1);
  }

  const contexts = browser.contexts();
  const context  = contexts[0] || await browser.newContext();
  const page     = await context.newPage();

  const outputPath = './prices.json';
  const results    = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : {};
  let success = 0, failed = 0;

  console.log(`🏢 Scraping ${targets.length} buildings from official sites...\n`);

  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    console.log(`[${i+1}/${targets.length}] ${b.name}`);
    console.log(`  ${b.official_url}`);

    const prices = await extract(page, b);
    const result = {
      id: b.id, name: b.name,
      official_url: b.official_url,
      scraper_type: b.scraper?.type,
      scraped_at: new Date().toISOString(),
      ...prices,
    };

    if (result.price2_min) {
      console.log(`  ✓ 2BR $${result.price2_min.toLocaleString()}–$${result.price2_max.toLocaleString()}` +
        (result.price2_plans?.length ? `  plans: ${result.price2_plans.slice(0,5).join(', ')}` : ''));
      if (result.price3_min) console.log(`       3BR $${result.price3_min.toLocaleString()}–$${result.price3_max.toLocaleString()}`);
      success++;
    } else {
      console.log(`  ✗ ${result.error || 'no 2BR found'}`);
      console.log(`     Available: ${Object.keys(result.all_beds || {}).join(', ') || 'none'}`);
      failed++;
    }

    results[b.id] = result;
    writeFileSync(outputPath, JSON.stringify(results, null, 2));

    if (i < targets.length - 1) {
      const delay = rand(3000, 7000);
      await sleep(delay);
    }
  }

  await page.close();

  // ─── SUMMARY ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`✓ ${success} with 2BR prices   ✗ ${failed} failed\n`);

  Object.values(results)
    .filter(r => r.price2_min)
    .sort((a,b) => a.price2_min - b.price2_min)
    .forEach(r => console.log(
      `  ${r.name.padEnd(38)} 2BR $${String(r.price2_min.toLocaleString()).padStart(5)}–$${r.price2_max.toLocaleString()}` +
      (r.price3_min ? `  3BR $${r.price3_min.toLocaleString()}–$${r.price3_max.toLocaleString()}` : '')
    ));

  const errors = Object.values(results).filter(r => r.error);
  if (errors.length) {
    console.log(`\n⚠  Failed (${errors.length}):`);
    errors.forEach(r => console.log(`  ${(r.name||r.id).padEnd(38)} [${r.scraper_type}] ${r.error}`));
    console.log('\nFor failed buildings, try --headful to see what the site renders:');
    console.log('  node scraper_official.js --id <id> --headful');
    console.log('\nOr fall back to Zillow for these:');
    errors.forEach(r => console.log(`  node scraper_cdp.js --id ${r.id}`));
  }
}

main().catch(console.error);
