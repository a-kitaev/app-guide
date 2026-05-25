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
// Entrata renders floor plans as JSON in window.__ENTRATA_DATA__ after JS loads.
// Newer Entrata UI variants render floor plans in the DOM with a bed-count filter tab.
async function extractEntrata(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(1500, 2500));

  // Try window.__ENTRATA_DATA__ first (fastest)
  const data = await page.evaluate(() => {
    if (window.__ENTRATA_DATA__) return window.__ENTRATA_DATA__;
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

  if (data) {
    if (data.result?.floorplans || data.floorplans) {
      const fps = data.result?.floorplans || data.floorplans;
      return groupByBeds(fps, fp => ({
        beds: fp.bedrooms || fp.beds,
        min: fp.priceMin || fp.minPrice || fp.price,
        max: fp.priceMax || fp.maxPrice || fp.price,
        name: fp.floorplanName || fp.name,
      }));
    }
    if (data.domParsed) {
      return groupByBeds(data.domParsed, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
    }
  }

  // Newer Entrata UI: bed-count filter tabs + "N bd / N ba … From $X/month" cards
  // Click each bed tab and collect the minimum visible price
  const allFps = [];
  for (const beds of [1, 2, 3]) {
    const clicked = await page.evaluate((beds) => {
      const all = Array.from(document.querySelectorAll('button, [role="button"], span, a, li'));
      // Match "2 BED" or "2 Bed" tab labels (standalone, no extra content)
      const tab = all.find(el => el.children.length === 0 && new RegExp(`^${beds}\\s*BED`, 'i').test((el.textContent || '').trim()));
      if (tab) { tab.click(); return true; }
      return false;
    }, beds);
    if (!clicked) continue;
    await sleep(1500);

    const prices = await page.evaluate(() => {
      const text = document.body.innerText;
      // Match "From $3,150/month" or "From $3,150.00/month"
      return [...text.matchAll(/From \$([\d,]+(?:\.\d+)?)\/month/gi)]
        .map(m => Math.round(parseFloat(m[1].replace(/,/g, ''))))
        .filter(p => p > 500);
    });
    if (prices.length) {
      allFps.push({ beds, price: Math.min(...prices) });
    }
  }
  if (allFps.length) return groupByBeds(allFps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));

  return { error: 'no entrata data found' };
}

// Cortland: "N Bed from $X,XXX including fees" summary visible in page text
async function extractCortland(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(1500, 2500));

  // Try __NEXT_DATA__ first (may still exist on some Cortland pages)
  const fromNext = await page.evaluate(() => {
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return null;
    try {
      const data = JSON.parse(nd.textContent);
      return data?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building?.floorPlans || null;
    } catch { return null; }
  });
  if (fromNext?.length) {
    return groupByBeds(fromNext, fp => ({
      beds: fp.beds, min: fp.minPrice, max: fp.maxPrice, name: fp.name,
    }));
  }

  // DOM text fallback: "N Bed from $X,XXX including fees" in header/summary
  const fps = await page.evaluate(() => {
    const text = document.body.innerText;
    const results = [];
    for (const m of text.matchAll(/(\d+)\s*[Bb]ed\s+from\s+\$([\d,]+)/g)) {
      const beds = parseInt(m[1]);
      const price = parseInt(m[2].replace(/,/g, ''));
      if (!isNaN(beds) && price > 100) results.push({ beds, price });
    }
    return results;
  });

  if (!fps?.length) return { error: 'no Cortland floor plan data found' };
  return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
}

