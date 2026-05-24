/**
 * Zillow Price Scraper — CDP edition with human-like behavior
 * 
 * Fixes:
 *  - Longer randomized delays (5–12s between requests)
 *  - Random mouse movement + scroll on each page
 *  - Visits zillow homepage between every 5 buildings to reset session
 *  - Loads URLs from zillow_urls.json (run find_urls.js first)
 * 
 * Usage:
 *   node find_urls.js              # find correct URLs first (run once)
 *   node scraper_cdp.js            # scrape all
 *   node scraper_cdp.js --id ava-ballston
 *   node scraper_cdp.js --start 5  # resume from building #5
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';

// Load URLs from find_urls.js output, fall back to known-good hardcoded ones
function loadBuildings() {
  const urlMap = existsSync('./zillow_urls.json')
    ? JSON.parse(readFileSync('./zillow_urls.json', 'utf8'))
    : {};

  // Hardcoded fallbacks — only ava-ballston is 100% confirmed
  const FALLBACK_URLS = {
    'ava-ballston': 'https://www.zillow.com/apartments/arlington-va/ava-ballston-square/5XhvC5/',
  };

  const ALL = [
    { id: 'central-place',       name: 'Central Place' },
    { id: 'cortland-rosslyn',    name: 'Cortland Rosslyn' },
    { id: 'rosslyn-towers',      name: 'Rosslyn Towers' },
    { id: 'rosslyn-heights',     name: 'Rosslyn Heights' },
    { id: 'sedona-slate',        name: 'Sedona | Slate' },
    { id: '1800-oak',            name: '1800 Oak' },
    { id: 'crestmont',           name: 'The Crestmont' },
    { id: 'avalon-courthouse',   name: 'Avalon Courthouse Place' },
    { id: 'courthouse-plaza',    name: 'Courthouse Plaza' },
    { id: 'meridian-courthouse', name: 'Meridian at Courthouse Commons' },
    { id: 'the-palatine',        name: 'The Palatine' },
    { id: 'the-prime',           name: 'The Prime at Courthouse' },
    { id: 'va-sq-towers',        name: 'Virginia Square Towers' },
    { id: 'va-sq-901',           name: 'Virginia Square (901 N Nelson)' },
    { id: 'latitude',            name: 'Latitude' },
    { id: '4040-wilson',         name: '4040 Wilson' },
    { id: 'j-sol',               name: 'J·Sol' },
    { id: 'view-ballston',       name: 'The View Ballston' },
    { id: 'ballston-place',      name: 'Ballston Place' },
    { id: 'quincy-plaza',        name: 'Quincy Plaza' },
    { id: 'ava-ballston',        name: 'AVA Ballston Square' },
    { id: 'beacon-clarendon',    name: 'The Beacon Clarendon' },
    { id: 'ten-at-clarendon',    name: 'Ten at Clarendon' },
    { id: 'reserve-clarendon',   name: 'Reserve at Clarendon Centre' },
    { id: 'modera-clarendon',    name: 'Modera Clarendon' },
    { id: 'vpoint',              name: 'vPoint' },
    { id: 'hampden-house',       name: 'Hampden House' },
    { id: 'the-charles',         name: 'The Charles' },
    { id: 'gallery-bethesda',    name: 'Gallery Bethesda I' },
    { id: 'upstairs-bethesda',   name: 'Upstairs at Bethesda Row' },
    { id: 'cecil-bethesda',      name: 'Cecil' },
    { id: 'flats-8300',          name: 'Flats 8300' },
    { id: 'metropolitan',        name: 'The Metropolitan' },
    { id: '7001-arlington',      name: '7001 Arlington at Bethesda' },
  ];

  return ALL.map(b => ({
    ...b,
    url: urlMap[b.id]?.url || FALLBACK_URLS[b.id] || null,
  }));
}

// ─── PRICE EXTRACTION ────────────────────────────────────────────────────────
// Confirmed path: props.pageProps.componentProps.initialReduxState.gdp.building.floorPlans

function extractPrices(nextData) {
  const floorPlans =
    nextData?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building?.floorPlans;
  if (!floorPlans?.length) return null;

  const byBeds = {};
  for (const fp of floorPlans) {
    const beds = fp.beds;
    if (beds == null || !(fp.minPrice > 0)) continue;
    if (!byBeds[beds]) byBeds[beds] = { mins: [], maxs: [], baseMins: [], baseMaxs: [], plans: [] };
    byBeds[beds].mins.push(fp.minPrice);
    byBeds[beds].maxs.push(fp.maxPrice);
    if (fp.minBaseRent > 0) byBeds[beds].baseMins.push(fp.minBaseRent);
    if (fp.maxBaseRent > 0) byBeds[beds].baseMaxs.push(fp.maxBaseRent);
    byBeds[beds].plans.push(fp.name);
  }

  const result = { all_beds: {} };
  for (const [beds, d] of Object.entries(byBeds)) {
    result.all_beds[`${beds}BR`] = {
      min: Math.min(...d.mins), max: Math.max(...d.maxs), plans: d.plans,
    };
  }
  if (byBeds[2]) {
    result.price2_min      = Math.min(...byBeds[2].mins);
    result.price2_max      = Math.max(...byBeds[2].maxs);
    result.price2_base_min = byBeds[2].baseMins.length ? Math.min(...byBeds[2].baseMins) : null;
    result.price2_base_max = byBeds[2].baseMaxs.length ? Math.max(...byBeds[2].baseMaxs) : null;
    result.price2_plans    = byBeds[2].plans;
  }
  if (byBeds[3]) {
    result.price3_min   = Math.min(...byBeds[3].mins);
    result.price3_max   = Math.max(...byBeds[3].maxs);
    result.price3_plans = byBeds[3].plans;
  }
  return result;
}

// ─── HUMAN-LIKE BEHAVIOR ─────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function humanize(page) {
  // Random scroll to simulate reading
  const scrollAmount = rand(200, 600);
  await page.mouse.wheel(0, scrollAmount);
  await sleep(rand(300, 700));

  // Random mouse move
  await page.mouse.move(rand(200, 900), rand(200, 600));
  await sleep(rand(200, 500));
}

async function cooldown(i, total) {
  // Base delay: 5–10s between every request
  const base = rand(5000, 10000);
  // Extra long pause every 5 buildings (20–35s) to simulate a break
  const extra = (i > 0 && i % 5 === 0) ? rand(20000, 35000) : 0;
  const total_delay = base + extra;

  if (extra > 0) {
    console.log(`  ~ Taking a longer break (${Math.round(total_delay/1000)}s)...`);
  }
  await sleep(total_delay);
}

async function resetSession(page) {
  // Visit zillow homepage to refresh cookies and look like a normal user
  await page.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(rand(2000, 4000));
  await humanize(page);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const singleId = args.includes('--id')    ? args[args.indexOf('--id') + 1]    : null;
  const startIdx = args.includes('--start') ? parseInt(args[args.indexOf('--start') + 1]) - 1 : 0;

  const allBuildings = loadBuildings();
  let targets = singleId ? allBuildings.filter(b => b.id === singleId) : allBuildings.slice(startIdx);

  // Skip buildings with no URL
  const noUrl = targets.filter(b => !b.url);
  if (noUrl.length) {
    console.log(`⚠  ${noUrl.length} buildings have no URL yet — run find_urls.js first:`);
    noUrl.forEach(b => console.log(`   ${b.id}`));
    targets = targets.filter(b => b.url);
    console.log('');
  }

  if (!targets.length) {
    console.error('No buildings to scrape.');
    process.exit(1);
  }

  console.log('Connecting to Chrome on port 9222...');
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    console.log('✓ Connected\n');
  } catch (err) {
    console.error(`✗ Could not connect: ${err.message}`);
    console.error('\nLaunch Chrome with:');
    console.error('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug');
    process.exit(1);
  }

  const contexts = browser.contexts();
  const context  = contexts[0] || await browser.newContext();
  const page     = await context.newPage();

  // Warm up
  process.stdout.write('Warming up session... ');
  await resetSession(page);
  console.log('ready.\n');

  console.log(`🏢 Scraping ${targets.length} building(s)...\n`);

  const outputPath = './prices.json';
  const results    = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : {};
  let success = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    const globalIdx = startIdx + i;
    console.log(`[${globalIdx + 1}/${allBuildings.length}] ${b.name}`);

    // Reset session every 5 buildings
    if (i > 0 && i % 5 === 0) {
      process.stdout.write('  ~ Resetting session... ');
      await resetSession(page);
      console.log('done');
    }

    const result = {
      id: b.id, name: b.name, zillow_url: b.url,
      scraped_at: new Date().toISOString(), source: 'zillow_building_page',
    };

    try {
      await page.goto(b.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(rand(800, 1500));
      await humanize(page);

      const title = await page.title();
      if (title.toLowerCase().includes('access') && title.toLowerCase().includes('denied')) {
        result.error = 'bot detection';
        console.log(`  ✗ Bot detection`);
      } else {
        const finalUrl = page.url();
        const expectedSlug = b.url.split('/').slice(-2, -1)[0];
        if (!finalUrl.includes(expectedSlug)) {
          result.warning = `redirected → ${finalUrl}`;
          console.log(`  ⚠  Redirected: ${finalUrl}`);
        }

        const nextData = await page.evaluate(() => {
          const el = document.getElementById('__NEXT_DATA__');
          return el ? JSON.parse(el.textContent) : null;
        });

        if (!nextData) {
          result.error = 'no __NEXT_DATA__';
          console.log(`  ✗ No __NEXT_DATA__`);
        } else {
          const prices = extractPrices(nextData);
          if (!prices) {
            result.error = 'no floorPlans';
            const gdp = nextData?.props?.pageProps?.componentProps?.initialReduxState?.gdp;
            console.log(`  ✗ No floorPlans — gdp keys: ${Object.keys(gdp || {}).join(', ')}`);
          } else {
            Object.assign(result, prices);
            if (result.price2_min) {
              console.log(`  ✓ 2BR $${result.price2_min.toLocaleString()}–$${result.price2_max.toLocaleString()}  plans: ${result.price2_plans.join(', ')}`);
            } else {
              console.log(`  ~ No 2BR. Available: ${Object.keys(result.all_beds).join(', ')}`);
            }
            if (result.price3_min) console.log(`       3BR $${result.price3_min.toLocaleString()}–$${result.price3_max.toLocaleString()}`);
          }
        }
      }
    } catch (err) {
      result.error = err.message;
      console.log(`  ✗ ${err.message}`);
    }

    result.price2_min ? success++ : failed++;
    results[b.id] = result;
    writeFileSync(outputPath, JSON.stringify(results, null, 2));

    if (i < targets.length - 1) await cooldown(i + 1, targets.length);
  }

  await page.close();

  console.log(`\n${'─'.repeat(65)}`);
  console.log(`✓ ${success} with 2BR prices   ✗ ${failed} failed\n`);

  Object.values(results)
    .filter(r => r.price2_min)
    .sort((a, b) => a.price2_min - b.price2_min)
    .forEach(r => console.log(
      `  ${r.name.padEnd(38)} 2BR $${String(r.price2_min.toLocaleString()).padStart(5)}–$${r.price2_max.toLocaleString()}` +
      (r.price3_min ? `  3BR $${r.price3_min.toLocaleString()}–$${r.price3_max.toLocaleString()}` : '')
    ));

  const errors = Object.values(results).filter(r => r.error);
  if (errors.length) {
    console.log(`\n⚠  Failed (${errors.length}):`);
    errors.forEach(r => console.log(`  ${r.name.padEnd(38)} ${r.error}`));
    console.log(`\nTo resume: node scraper_cdp.js --start ${startIdx + success + 1}`);
  }
}

main().catch(console.error);
