/**
 * find_urls.js — finds correct Zillow building page URL for each building
 * by searching Zillow with the building's address.
 * 
 * Run ONCE to build the URL registry, then use those URLs in scraper_cdp.js
 * 
 * Usage: node find_urls.js
 * Output: zillow_urls.json
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const BUILDINGS = [
  { id: 'central-place',       name: 'Central Place',                  addr: '1800 N Lynn St Arlington VA' },
  { id: 'cortland-rosslyn',    name: 'Cortland Rosslyn',               addr: '1771 N Pierce St Arlington VA' },
  { id: 'rosslyn-towers',      name: 'Rosslyn Towers',                 addr: '1919 N Nash St Arlington VA' },
  { id: 'rosslyn-heights',     name: 'Rosslyn Heights',                addr: '1804 N Quinn St Arlington VA' },
  { id: 'sedona-slate',        name: 'Sedona | Slate',                 addr: '1510 Clarendon Blvd Arlington VA' },
  { id: '1800-oak',            name: '1800 Oak',                       addr: '1800 N Oak St Arlington VA' },
  { id: 'crestmont',           name: 'The Crestmont',                  addr: '1301 N Rhodes St Arlington VA' },
  { id: 'avalon-courthouse',   name: 'Avalon Courthouse Place',        addr: '1320 N Veitch St Arlington VA' },
  { id: 'courthouse-plaza',    name: 'Courthouse Plaza',               addr: '2250 Clarendon Blvd Arlington VA' },
  { id: 'meridian-courthouse', name: 'Meridian at Courthouse Commons', addr: '1401 N Taft St Arlington VA' },
  { id: 'the-palatine',        name: 'The Palatine',                   addr: '1515 N Courthouse Rd Arlington VA' },
  { id: 'the-prime',           name: 'The Prime at Courthouse',        addr: '1415 N Taft St Arlington VA' },
  { id: 'va-sq-towers',        name: 'Virginia Square Towers',         addr: '3444 Fairfax Dr Arlington VA' },
  { id: 'va-sq-901',           name: 'Virginia Square 901 N Nelson',   addr: '901 N Nelson St Arlington VA' },
  { id: 'latitude',            name: 'Latitude',                       addr: '3601 Fairfax Dr Arlington VA' },
  { id: '4040-wilson',         name: '4040 Wilson',                    addr: '4040 Wilson Blvd Arlington VA' },
  { id: 'j-sol',               name: 'J·Sol',                          addr: '4000 Fairfax Dr Arlington VA' },
  { id: 'view-ballston',       name: 'The View Ballston',              addr: '4000 Wilson Blvd Arlington VA' },
  { id: 'ballston-place',      name: 'Ballston Place',                 addr: '901 N Pollard St Arlington VA' },
  { id: 'quincy-plaza',        name: 'Quincy Plaza',                   addr: '3900 Fairfax Dr Arlington VA' },
  { id: 'ava-ballston',        name: 'AVA Ballston Square',            addr: '850 N Randolph St Arlington VA' },
  { id: 'beacon-clarendon',    name: 'The Beacon Clarendon',           addr: '1128 N Irving St Arlington VA' },
  { id: 'ten-at-clarendon',    name: 'Ten at Clarendon',               addr: '3110 10th St N Arlington VA' },
  { id: 'reserve-clarendon',   name: 'Reserve at Clarendon Centre',    addr: '3000 Washington Blvd Arlington VA' },
  { id: 'modera-clarendon',    name: 'Modera Clarendon',               addr: '3415 Washington Blvd Arlington VA' },
  { id: 'vpoint',              name: 'vPoint',                         addr: '1210 N Highland St Arlington VA' },
  { id: 'hampden-house',       name: 'Hampden House',                  addr: '4700 Hampden Ln Bethesda MD' },
  { id: 'the-charles',         name: 'The Charles',                    addr: '7342 Wisconsin Ave Bethesda MD' },
  { id: 'gallery-bethesda',    name: 'Gallery Bethesda I',             addr: '4800 Auburn Ave Bethesda MD' },
  { id: 'upstairs-bethesda',   name: 'Upstairs at Bethesda Row',       addr: '7131 Arlington Rd Bethesda MD' },
  { id: 'cecil-bethesda',      name: 'Cecil',                          addr: '8015 Old Georgetown Rd Bethesda MD' },
  { id: 'flats-8300',          name: 'Flats 8300',                     addr: '8300 Wisconsin Ave Bethesda MD' },
  { id: 'metropolitan',        name: 'The Metropolitan',               addr: '7620 Old Georgetown Rd Bethesda MD' },
  { id: '7001-arlington',      name: '7001 Arlington at Bethesda',     addr: '7001 Arlington Rd Bethesda MD' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findBuildingUrl(page, building) {
  // Search Zillow for the address — the autocomplete will surface the building page
  const searchUrl = `https://www.zillow.com/search/easy-signup/?searchQueryState={"pagination":{},"isMapVisible":false,"filterState":{"fr":{"value":true},"fsba":{"value":false},"fsbo":{"value":false},"nc":{"value":false},"cmsn":{"value":false},"auc":{"value":false},"fore":{"value":false}}}&searchTerm=${encodeURIComponent(building.addr)}`;

  // Actually, simpler: use Zillow's suggest API directly
  const suggestUrl = `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${encodeURIComponent(JSON.stringify({
    pagination: {},
    isMapVisible: false,
    filterState: { fr: { value: true } },
    isListVisible: true,
  }))}&wants={"cat1":["listResults"]}&requestId=1`;

  // Use the Zillow address-based URL to find building page
  await page.goto(
    `https://www.zillow.com/homes/for_rent/${encodeURIComponent(building.addr)}_rb/`,
    { waitUntil: 'domcontentloaded', timeout: 20000 }
  );
  await sleep(1000);

  // Look for a building page link in the results
  const buildingUrl = await page.evaluate((name) => {
    // Find links to /apartments/ pages
    const links = Array.from(document.querySelectorAll('a[href*="/apartments/"]'));
    if (links.length > 0) return links[0].href;

    // Also check __NEXT_DATA__ for building links
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return null;
    const data = JSON.parse(nd.textContent);
    const results = data?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
    if (!results) return null;

    for (const r of results) {
      if (r.detailUrl?.includes('/apartments/')) return 'https://www.zillow.com' + r.detailUrl;
    }
    return null;
  }, building.name);

  return buildingUrl;
}

async function main() {
  console.log('Connecting to Chrome on port 9222...');
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    console.log('✓ Connected\n');
  } catch (err) {
    console.error(`✗ Could not connect: ${err.message}`);
    console.error('Launch Chrome with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug');
    process.exit(1);
  }

  const contexts = browser.contexts();
  const context  = contexts[0] || await browser.newContext();
  const page     = await context.newPage();

  const outputPath = './zillow_urls.json';
  const results    = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : {};

  console.log(`Finding Zillow URLs for ${BUILDINGS.length} buildings...\n`);

  for (let i = 0; i < BUILDINGS.length; i++) {
    const b = BUILDINGS[i];

    // Skip already found
    if (results[b.id]?.url) {
      console.log(`[${i+1}/${BUILDINGS.length}] ${b.name.padEnd(38)} ✓ already found`);
      continue;
    }

    process.stdout.write(`[${i+1}/${BUILDINGS.length}] ${b.name.padEnd(38)} `);

    try {
      // Use Zillow's building search via address
      const searchUrl = `https://www.zillow.com/homes/for_rent/${encodeURIComponent(b.addr + ' for_rent')}/`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(800 + Math.random() * 400);

      // Extract all /apartments/ links from the page
      const links = await page.evaluate(() => {
        const nd = document.getElementById('__NEXT_DATA__');
        if (!nd) return [];
        try {
          const data = JSON.parse(nd.textContent);
          const results =
            data?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults ||
            data?.props?.pageProps?.initialData?.cat1?.searchResults?.listResults || [];
          return results
            .filter(r => r.detailUrl?.includes('/apartments/'))
            .map(r => ({ url: 'https://www.zillow.com' + r.detailUrl, name: r.statusText || r.address }));
        } catch { return []; }
      });

      if (links.length > 0) {
        results[b.id] = { id: b.id, name: b.name, addr: b.addr, url: links[0].url, zillow_name: links[0].name };
        console.log(`→ ${links[0].url.split('/').slice(-2).join('/')}`);
      } else {
        // Try direct URL navigation — Zillow's address search isn't reliable
        // Fall back to their suggest/autocomplete endpoint
        const apiUrl = await page.evaluate(async (addr) => {
          const r = await fetch(`https://www.zillow.com/search/GetAutoCompleteSuggestions?q=${encodeURIComponent(addr)}&abKey=abc`);
          if (!r.ok) return null;
          const d = await r.json();
          const apt = d?.results?.find(x => x?.url?.includes('/apartments/'));
          return apt?.url ? 'https://www.zillow.com' + apt.url : null;
        }, b.addr);

        if (apiUrl) {
          results[b.id] = { id: b.id, name: b.name, addr: b.addr, url: apiUrl };
          console.log(`→ ${apiUrl.split('/').slice(-2).join('/')}`);
        } else {
          results[b.id] = { id: b.id, name: b.name, addr: b.addr, url: null, error: 'not found' };
          console.log(`✗ not found`);
        }
      }
    } catch (err) {
      results[b.id] = { id: b.id, name: b.name, addr: b.addr, url: null, error: err.message };
      console.log(`✗ ${err.message}`);
    }

    writeFileSync(outputPath, JSON.stringify(results, null, 2));

    // Human-like delay — vary between requests
    if (i < BUILDINGS.length - 1) {
      const delay = 3000 + Math.random() * 3000;
      await sleep(delay);
    }
  }

  await page.close();

  console.log(`\nResults saved to ${outputPath}`);
  console.log(`Found: ${Object.values(results).filter(r => r.url).length}/${BUILDINGS.length}`);
  console.log(`\nNext: update BUILDINGS array in scraper_cdp.js with these URLs`);
}

main().catch(console.error);