// Jonah Digital widget platform — two backend variants:
//   Knock CRM (e.g. J·Sol): data via doorway-api.knockrentals.com/v1/property/*/units
//   Other (e.g. Gallery Bethesda): data rendered as visible text in the widget listing
async function extractJonah(page, url) {
  let unitsData = null;

  // Try intercepting Knock CRM units API (fired automatically by the widget)
  const handler = async res => {
    const u = res.url();
    if (u.includes('knockrentals.com') && u.includes('/units')) {
      try {
        const json = await res.json();
        if (json?.units_data?.units?.length) unitsData = json.units_data.units;
      } catch {}
    }
  };
  page.on('response', handler);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(5000, 7000));

  // Some Jonah sites (e.g. Hampden House) default to a Map tab — switch to Floorplans listing view
  await page.evaluate(() => {
    const listingTab = document.querySelector('[data-jd-fp-selector="tab"][data-tab="listing"]');
    if (listingTab) listingTab.click();
  });
  await sleep(rand(2000, 3000));
  page.off('response', handler);

  if (!unitsData) {
    // Knock API may have failed; re-fetch from page context so Origin header is set correctly
    unitsData = await page.evaluate(async () => {
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        let communityId = null;
        for (const s of scripts) {
          const m = s.textContent.match(/JonahWidget\.knock\(\{init:\['[^']+','community','([^']+)'\]\}\)/);
          if (m) { communityId = m[1]; break; }
        }
        if (!communityId) return null;
        const r1 = await fetch(`https://doorway-api.knockrentals.com/v1/property/community/${communityId}`);
        const d1 = await r1.json();
        const propId = d1?.property?.id;
        if (!propId) return null;
        const r2 = await fetch(`https://doorway-api.knockrentals.com/v1/property/${propId}/units`);
        const d2 = await r2.json();
        return d2?.units_data?.units || null;
      } catch { return null; }
    });
  }

  if (unitsData?.length) {
    const fps = unitsData
      .filter(u => !u.deletedAt && parseInt(u.price || 0) > 100)
      .map(u => ({ beds: u.bedrooms, price: parseInt(u.price) }));
    if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
  }

  // Fallback: parse the Jonah widget's rendered text listing (Yardi/other backends)
  // Format A (Gallery Bethesda): "[name]\n[N] bed\n[N] bath\n[sq]\nStarting at $[price]"
  // Format B (The Charles): "[code]\n[N] bed\n[N] bath\n[sq]\nN months$[price] Base Rent"
  const fps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const bedsMatch = lines[i].match(/^(\d+)\s+bed(?:room)?s?$/i);
      if (!bedsMatch) continue;
      const beds = parseInt(bedsMatch[1]);
      for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
        if (lines[j].match(/^\d+\s+bed(?:room)?s?$/i)) break; // next plan started
        const startingAt = lines[j].match(/Starting at \$([\d,]+)/i);
        if (startingAt) { results.push({ beds, price: parseInt(startingAt[1].replace(/,/g, '')) }); break; }
        const baseRent = lines[j].match(/(?:\d+\s*months)?\$([\d,]+)(?:\.\d+)?(?:\s*-\s*\$[\d,]+(?:\.\d+)?)?\s*Base Rent/i);
        if (baseRent) { results.push({ beds, price: parseInt(baseRent[1].replace(/,/g, '')) }); break; }
      }
    }
    return results;
  });

  if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));

  return { error: 'no Jonah floor plan data found' };
}

// Nestio (livewithlatitude.com style): custom React app, prices visible in DOM text
// Format per plan: "[Name]\n[N] BR / [N] BA, [sq] sq ft\nfrom $[price]*\nBase Rent $[base]..."
async function extractNestio(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await sleep(rand(3000, 4000));

  const fps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const bedsMatch = lines[i].match(/^(\d+)\s*BR\s*\/\s*\d+\s*BA/);
      if (!bedsMatch) continue;
      const beds = parseInt(bedsMatch[1]);
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const priceMatch = lines[j].match(/from\s*\$([\d,]+)/i);
        if (priceMatch) {
          results.push({ beds, price: parseInt(priceMatch[1].replace(',', '')) });
          break;
        }
        if (lines[j].match(/^\d+\s*BR\s*\//)) break;
      }
    }
    return results;
  });

  if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
  return { error: 'no Nestio floor plan data found' };
}

// RealPage CWS (e.g. vPoint): ASP.NET site, all floor plans stored as data-bed/data-rent attributes
async function extractRealPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(rand(3000, 5000));

  const fps = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('[data-bed][data-rent]').forEach(el => {
      const beds = parseInt(el.dataset.bed);
      const rent = parseFloat(el.dataset.rent);
      if (!isNaN(beds) && !isNaN(rent) && rent > 100) {
        results.push({ beds, price: Math.round(rent) });
      }
    });
    return results;
  });

  if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
  return { error: 'no RealPage floor plan data found' };
}

// Equity Residential: page shows "N Bed\n$X,XXX+" summary at top; parse pairs
async function extractEquity(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(4000, 6000));

  const fps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const bedsM = lines[i].match(/^(\d+)\s*Beds?$/i);
      if (!bedsM) continue;
      const beds = parseInt(bedsM[1]);
      const priceM = (lines[i + 1] || '').match(/^\$([\d,]+)/);
      if (priceM) results.push({ beds, price: parseInt(priceM[1].replace(/,/g, '')) });
    }
    return results;
  });

  if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
  return { error: 'no Equity floor plan data found' };
}

