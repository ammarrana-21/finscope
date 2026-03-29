/**
 * FinScope Data Fetcher — v2
 * ==========================
 * Uses all three government APIs:
 *   FRED  — Federal Reserve Economic Data (recession, rates, inflation, jobs)
 *   EIA   — Energy Information Administration (oil, gas prices)
 *   BLS   — Bureau of Labor Statistics (CPI by category, employment detail)
 *
 * Runs daily via GitHub Actions. Writes to data/live.json.
 * Cloudflare Pages rebuilds the site automatically when live.json changes.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── API Keys from GitHub Secrets ────────────────────────────────────────────
const FRED_KEY = process.env.FRED_API_KEY;
const EIA_KEY  = process.env.EIA_API_KEY;
const BLS_KEY  = process.env.BLS_API_KEY;

if (!FRED_KEY) { console.error('❌ FRED_API_KEY missing'); process.exit(1); }
if (!EIA_KEY)  { console.error('❌ EIA_API_KEY missing');  process.exit(1); }
if (!BLS_KEY)  { console.error('❌ BLS_API_KEY missing');  process.exit(1); }

console.log('✓ All API keys loaded from GitHub Secrets');

// ─── Output path ──────────────────────────────────────────────────────────────
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'live.json');

// ─── Load existing data as fallback ──────────────────────────────────────────
function loadExisting() {
  try {
    const raw = fs.readFileSync(OUTPUT_PATH, 'utf8');
    const existing = JSON.parse(raw);
    console.log(`✓ Loaded existing data (${existing.lastUpdated}) as fallback`);
    return existing;
  } catch {
    console.log('ℹ No existing data found — using null fallbacks');
    return {};
  }
}

// ─── HTTP GET helper ──────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const displayUrl = url.replace(/api_key=[^&]+/, 'api_key=***');
    console.log(`  → GET ${displayUrl.substring(0, 100)}`);
    https.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 100)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Bad JSON: ${body.substring(0, 150)}`)); }
      });
    }).on('error', reject);
  });
}

// ─── HTTP POST helper (BLS requires POST) ────────────────────────────────────
function post(url, payload) {
  return new Promise((resolve, reject) => {
    console.log(`  → POST ${url}`);
    const body    = JSON.stringify(payload);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`BLS bad JSON: ${data.substring(0, 150)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Value validators ─────────────────────────────────────────────────────────
const validate = {
  percent:  (v, min=-5,  max=100) => isValid(v,min,max) ? round2(v) : null,
  rate:     (v, min=0,   max=30)  => isValid(v,min,max) ? round2(v) : null,
  price:    (v, min=0,   max=500) => isValid(v,min,max) ? round2(v) : null,
  index:    (v, min=0,   max=200) => isValid(v,min,max) ? round2(v) : null,
  count:    (v, min=1e4, max=5e6) => isValid(v,min,max) ? Math.round(v) : null,
};

function isValid(v, min, max) {
  const n = parseFloat(v);
  return !isNaN(n) && isFinite(n) && n >= min && n <= max;
}

function round2(v) { return Math.round(parseFloat(v) * 100) / 100; }

// ─── Extract latest FRED value ────────────────────────────────────────────────
function latestFred(obs) {
  if (!Array.isArray(obs)) return null;
  for (let i = obs.length - 1; i >= 0; i--) {
    const v = obs[i]?.value;
    if (v && v !== '.' && !isNaN(parseFloat(v))) return parseFloat(v);
  }
  return null;
}

// ─── Extract latest BLS value ─────────────────────────────────────────────────
function latestBLS(json, seriesId) {
  try {
    const series = json.Results?.series?.find(s => s.seriesID === seriesId);
    if (!series?.data?.length) return null;
    return parseFloat(series.data[0].value); // BLS: most recent first
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════════
// FRED FETCHERS
// ════════════════════════════════════════════════════════════════════════════════

async function fredSeries(seriesId, limit = 5) {
  const url = `https://api.stlouisfed.org/fred/series/observations`
            + `?series_id=${seriesId}`
            + `&api_key=${FRED_KEY}`
            + `&file_type=json`
            + `&sort_order=desc`
            + `&limit=${limit}`;
  const json = await get(url);
  // FRED returns desc order, so obs[0] is most recent
  return json.observations || [];
}

// 1. Recession probability — NY Fed yield curve model
async function getRecessionProb(fb) {
  try {
    const obs = await fredSeries('RECPROUSM156N', 3);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.percent(val, 0, 100);
    console.log(`  ✓ Recession probability: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Recession prob: ${e.message}`); return fb; }
}

// 2. Federal funds rate — daily effective rate
async function getFedRate(fb) {
  try {
    const obs = await fredSeries('DFF', 5);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.rate(val);
    console.log(`  ✓ Fed rate: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Fed rate: ${e.message}`); return fb; }
}

// 3. Unemployment rate — monthly BLS via FRED
async function getUnemployment(fb) {
  try {
    const obs = await fredSeries('UNRATE', 3);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.percent(val, 0, 25);
    console.log(`  ✓ Unemployment: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Unemployment: ${e.message}`); return fb; }
}

// 4. Credit card APR — Federal Reserve H.15 release
async function getCreditCardAPR(fb) {
  try {
    const obs = await fredSeries('TERMCBCCALLNS', 3);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.rate(val, 0, 40);
    console.log(`  ✓ Credit card APR: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ CC APR: ${e.message}`); return fb; }
}

// 5. Consumer sentiment — University of Michigan
async function getConsumerSentiment(fb) {
  try {
    const obs = await fredSeries('UMCSENT', 3);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.index(val, 0, 150);
    console.log(`  ✓ Consumer sentiment: ${r}`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Sentiment: ${e.message}`); return fb; }
}

// 6. 10-year Treasury yield — daily
async function getTreasuryYield(fb) {
  try {
    const obs = await fredSeries('DGS10', 5);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.rate(val, 0, 20);
    console.log(`  ✓ 10Y Treasury: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Treasury: ${e.message}`); return fb; }
}

// 7. Weekly jobless claims — DOL via FRED
async function getJoblessClaims(fb) {
  try {
    const obs = await fredSeries('ICSA', 3);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.count(val, 1e4, 5e6);
    console.log(`  ✓ Jobless claims: ${r?.toLocaleString()}/week`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Jobless claims: ${e.message}`); return fb; }
}

// 8. Mortgage rate — 30-year fixed (Freddie Mac via FRED)
async function getMortgageRate(fb) {
  try {
    const obs = await fredSeries('MORTGAGE30US', 3);
    const val = latestFred(obs.slice().reverse());
    const r   = validate.rate(val, 0, 20);
    console.log(`  ✓ Mortgage rate: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Mortgage: ${e.message}`); return fb; }
}

// 9. M2 Money Supply — for inflation context
async function getM2(fb) {
  try {
    const obs  = await fredSeries('M2SL', 14); // need 13 months for YoY
    const vals = obs.filter(o => o.value !== '.').slice(0, 13);
    if (vals.length < 13) return fb;
    const latest  = parseFloat(vals[0].value);
    const yearAgo = parseFloat(vals[12].value);
    const yoy     = ((latest / yearAgo) - 1) * 100;
    const r       = validate.percent(yoy, -20, 50);
    console.log(`  ✓ M2 money supply YoY: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ M2: ${e.message}`); return fb; }
}

// ════════════════════════════════════════════════════════════════════════════════
// BLS FETCHERS — Bureau of Labor Statistics
// Uses POST with your registered API key for higher rate limits
// BLS series IDs reference: https://www.bls.gov/help/hlpforma.htm
// ════════════════════════════════════════════════════════════════════════════════

async function blsMultiSeries(seriesIds) {
  const currentYear  = new Date().getFullYear();
  const payload = {
    seriesid:        seriesIds,
    startyear:       String(currentYear - 1),
    endyear:         String(currentYear),
    registrationkey: BLS_KEY,
  };
  return await post('https://api.bls.gov/publicAPI/v2/timeseries/data/', payload);
}

// 10. CPI All Items — BLS direct (for verification vs FRED)
// Series CUUR0000SA0 = CPI-U, All Urban Consumers, All Items, Not Seasonally Adjusted
async function getCPI_All(fb) {
  try {
    const json = await blsMultiSeries(['CUUR0000SA0']);
    if (json.status !== 'REQUEST_SUCCEEDED') {
      throw new Error(`BLS status: ${json.status} — ${json.message?.[0]}`);
    }
    const series = json.Results?.series?.[0];
    if (!series?.data?.length) throw new Error('No BLS CPI data');

    // BLS returns most-recent first. Get last 13 months for YoY
    const data  = series.data.slice(0, 13);
    if (data.length < 13) return fb;
    const latest  = parseFloat(data[0].value);
    const yearAgo = parseFloat(data[12].value);
    const yoy     = ((latest / yearAgo) - 1) * 100;
    const r       = validate.percent(yoy, -5, 25);
    console.log(`  ✓ CPI (BLS direct): ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ BLS CPI: ${e.message}`); return fb; }
}

// 11. CPI Food at Home — grocery inflation specifically
// Series CUUR0000SAF11 = Food at home (what you buy at the grocery store)
async function getCPI_Food(fb) {
  try {
    const json = await blsMultiSeries(['CUUR0000SAF11']);
    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error(json.message?.[0]);
    const data  = json.Results?.series?.[0]?.data?.slice(0, 13);
    if (!data || data.length < 13) return fb;
    const yoy = ((parseFloat(data[0].value) / parseFloat(data[12].value)) - 1) * 100;
    const r   = validate.percent(yoy, -10, 30);
    console.log(`  ✓ CPI food at home: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ BLS food CPI: ${e.message}`); return fb; }
}

// 12. CPI Shelter — housing/rent inflation
// Series CUUR0000SAH1 = Shelter component of CPI
async function getCPI_Shelter(fb) {
  try {
    const json = await blsMultiSeries(['CUUR0000SAH1']);
    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error(json.message?.[0]);
    const data  = json.Results?.series?.[0]?.data?.slice(0, 13);
    if (!data || data.length < 13) return fb;
    const yoy = ((parseFloat(data[0].value) / parseFloat(data[12].value)) - 1) * 100;
    const r   = validate.percent(yoy, -10, 30);
    console.log(`  ✓ CPI shelter: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ BLS shelter CPI: ${e.message}`); return fb; }
}

// 13. CPI Energy — gas/utilities inflation
// Series CUUR0000SA0E = Energy component
async function getCPI_Energy(fb) {
  try {
    const json = await blsMultiSeries(['CUUR0000SA0E']);
    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error(json.message?.[0]);
    const data  = json.Results?.series?.[0]?.data?.slice(0, 13);
    if (!data || data.length < 13) return fb;
    const yoy = ((parseFloat(data[0].value) / parseFloat(data[12].value)) - 1) * 100;
    const r   = validate.percent(yoy, -50, 100);
    console.log(`  ✓ CPI energy: ${r}%`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ BLS energy CPI: ${e.message}`); return fb; }
}

// ════════════════════════════════════════════════════════════════════════════════
// EIA FETCHERS — Energy Information Administration
// ════════════════════════════════════════════════════════════════════════════════

// 14. Brent crude oil price — GLOBAL benchmark
async function getOilPrice(fb) {
  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/`
              + `?api_key=${EIA_KEY}`
              + `&frequency=daily`
              + `&data[0]=value`
              + `&facets[series][]=RBRTE`
              + `&sort[0][column]=period`
              + `&sort[0][direction]=desc`
              + `&length=3`;
    const json = await get(url);
    const val  = json.response?.data?.[0]?.value;
    const r    = validate.price(val, 20, 300);
    console.log(`  ✓ Brent oil: $${r}/bbl`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Oil price: ${e.message}`); return fb; }
}

// 15. US regular gasoline — national weekly average
async function getGasPrice(fb) {
  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/`
              + `?api_key=${EIA_KEY}`
              + `&frequency=weekly`
              + `&data[0]=value`
              + `&facets[duoarea][]=NUS`
              + `&facets[product][]=EPM0`
              + `&sort[0][column]=period`
              + `&sort[0][direction]=desc`
              + `&length=3`;
    const json = await get(url);
    const val  = json.response?.data?.[0]?.value;
    const r    = validate.price(val, 1, 15);
    console.log(`  ✓ US gas price: $${r}/gal`);
    return r ?? fb;
  } catch(e) { console.warn(`  ✗ Gas price: ${e.message}`); return fb; }
}

// ════════════════════════════════════════════════════════════════════════════════
// DERIVED CALCULATIONS
// Computed from raw data — not from APIs
// ════════════════════════════════════════════════════════════════════════════════

// Tariff household cost estimate — based on Yale Budget Lab research
// Average household pays ~$2,400/year under current tariff regime
// We adjust based on CPI food + energy as proxy for tariff pass-through
function calcTariffCost(cpi_food, cpi_energy) {
  // Base Yale estimate: $2,400/year ($200/month)
  const base = 2400;
  // Adjust up if food/energy inflation is elevated (tariff pass-through signal)
  const foodPressure   = cpi_food   ? Math.max(0, cpi_food   - 2) * 50  : 0;
  const energyPressure = cpi_energy ? Math.max(0, cpi_energy - 2) * 20  : 0;
  return Math.round(base + foodPressure + energyPressure);
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   FinScope Data Fetcher v2                   ║');
  console.log(`║   ${new Date().toISOString()}   ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  const fb = loadExisting();

  // ── FRED (9 calls) ──────────────────────────────────────────────────────
  console.log('\n📡 FRED — Federal Reserve Economic Data (USA)');
  const recession_probability = await getRecessionProb(fb.recession_probability ?? null);
  const fed_rate              = await getFedRate(fb.fed_rate ?? null);
  const unemployment          = await getUnemployment(fb.unemployment ?? null);
  const credit_card_apr       = await getCreditCardAPR(fb.credit_card_apr ?? null);
  const consumer_sentiment    = await getConsumerSentiment(fb.consumer_sentiment ?? null);
  const treasury_yield_10y    = await getTreasuryYield(fb.treasury_yield_10y ?? null);
  const jobless_claims_weekly = await getJoblessClaims(fb.jobless_claims_weekly ?? null);
  const mortgage_rate_30y     = await getMortgageRate(fb.mortgage_rate_30y ?? null);
  const m2_money_supply_yoy   = await getM2(fb.m2_money_supply_yoy ?? null);

  // ── BLS (4 calls) ───────────────────────────────────────────────────────
  console.log('\n📊 BLS — Bureau of Labor Statistics (USA)');
  const cpi_annual         = await getCPI_All(fb.cpi_annual ?? null);
  const cpi_food_yoy       = await getCPI_Food(fb.cpi_food_yoy ?? null);
  const cpi_shelter_yoy    = await getCPI_Shelter(fb.cpi_shelter_yoy ?? null);
  const cpi_energy_yoy     = await getCPI_Energy(fb.cpi_energy_yoy ?? null);

  // ── EIA (2 calls) ───────────────────────────────────────────────────────
  console.log('\n⛽ EIA — Energy Information Administration');
  const oil_price_brent = await getOilPrice(fb.oil_price_brent ?? null);
  const gas_price_us    = await getGasPrice(fb.gas_price_us    ?? null);

  // ── Derived values ──────────────────────────────────────────────────────
  console.log('\n🔢 Computing derived values...');
  const tariff_household_annual = calcTariffCost(cpi_food_yoy, cpi_energy_yoy);
  console.log(`  ✓ Tariff household cost estimate: $${tariff_household_annual}/yr`);

  // ── Count successes ─────────────────────────────────────────────────────
  const allValues = [
    recession_probability, fed_rate, unemployment, credit_card_apr,
    consumer_sentiment, treasury_yield_10y, jobless_claims_weekly,
    mortgage_rate_30y, m2_money_supply_yoy,
    cpi_annual, cpi_food_yoy, cpi_shelter_yoy, cpi_energy_yoy,
    oil_price_brent, gas_price_us
  ];
  const success = allValues.filter(v => v !== null).length;
  const total   = allValues.length;

  // ── Build output ────────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];

  const output = {
    // ── Metadata ──
    lastUpdated:           today,
    lastUpdatedISO:        new Date().toISOString(),
    successRate:           `${success}/${total}`,
    coverageGeography:     'United States (oil price is global Brent benchmark)',
    dataProviders:         ['FRED (St. Louis Fed)', 'BLS (Dept of Labor)', 'EIA (Dept of Energy)'],

    // ── Economic Health ── (FRED + BLS)
    recession_probability,      // % — USA — monthly — NY Fed yield curve model
    fed_rate,                   // % — USA — daily — federal funds effective rate
    unemployment,               // % — USA — monthly — seasonally adjusted
    credit_card_apr,            // % — USA — monthly — commercial bank average
    consumer_sentiment,         // index — USA — monthly — Univ of Michigan
    treasury_yield_10y,         // % — USA — daily — 10-year Treasury
    jobless_claims_weekly,      // count — USA — weekly — initial claims
    mortgage_rate_30y,          // % — USA — weekly — 30-year fixed (Freddie Mac)
    m2_money_supply_yoy,        // % — USA — monthly — year-over-year change

    // ── Inflation Breakdown ── (BLS)
    cpi_annual,                 // % — USA — monthly — all items YoY
    cpi_food_yoy,               // % — USA — monthly — food at home YoY
    cpi_shelter_yoy,            // % — USA — monthly — shelter/rent YoY
    cpi_energy_yoy,             // % — USA — monthly — energy YoY

    // ── Energy ── (EIA)
    oil_price_brent,            // USD/bbl — GLOBAL — daily — Brent benchmark
    gas_price_us,               // USD/gal — USA — weekly — regular grade

    // ── Derived ──
    tariff_household_annual,    // USD/yr — USA — estimated household tariff cost

    // ── Source citations ──
    sources: {
      recession_probability:   'FRED: RECPROUSM156N — NY Fed probit model',
      fed_rate:                'FRED: DFF — Federal funds effective rate',
      unemployment:            'FRED: UNRATE — BLS monthly (seasonally adj.)',
      credit_card_apr:         'FRED: TERMCBCCALLNS — Fed Reserve H.15',
      consumer_sentiment:      'FRED: UMCSENT — University of Michigan',
      treasury_yield_10y:      'FRED: DGS10 — US Treasury daily yield curve',
      jobless_claims_weekly:   'FRED: ICSA — DOL initial claims (weekly)',
      mortgage_rate_30y:       'FRED: MORTGAGE30US — Freddie Mac PMMS',
      m2_money_supply_yoy:     'FRED: M2SL — Board of Governors (YoY calc)',
      cpi_annual:              'BLS: CUUR0000SA0 — CPI-U All Items (YoY calc)',
      cpi_food_yoy:            'BLS: CUUR0000SAF11 — CPI Food at Home (YoY)',
      cpi_shelter_yoy:         'BLS: CUUR0000SAH1 — CPI Shelter (YoY)',
      cpi_energy_yoy:          'BLS: CUUR0000SA0E — CPI Energy (YoY)',
      oil_price_brent:         'EIA: RBRTE — Europe Brent Spot Price FOB',
      gas_price_us:            'EIA: EMM_EPMR_PTE_NUS — US regular gas weekly',
      tariff_household_annual: 'Derived: Yale Budget Lab methodology + BLS CPI',
    },

    // ── Update frequencies ──
    updateFrequency: {
      recession_probability:   'Monthly (NY Fed publishes monthly)',
      fed_rate:                'Daily on business days',
      unemployment:            'Monthly (first Friday of month)',
      credit_card_apr:         'Monthly',
      consumer_sentiment:      'Monthly',
      treasury_yield_10y:      'Daily on business days',
      jobless_claims_weekly:   'Weekly (every Thursday)',
      mortgage_rate_30y:       'Weekly (every Thursday)',
      m2_money_supply_yoy:     'Monthly',
      cpi_annual:              'Monthly (BLS ~10th of month)',
      cpi_food_yoy:            'Monthly',
      cpi_shelter_yoy:         'Monthly',
      cpi_energy_yoy:          'Monthly',
      oil_price_brent:         'Daily on trading days (global)',
      gas_price_us:            'Weekly (every Monday)',
      tariff_household_annual: 'Monthly (recalculated with CPI)',
    },
  };

  // ── Write file ───────────────────────────────────────────────────────────
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   FINAL DATA SNAPSHOT                        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Date:               ${today}              ║`);
  console.log(`║  Success rate:       ${success}/${total} data points          ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Recession prob:     ${recession_probability ?? 'N/A'}%`);
  console.log(`║  CPI (all):          ${cpi_annual ?? 'N/A'}%`);
  console.log(`║  CPI food:           ${cpi_food_yoy ?? 'N/A'}%`);
  console.log(`║  CPI shelter:        ${cpi_shelter_yoy ?? 'N/A'}%`);
  console.log(`║  CPI energy:         ${cpi_energy_yoy ?? 'N/A'}%`);
  console.log(`║  Fed rate:           ${fed_rate ?? 'N/A'}%`);
  console.log(`║  Unemployment:       ${unemployment ?? 'N/A'}%`);
  console.log(`║  CC APR:             ${credit_card_apr ?? 'N/A'}%`);
  console.log(`║  Mortgage (30y):     ${mortgage_rate_30y ?? 'N/A'}%`);
  console.log(`║  Consumer sentiment: ${consumer_sentiment ?? 'N/A'}`);
  console.log(`║  Jobless claims:     ${jobless_claims_weekly?.toLocaleString() ?? 'N/A'}/wk`);
  console.log(`║  Brent oil:          $${oil_price_brent ?? 'N/A'}/bbl`);
  console.log(`║  US gas:             $${gas_price_us ?? 'N/A'}/gal`);
  console.log(`║  Tariff cost/yr:     $${tariff_household_annual ?? 'N/A'}`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  File: ${OUTPUT_PATH.split('/').pop()}   ║`);
  console.log('╚══════════════════════════════════════════════╝');

  if (success < 8) {
    console.error(`\n❌ Too many failures (${total - success}/${total}). Check API keys in GitHub Secrets.`);
    process.exit(1);
  }

  console.log('\n✅ Done. Cloudflare Pages will rebuild automatically.\n');
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
