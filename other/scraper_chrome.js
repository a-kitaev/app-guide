/**
 * Fallback scraper using your real installed Chrome (not Playwright's Chromium)
 * Real Chrome has valid fingerprints that pass Zillow's bot detection.
 * 
 * Usage: node scraper_chrome.js --id ava-ballston
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// Find real Chrome on macOS
function findChrome() {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const p of paths) {
    try { execSync(`test -f "${p}"`); return p; } catch {}
  }
  return null;
}

const BUILDINGS = [
  { id: 'ava-ballston',        name: 'AVA Ballston Square',            url: 'https://www.zillow.com/apartments/arlington-va/ava-ballston-square/5XhvC5/' },
  { id: 'central-place',       name: 'Central Place',                  url: 'https://www.zillow.com/apartments/arlington-va/central-place/5XjG2n/' },
  { id: 'cortland-rosslyn',    name: 'Cortland Rosslyn',               url: 'https://www.zillow.com/apartments/arlington-va/cortland-rosslyn/5XjzBz/' },
  { id: 'rosslyn-towers',      name: 'Rosslyn Towers',                 url: 'https://www.zillow.com/apartments/arlington-va/rosslyn-towers/5XhDWx/' },
  { id: 'rosslyn-heights',     name: 'Rosslyn Heights',                url: 'https://www.zillow.com/apartments/arlington-va/rosslyn-heights/5XjZMD/' },
  { id: 'sedona-slate',        name: 'Sedona | Slate',                 url: 'https://www.zillow.com/apartments/arlington-va/sedona-slate/5XjFCy/' },
  { id: '1800-oak',            name: '1800 Oak',                       url: 'https://www.zillow.com/apartments/arlington-va/1800-oak/5XhvBG/' },
  { id: 'crestmont',           name: 'The Crestmont',                  url: 'https://www.zillow.com/apartments/arlington-va/the-crestmont/5XjKmN/' },
  { id: 'avalon-courthouse',   name: 'Avalon Courthouse Place',        url: 'https://www.zillow.com/apartments/arlington-va/avalon-courthouse-place/5XjBnZ/' },
  { id: 'courthouse-plaza',    name: 'Courthouse Plaza',               url: 'https://www.zillow.com/apartments/arlington-va/courthouse-plaza/5XjNfX/' },
  { id: 'meridian-courthouse', name: 'Meridian at Courthouse Commons', url: 'https://www.zillow.com/apartments/arlington-va/meridian-at-courthouse-commons/5XjPqW/' },
  { id: 'the-palatine',        name: 'The Palatine',                   url: 'https://www.zillow.com/apartments/arlington-va/the-palatine/5XjQmP/' },
  { id: 'the-prime',           name: 'The Prime at Courthouse',        url: 'https://www.zillow.com/apartments/arlington-va/the-prime-at-arlington-courthouse/5XjRnQ/' },
  { id: 'va-sq-towers',        name: 'Virginia Square Towers',         url: 'https://www.zillow.com/apartments/arlington-va/virginia-square-towers/5XjLkV/' },
  { id: 'va-sq-901',           name: 'Virginia Square (901 N Nelson)', url: 'https://www.zillow.com/apartments/arlington-va/901-n-nelson-st/5XjMlU/' },
  { id: 'latitude',            name: 'Latitude',                       url: 'https://www.zillow.com/apartments/arlington-va/latitude/5XjKjU/' },
  { id: '4040-wilson',         name: '4040 Wilson',                    url: 'https://www.zillow.com/apartments/arlington-va/4040-wilson/5XhvC4/' },
  { id: 'j-sol',               name: 'J·Sol',                          url: 'https://www.zillow.com/apartments/arlington-va/j-sol/5XhvBT/' },
  { id: 'view-ballston',       name: 'The View Ballston',              url: 'https://www.zillow.com/apartments/arlington-va/the-view-ballston/5XhvC3/' },
  { id: 'ballston-place',      name: 'Ballston Place',                 url: 'https://www.zillow.com/apartments/arlington-va/ballston-place/5XjQrV/' },
  { id: 'quincy-plaza',        name: 'Quincy Plaza',                   url: 'https://www.zillow.com/apartments/arlington-va/quincy-plaza/5XhvBR/' },
  { id: 'beacon-clarendon',    name: 'The Beacon Clarendon',           url: 'https://www.zillow.com/apartments/arlington-va/the-beacon-clarendon/5XhvBP/' },
  { id: 'ten-at-clarendon',    name: 'Ten at Clarendon',               url: 'https://www.zillow.com/apartments/arlington-va/ten-at-clarendon/5XhvBN/' },
  { id: 'reserve-clarendon',   name: 'Reserve at Clarendon Centre',    url: 'https://www.zillow.com/apartments/arlington-va/reserve-at-clarendon-centre/5XhvBM/' },
  { id: 'modera-clarendon',    name: 'Modera Clarendon',               url: 'https://www.zillow.com/apartments/arlington-va/modera-clarendon/5XhvBL/' },
  { id: 'vpoint',              name: 'vPoint',                         url: 'https://www.zillow.com/apartments/arlington-va/vpoint/5XhvBK/' },
  { id: 'hampden-house',       name: 'Hampden House',                  url: 'https://www.zillow.com/apartments/bethesda-md/hampden-house/5XhvBJ/' },
  { id: 'the-charles',         name: 'The Charles',                    url: 'https://www.zillow.com/apartments/bethesda-md/the-charles/5XhvBH/' },
  { id: 'gallery-bethesda',    name: 'Gallery Bethesda I',             url: 'https://www.zillow.com/apartments/bethesda-md/gallery-bethesda-i/5XhvBG/' },
  { id: 'upstairs-bethesda',   name: 'Upstairs at Bethesda Row',       url: 'https://www.zillow.com/apartments/bethesda-md/upstairs-at-bethesda-row/5XhvBF/' },
  { id: 'cecil-bethesda',      name: 'Cecil',                          url: 'https://www.zillow.com/apartments/bethesda-md/the-cecily/5XhvBE/' },
  { id: 'flats-8300',          name: 'Flats 8300',                     url: 'https://www.zillow.com/apartments/bethesda-md/flats-8300/5XhvBD/' },
  { id: 'metropolitan',        name: 'The Metropolitan',               url: 'https://www.zillow.com/apartments/bethesda-md/the-metropolitan/5XhvBC/' },
  { id: '7001-arlington',      name: '7001 Arlington at Bethesda',     url: 'https://www.zillow.com/apartments/bethesda-md/7001-arlington-rd/5XhvBB/' },
];

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
      min: Math.min(...d.mins), max: Math.max(...d.maxs),
      base_min: d.baseMins.length ? Math.min(...d.baseMins) : null,
      base_max: d.baseMaxs.length ? Math.max(...d.baseMaxs) : null,
      plans: d.plans,
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
    result.price3_min      = Math.min(...byBeds[3].mins);
    result.price3_max      = Math.max(...byBeds[3].maxs);
    result.price3_plans    = byBeds[3].plans;
  }
  return result;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const args     = process.argv.slice(2);
  const singleId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
  const headful  = args.includes('--headful');
  const targets  = singleId ? BUILDINGS.filter(b => b.id === singleId) : BUILDINGS;

  if (!targets.length) {
    console.error(`Unknown id: "${singleId}"\nAvailable:\n${BUILDINGS.map(b => `  ${b.id}`).join('\n')}`);
    process.exit(1);
  }

  const chromePath = findChrome();
  if (chromePath) {
    console.log(`Using real Chrome: ${chromePath}`);
  } else {
    console.log(`Real Chrome not found — using Playwright's Chromium (may get blocked)`);
  }

  console.log(`\n🏢 Scraping ${targets.length} building(s)...\n`);

  const launchOptions = {
    headless: !headful,
    args: ['--no-sandbox'],
    ...(chromePath ? { executablePath: chromePath } : {}),
  };

  const browser  = await chromium.launch(launchOptions);
  const context  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Warm up
  process.stdout.write('Warming up session... ');
  const warmup = await context.newPage();
  await warmup.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1500 + Math.random() * 1000);
  await warmup.close();
  console.log('ready.\n');

  const page       = await context.newPage();
  const outputPath = './prices.json';
  const results    = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : {};
  let success = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    console.log(`[${i + 1}/${targets.length}] ${b.name}`);

    const result = { id: b.id, name: b.name, zillow_url: b.url,
                     scraped_at: new Date().toISOString(), source: 'zillow_building_page' };
    try {
      await page.goto(b.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(800);

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
    if (i < targets.length - 1) await sleep(2000 + Math.random() * 2000);
  }

  await browser.close();

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
  }
}

main().catch(console.error);