// MillCreek Residential: click N-BEDROOM or N BED filter tab, extract "Starting from $X/month" or "From $X/month"
async function extractMillCreek(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2000, 3000));

  const allFps = [];
  for (const beds of [1, 2, 3]) {
    const clicked = await page.evaluate((beds) => {
      const all = Array.from(document.querySelectorAll('*'));
      const tab = all.find(el => {
        const t = (el.textContent || '').trim();
        return new RegExp(`^${beds}[-\\s]?(?:BED(?:ROOM)?S?|BR)$`, 'i').test(t);
      });
      if (tab) { tab.click(); return true; }
      return false;
    }, beds);
    if (!clicked) continue;
    await sleep(1500);

    const prices = await page.evaluate(() => {
      const text = document.body.innerText;
      const found = [];
      for (const m of text.matchAll(/(?:Starting from|From)\s+\$([\d,]+(?:\.\d+)?)\/month/gi))
        found.push(parseInt(m[1].replace(/,/g, '')));
      for (const m of text.matchAll(/^\$([\d,]+(?:\.\d+)?)\/month$/gm))
        found.push(parseInt(m[1].replace(/,/g, '')));
      return found.filter(p => p > 500);
    });
    if (prices.length) allFps.push({ beds, min: Math.min(...prices), max: Math.max(...prices) });
  }

  if (allFps.length) return groupByBeds(allFps, fp => ({ beds: fp.beds, min: fp.min, max: fp.max, name: null }));

  // Fallback: card-based format "N Bed, N Bath, XXX SqFt\n...\nFrom $X,XXX per month"
  const cardFps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const bedsM = lines[i].match(/^(\d+)\s+Bed,?\s+\d+\s+Bath/i);
      if (!bedsM) continue;
      const beds = parseInt(bedsM[1]);
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const priceM = lines[j].match(/^From \$([\d,]+(?:\.\d+)?)\s+per month/i);
        if (priceM) { results.push({ beds, price: parseInt(priceM[1].replace(/,/g, '')) }); break; }
      }
    }
    return results;
  });
  if (cardFps.length) return groupByBeds(cardFps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));

  return { error: 'no MillCreek floor plan data found' };
}

// AvalonBay: intercept the community-units API (fires on page load)
// Response has unitsSummary.totalPricesStartingAt keyed by bedroom count
async function extractAvalon(page, url) {
  let unitsSummary = null;
  const handler = async res => {
    if (res.url().includes('community-units')) {
      try {
        const json = await res.json();
        if (json?.unitsSummary) unitsSummary = json.unitsSummary;
      } catch {}
    }
  };
  page.on('response', handler);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await sleep(rand(2000, 3000));
  page.off('response', handler);

  if (unitsSummary?.totalPricesStartingAt) {
    const fps = [];
    for (const [beds, priceData] of Object.entries(unitsSummary.totalPricesStartingAt)) {
      const price = priceData.onDemand;
      if (price) fps.push({ beds: parseInt(beds), price });
    }
    if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
  }

  // DOM fallback: "N BEDROOM FROM\n$X,XXX" (two-line format on Avalon sites)
  const fps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const bedsM = lines[i].match(/^(\d+)\s*bed(?:room)?s?\s+from$/i);
      if (!bedsM) continue;
      const beds = parseInt(bedsM[1]);
      const priceM = (lines[i + 1] || '').match(/^\$([\d,]+)/);
      if (priceM) results.push({ beds, price: parseInt(priceM[1].replace(/,/g, '')) });
    }
    return results;
  });

  if (!fps?.length) return { error: 'no Avalon floor plan data found' };
  return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
}

// Bozzuto: custom platform, shows available units with bed type + "Base Rent" price in DOM
// Two DOM formats observed:
//   Format A (4040 Wilson): "APT. XXXX\nN bedrooms • N Bath\nXXX SF\n$X,XXX.XX/mo*\n$X,XXX Base Rent"
//   Format B (theviewapartments): "XXXX\nN BEDROOMS |N BATH\nXXX SF | $X.XX/MO* | $X,XXX BASE RENT | AVAILABLE"
async function extractBozzuto(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await sleep(rand(2000, 3000));

  // Try to open the BEDROOMS filter dropdown and select "Two Bedrooms"
  // (Sites like 4040 Wilson paginate by bedroom type; without filtering only studios/1BRs show)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const bedroomsBtn = btns.find(b => /^BEDROOMS$|^Bedrooms$/i.test((b.textContent || '').trim()));
    if (bedroomsBtn) bedroomsBtn.click();
  });
  await sleep(800);
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const match = all.find(el => el.children.length === 0 && /^Two Bedrooms?$/i.test((el.textContent || '').trim()));
    if (match) match.click();
  });
  await sleep(rand(2000, 3000));

  // Click LOAD MORE until it disappears (up to 6 times)
  for (let n = 0; n < 6; n++) {
    const clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a'));
      const btn = all.find(el => /^LOAD MORE$/i.test((el.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await sleep(1500);
  }

  const fps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      // Match "2 bedrooms • 2 Bath", "2 BEDROOMS |2 BATH", or "2 Bed/2 Bath"
      const bedsM = lines[i].match(/^(\d+)\s*bed(?:room)?s?(?:\s|[•|/])/i);
      if (!bedsM) continue;
      const beds = parseInt(bedsM[1]);
      let price = null;
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        // Check each |-separated segment for "Base Rent" (more accurate than /mo*)
        for (const seg of lines[j].split('|')) {
          const baseM = seg.match(/\$([\d,]+)\s+[Bb]ase\s+[Rr]ent/);
          if (baseM) { price = parseInt(baseM[1].replace(/,/g, '')); break; }
        }
        if (price) break;
        // Fallback: /mo price
        const moM = lines[j].match(/\$([\d,]+(?:\.\d+)?)\s*\/mo/i);
        if (moM) { price = Math.round(parseFloat(moM[1].replace(/,/g, ''))); break; }
      }
      if (price && beds >= 1) results.push({ beds, price });
    }
    return results;
  });

  if (!fps?.length) return { error: 'no Bozzuto floor plan data found' };
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

