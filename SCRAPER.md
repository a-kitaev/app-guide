# Apartment Scraper — How It Works & How to Add Buildings

## What Was Done

The scraper (`scraper_official.js`) pulls live 2BR floor plan prices from ~40 apartment building websites using Playwright connected to a real Chrome session on port 9222. It started failing on most buildings. Here's what was fixed:

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Jonah/RentCafe/Equity timeouts | `waitUntil: 'networkidle'` → 35-40s timeout | Changed all to `domcontentloaded` + 4-7s sleep |
| Meridian, Virginia Square Plaza scraped wrong | typed `dittmar`/`entrata` but actual platform is MillCreek | Changed type + URL to MillCreek format |
| Courthouse Plaza, Prime, Reserve, 901 Nelson returned nothing | typed `entrata`, actually Equity Residential site | Changed type to `equity` |
| 1800 Oak went to homepage | URL had `washington-dc` instead of `arlington` | Fixed URL path |
| Meridian MillCreek format differs from Modera/VSP | Modera uses filter tabs; Meridian uses floor plan cards | Added card-based fallback (`N Bed, N Bath → From $X per month`) |
| The Charles Jonah format differs | Uses "Base Rent" text, not "Starting at" | Extended text fallback regex |
| Upstairs at Bethesda Row typed wrong | Had type `entrata`, actual platform is Jonah | Changed to `jonah` |
| Bogus prices from Meridian ($394,815) | `entrata` extractor ran on MillCreek page, picked up garbage | Fixed type, deleted stale prices.json entry |

**Result**: 25/32 active buildings now return live 2BR prices.

---

## Current Platform Types

| Type | How it works | Example buildings |
|------|-------------|-------------------|
| `entrata` | `window.__ENTRATA_DATA__` or DOM scrape | Randolph Towers |
| `equity` | DOM: `N Beds\n$X,XXX` pairs | Courthouse Plaza, 1800 Oak, Liberty Tower |
| `millcreek` | Click bed filter tabs → "Starting from $X/month"; fallback: card DOM | Modera Clarendon, Meridian, Virginia Square Plaza |
| `jonah` | Intercept Knock API OR text scrape for "Starting at $X" / "Base Rent" | J·Sol, Hampden House, The Charles, Upstairs at Bethesda Row |
| `rentcafe` | Intercept mmccdn.com JSON feed; DOM fallbacks for Akelius format | Central Place, Bell at Courthouse, Ballston Place |
| `bozzuto` | DOM scrape: `N Bed • N Bath` lines | 4040 Wilson, The View Ballston |
| `avalon` | Intercept `community-units` API | Avalon Courthouse Place, AVA Ballston Square |
| `cortland` | DOM scrape: `N bed` then price line | Cortland Rosslyn |
| `realpage` | Intercept `GetApartments` API | vPoint |
| `nestio` | DOM scrape: price in specific card layout | Latitude |
| `dittmar` | ❌ Blocked — iframe renders nothing in headless Chrome | Rosslyn Towers, Virginia Square Towers, Quincy Plaza |
| `none` | Skip — dead URL, SSL error, call-for-pricing, or login wall | The Crestmont, Cecil, Flats 8300, etc. |

---

## Remaining Failures

| Building | ID | Type | Why it fails |
|---------|----|------|-------------|
| Rosslyn Towers | r3 | dittmar | Dittmar iframe blocked (anti-bot) |
| Virginia Square Towers | v1 | dittmar | Same |
| Quincy Plaza | b5 | dittmar | Same |
| The Beacon Clarendon | cl1 | bozzuto | SightMap `"pricing_tier":"paid_tier"` — no public prices |
| Rosslyn Heights | r4 | rentcafe | No 2BR currently listed (building has them; just all occupied) |
| Sedona \| Slate | r5 | bozzuto | 1BR only available right now |
| The Palatine | c4 | bozzuto | No 2BR data returned (possibly fully leased) |

For Dittmar buildings, use `node scraper_cdp.js --id <id>` to pull from Zillow instead.

---

## Adding a New Building

1. **Identify the leasing platform** — load the floor plans page in Chrome and check the network tab:
   - `mmccdn.com` or `cdngeneralmvc.rentcafe.com` → `rentcafe`
   - `knockrentals.com` or `jonahdigital.com` → `jonah`
   - `entrata.com` or `window.__ENTRATA_DATA__` in console → `entrata`
   - `equityapartments.com` URL → `equity`
   - `bozzuto.com` script or `communityfees.bozzuto.com` → `bozzuto`
   - `rentvsp.com`, `moderaclarendon.com`, `meridiancourthouse.com` (`.../conventional/`) → `millcreek`
   - `avaloncommunities.com` → `avalon`
   - `cortland.com` → `cortland`
   - `rentcafe.com` + `realpage` in page source → `realpage`
   - `rentdittmar.com` URL → `dittmar` (will fail; use Zillow fallback)

2. **Add to `buildings.json`**:
```json
{
  "id": "xx1",
  "hood": "Neighborhood",
  "name": "Building Name",
  "addr": "123 Main St, Arlington, VA 22201",
  "official_url": "https://building.com/floor-plans",
  "scraper": { "type": "rentcafe" },
  "price2": "$3,500+",
  "rating": 4.2,
  "metro": "5 min · Station Name",
  "gym": "Great",
  "gymNote": "Fitness center description",
  "desc": "Short building description.",
  "why": "Why this building is worth considering."
}
```

3. **Test**: `node scraper_official.js --id xx1`

4. **If it fails** with "no data found":
   - Run `node scraper_official.js --id xx1 --headful` to watch what loads
   - Write a quick probe script (see pattern in probe files from git history) to inspect the page DOM
   - Check if the platform type is actually what you think it is
   - If the URL is wrong (e.g., redirects to homepage), fix `official_url` first

5. **If the platform is new**: Add an `extractXxx` function in `scraper_official.js` and wire it into the `switch` block around line 640. Follow the existing extractor patterns — use `domcontentloaded` + sleep, never `networkidle`.

6. **Mark as `none`** if: the URL is dead, prices are behind a login wall, or the site says "Call for pricing."

---

## Running the Scraper

```bash
# All buildings
node scraper_official.js

# One building
node scraper_official.js --id b3

# All buildings of a type
node scraper_official.js --type equity

# Debug visually
node scraper_official.js --id b3 --headful

# Zillow fallback for Dittmar or other blocked sites
node scraper_cdp.js --id r3
```

Chrome must be running with `--remote-debugging-port=9222` before running any scraper.

---

## Gotchas

- **Never run two scraper instances in parallel** — both read `prices.json` at startup and the second write overwrites the first's results.
- **`networkidle` times out** on almost every leasing site. Always use `domcontentloaded` + sleep.
- **Equity URLs** follow `equityapartments.com/arlington/{neighborhood}/{building-name}`. Not `washington-dc` even for DC-adjacent properties.
- **MillCreek URL pattern**: `{site}.com/{city}/{community-name}/conventional/` — if a building's site follows this pattern, use `millcreek` type.
- **prices.json stale entries**: if you change a building to `none`, manually delete its entry from `prices.json` or it will keep showing in the failure summary.
