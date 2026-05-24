/**
 * Debug script — dumps the full __NEXT_DATA__ structure for AVA Ballston
 * so we can find exactly where floor_plans lives.
 * Run: node debug.js
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
});

// Warm up
const warmup = await context.newPage();
await warmup.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 1500));
await warmup.close();

const page = await context.newPage();
await page.goto('https://www.zillow.com/apartments/arlington-va/ava-ballston-square/5XhvC5/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

const nextData = await page.evaluate(() => {
  const el = document.getElementById('__NEXT_DATA__');
  return el ? JSON.parse(el.textContent) : null;
});

if (!nextData) {
  console.log('No __NEXT_DATA__ found');
  await browser.close();
  process.exit(1);
}

const pp = nextData.props.pageProps;
console.log('\n=== pageProps keys ===');
console.log(Object.keys(pp));

// Recursively search for anything that looks like floor plan data
function findFloorPlans(obj, path = '', depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return;
  
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = `${path}.${key}`;
    
    // Look for arrays that contain bed/price data
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (first && typeof first === 'object') {
        const keys = Object.keys(first);
        const looksLikeFloorPlan = keys.some(k => 
          ['beds', 'bedrooms', 'minPrice', 'maxPrice', 'price', 'units'].includes(k)
        );
        if (looksLikeFloorPlan) {
          console.log(`\n✓ FOUND at ${fullPath} [${val.length} items]`);
          console.log('  First item keys:', keys);
          console.log('  First item:', JSON.stringify(first, null, 2).substring(0, 400));
          return;
        }
      }
    }
    
    // Recurse into objects and arrays
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      findFloorPlans(val, fullPath, depth + 1);
    } else if (Array.isArray(val)) {
      val.slice(0, 3).forEach((item, i) => {
        if (item && typeof item === 'object') {
          findFloorPlans(item, `${fullPath}[${i}]`, depth + 1);
        }
      });
    }
  }
}

console.log('\n=== Searching for floor plan data ===');
findFloorPlans(pp, 'pageProps');

// Also dump componentProps structure
if (pp.componentProps) {
  console.log('\n=== componentProps keys ===');
  console.log(Object.keys(pp.componentProps));
  if (pp.componentProps.building) {
    console.log('\n=== componentProps.building keys ===');
    console.log(Object.keys(pp.componentProps.building));
  }
}

// Also dump searchPageState if present
if (pp.searchPageState) {
  console.log('\n=== searchPageState keys ===');
  console.log(Object.keys(pp.searchPageState));
}

import { writeFileSync } from 'fs';
writeFileSync('./nextdata_dump.json', JSON.stringify(nextData, null, 2));
console.log('\n✓ Full __NEXT_DATA__ saved to nextdata_dump.json');

await browser.close();
