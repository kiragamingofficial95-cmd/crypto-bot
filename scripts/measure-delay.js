/**
 * Measures how stale the CoinGecko feed is compared with real-time exchange
 * references (Binance US and Coinbase), using cross-correlation of the
 * price-change series to estimate the lag.
 *
 *   node scripts/measure-delay.js [seconds]
 */
const KEY = process.env.COINGECKO_API_KEY || '';
const DURATION_S = Number(process.argv[2] || 180);
const INTERVAL_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function coingecko() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,tether&vs_currencies=usd&precision=full',
    { headers: { accept: 'application/json', 'x-cg-demo-api-key': KEY } }
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = await res.json();
  return j.binancecoin.usd / j.tether.usd;
}

const references = {
  binance: async () => {
    const res = await fetch('https://api.binance.us/api/v3/ticker/price?symbol=BNBUSDT');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Number((await res.json()).price);
  },
  coinbase: async () => {
    const res = await fetch('https://api.exchange.coinbase.com/products/BNB-USD/ticker');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Number((await res.json()).price);
  },
};

/** Correlates the change series of two series at a range of lags. */
function bestLag(cgDeltas, refDeltas) {
  let best = { lag: null, corr: -2 };
  for (let lag = 0; lag < cgDeltas.length; lag += 1) {
    const a = cgDeltas.slice(lag);
    const b = refDeltas.slice(0, refDeltas.length - lag);
    const n = Math.min(a.length, b.length);
    if (n < 8) break;
    const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
    const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i += 1) {
      const x = a[i] - ma;
      const y = b[i] - mb;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    const corr = da && db ? num / Math.sqrt(da * db) : 0;
    if (corr > best.corr) best = { lag, corr };
  }
  return best;
}

async function main() {
  const cg = [];
  const refs = { binance: [], coinbase: [] };
  const start = Date.now();

  while (Date.now() - start < DURATION_S * 1000) {
    const t = Date.now();
    const settled = await Promise.allSettled([
      coingecko(),
      references.binance(),
      references.coinbase(),
    ]);
    if (settled[0].status === 'fulfilled') cg.push({ t, p: settled[0].value });
    if (settled[1].status === 'fulfilled') refs.binance.push({ t, p: settled[1].value });
    if (settled[2].status === 'fulfilled') refs.coinbase.push({ t, p: settled[2].value });
    await sleep(INTERVAL_MS);
  }

  console.log(`sampled ${cg.length} CoinGecko, ${refs.binance.length} Binance US, ${refs.coinbase.length} Coinbase points over ${DURATION_S}s\n`);

  // How many polls actually returned a new value?
  let changes = 0;
  for (let i = 1; i < cg.length; i += 1) if (cg[i].p !== cg[i - 1].p) changes += 1;
  console.log(`CoinGecko returned a NEW value ${changes} times out of ${cg.length - 1} polls`);
  console.log(`  => effectively one fresh price every ~${Math.round((DURATION_S * 1000) / Math.max(1, changes) / 1000)}s\n`);

  for (const name of Object.keys(refs)) {
    const series = refs[name];
    if (series.length < 12) {
      console.log(`${name}: not enough samples (${series.length})`);
      continue;
    }
    const n = Math.min(cg.length, series.length);
    const cgDeltas = [];
    const refDeltas = [];
    for (let i = 1; i < n; i += 1) {
      cgDeltas.push(cg[i].p - cg[i - 1].p);
      refDeltas.push(series[i].p - series[i - 1].p);
    }
    const { lag, corr } = bestLag(cgDeltas, refDeltas);
    const meanAbs = (arr) => arr.reduce((s, v) => s + Math.abs(v), 0) / arr.length;
    console.log(`${name}: best lag = ${lag} samples = ${lag * INTERVAL_MS / 1000}s (correlation ${corr.toFixed(3)})`);
    console.log(`  typical move: coin ${meanAbs(cgDeltas).toFixed(3)}   ${name} ${meanAbs(refDeltas).toFixed(3)}`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