// RentCafe: intercepts mmccdn.com feed JSON (has per-unit Beds/MinimumRent/MaximumRent),
// or falls back to RentCafe DOM text format:
//   "N Bed - N Bath | PLANCODE" (title line)
//   ... (a few detail lines)
//   "Starting at $X,XXX.XX" (price line, up to 15 lines after title)
async function extractRentCafe(page, url) {
  let feedData = null;
  const handler = async res => {
    const u = res.url();
    if ((u.includes('mmccdn.com') || u.includes('rentcafe.com/wp')) && u.endsWith('.json')) {
      try {
        const json = await res.json();
        if (json?.floorplans) feedData = json.floorplans;
      } catch {}
    }
  };
  page.on('response', handler);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await sleep(rand(3000, 5000));
  page.off('response', handler);

  if (feedData) {
    const fps = Object.values(feedData)
      .map(u => ({ beds: parseInt(u.Beds), min: Math.round(parseFloat(u.MinimumRent)), max: Math.round(parseFloat(u.MaximumRent)) }))
      .filter(fp => !isNaN(fp.beds) && fp.min > 100);
    if (fps.length) return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.min, max: fp.max, name: null }));
  }

  // DOM fallback #1 (RentCafe.com): "N Bed - N Bath | PLANCODE" then "Starting at $X,XXX.XX"
  let fps = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const bedsM = lines[i].match(/^(\d+)\s*Bed\s*-\s*\d+\s*Bath\s*\|/i);
      if (!bedsM) continue;
      const beds = parseInt(bedsM[1]);
      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        if (lines[j].match(/^\d+\s*Bed\s*-\s*\d+\s*Bath\s*\|/i)) break;
        const priceM = lines[j].match(/^Starting at \$([\d,]+(?:\.\d+)?)/i);
        if (priceM) { results.push({ beds, price: Math.round(parseFloat(priceM[1].replace(/,/g, ''))) }); break; }
      }
    }
    return results;
  });

  // DOM fallback #2 (Akelius/RentCafe): "N Bedroom N Bathroom\n...\nStarting at $X,XXX.XX"
  if (!fps?.length) {
    fps = await page.evaluate(() => {
      const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      const results = [];
      for (let i = 0; i < lines.length; i++) {
        const bedsM = lines[i].match(/^(\d+)\s+Bedroom/i);
        if (!bedsM) continue;
        const beds = parseInt(bedsM[1]);
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          if (lines[j].match(/^\d+\s+Bedroom/i)) break;
          const priceM = lines[j].match(/^Starting at \$([\d,]+(?:\.\d+)?)/i);
          if (priceM) { results.push({ beds, price: Math.round(parseFloat(priceM[1].replace(/,/g, ''))) }); break; }
        }
      }
      return results;
    });
  }

  if (!fps?.length) return { error: 'no RentCafe floor plan data found' };
  return groupByBeds(fps, fp => ({ beds: fp.beds, min: fp.price, max: fp.price, name: null }));
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
      case 'jonah':     return await extractJonah(page, url);
      case 'nestio':    return await extractNestio(page, url);
      case 'realpage':  return await extractRealPage(page, url);
      case 'rentcafe':  return await extractRentCafe(page, url);
      case 'equity':    return await extractEquity(page, url);
      case 'millcreek': return await extractMillCreek(page, url);
      case 'entrata':
      case 'akelius':
      case 'greystar':
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
