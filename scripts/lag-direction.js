/**
 * Tests whether the bot's price is systematically offset from the market or
 * simply lags behind it. Samples the bot's exact derivation against a live
 * venue and correlates the gap with recent price direction.
 *
 *   node scripts/lag-direction.js [seconds]
 */
const KEY = process.env.COINGECKO_API_KEY || '';
const DURATION_S = Number(process.argv[2] || 240);
const INTERVAL_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function botPrice() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,tether&vs_currencies=usd&precision=full',
    { headers: { accept: 'application/json', 'x-cg-demo-api-key': KEY } }
  );
  const j = await res.json();
  return j.binancecoin.usd / j.tether.usd;
}

async function venuePrice() {
  const r = await fetch('https://api.binance.us/api/v3/ticker/price?symbol=BNBUSDT');
  return Number((await r.json()).price);
}

async function main() {
  const bot = [];
  const venue = [];
  const start = Date.now();

  while (Date.now() - start < DURATION_S * 1000) {
    const t = Date.now();
    const [b, v] = await Promise.allSettled([botPrice(), venuePrice()]);
    if (b.status === 'fulfilled') bot.push({ t, p: b.value });
    if (v.status === 'fulfilled') venue.push({ t, p: v.value });
    await sleep(INTERVAL_MS);
  }

  const n = Math.min(bot.length, venue.length);
  if (n < 10) { console.log('not enough samples'); return; }

  const diffs = [];
  for (let i = 0; i < n; i += 1) diffs.push(bot[i].p - venue[i].p);

  const below = diffs.filter((d) => d < 0).length;
  const above = diffs.filter((d) => d > 0).length;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const absMean = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;
  const sorted = [...diffs].sort((a, b) => a - b);

  console.log(`sampled ${n} pairs over ${DURATION_S}s\n`);
  console.log(`bot price minus live venue price:`);
  console.log(`  mean   ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}   (${((mean / venue[n - 1].p) * 100).toFixed(3)}%)`);
  console.log(`  mean |gap|  ${absMean.toFixed(3)}`);
  console.log(`  median ${sorted[Math.floor(n / 2)].toFixed(3)}`);
  console.log(`  range  ${sorted[0].toFixed(3)} .. ${sorted[n - 1].toFixed(3)}`);
  console.log(`  bot BELOW venue : ${below} samples (${Math.round((below / n) * 100)}%)`);
  console.log(`  bot ABOVE venue : ${above} samples (${Math.round((above / n) * 100)}%)`);

  // If the gap tracks the market's direction, it is lag rather than a bias.
  const pairs = [];
  for (let i = 1; i < n; i += 1) {
    pairs.push({ move: venue[i].p - venue[i - 1].p, gap: diffs[i] });
  }
  const mm = pairs.reduce((s, p) => s + p.move, 0) / pairs.length;
  const gm = pairs.reduce((s, p) => s + p.gap, 0) / pairs.length;
  let num = 0; let d1 = 0; let d2 = 0;
  for (const p of pairs) {
    const x = p.move - mm;
    const y = p.gap - gm;
    num += x * y; d1 += x * x; d2 += y * y;
  }
  const corr = d1 && d2 ? num / Math.sqrt(d1 * d2) : 0;
  console.log(`\ncorrelation between the venue's last move and the gap: ${corr.toFixed(3)}`);
  console.log(corr < -0.4
    ? '  -> gap grows as the market rises: the bot price is LAGGING, not offset'
    : corr > 0.4
      ? '  -> gap grows as the market falls: also consistent with lag'
      : '  -> weak relationship; check for a fixed offset');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
