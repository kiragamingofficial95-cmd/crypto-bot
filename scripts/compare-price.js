/**
 * Compares the price the bot displays (CoinGecko BNB/USDT) against the
 * live price on each major venue, to explain any difference.
 *
 *   node scripts/compare-price.js
 */
const KEY = process.env.COINGECKO_API_KEY || '';

async function coingecko() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,tether&vs_currencies=usd&precision=full',
    { headers: { accept: 'application/json', 'x-cg-demo-api-key': KEY } }
  );
  const j = await res.json();
  return { bnb: j.binancecoin.usd, usdt: j.tether.usd, derived: j.binancecoin.usd / j.tether.usd };
}

async function binanceUs() {
  const r = await fetch('https://api.binance.us/api/v3/ticker/price?symbol=BNBUSDT');
  return Number((await r.json()).price);
}

async function coinbase() {
  const r = await fetch('https://api.exchange.coinbase.com/products/BNB-USD/ticker');
  const j = await r.json();
  return { bid: Number(j.bid), ask: Number(j.ask), mid: (Number(j.bid) + Number(j.ask)) / 2 };
}

async function kraken() {
  const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=BNBUSD');
  const j = await r.json();
  const t = j.result.XXXXXXZUSD || Object.values(j.result)[0];
  return { bid: Number(t.b[0]), ask: Number(t.a[0]), mid: (Number(t.b[0]) + Number(t.a[0])) / 2 };
}

async function coinbaseBnbUsdt() {
  // Coinbase does not list BNB/USDT; BNB/USD is the closest equivalent.
  return null;
}

async function main() {
  const t = new Date().toISOString();
  const [cg, b, cb, kr] = await Promise.allSettled([coingecko(), binanceUs(), coinbase(), kraken()]);

  const get = (r, fallback = null) => (r.status === 'fulfilled' ? r.value : fallback);
  const cgv = get(cg);
  const bin = get(b);
  const cbv = get(cb);
  const krv = get(kr);

  console.log(`sampled at ${t}\n`);
  console.log('--- what the bot shows ---');
  if (cgv) {
    console.log(`  CoinGecko BNB/USD   ${cgv.bnb.toFixed(4)}`);
    console.log(`  CoinGecko USDT/USD  ${cgv.usdt.toFixed(6)}   (USDT is NOT exactly $1)`);
    console.log(`  derived BNB/USDT    ${cgv.derived.toFixed(4)}   <- the dashboard price`);
  }

  console.log('\n--- live venues ---');
  if (bin) console.log(`  Binance US BNBUSDT  ${bin.toFixed(4)}`);
  if (cbv) console.log(`  Coinbase BNB-USD    ${cbv.mid.toFixed(4)}  (bid ${cbv.bid} / ask ${cbv.ask})`);
  if (krv) console.log(`  Kraken BNBUSD       ${krv.mid.toFixed(4)}  (bid ${krv.bid} / ask ${krv.ask})`);

  if (!cgv) return;

  console.log('\n--- the bot price vs each venue ---');
  const compare = (label, value) => {
    if (value == null) return;
    const diff = cgv.derived - value;
    console.log(`  vs ${label.padEnd(22)} ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}  (${((diff / value) * 100).toFixed(3)}%)`);
  };
  compare('Binance US', bin);
  compare('Coinbase mid', cbv?.mid);
  compare('Kraken mid', krv?.mid);

  console.log('\n--- what the divergence is made of ---');
  if (bin) {
    const cgRaw = cgv.bnb;
    const derived = cgv.derived;
    console.log(`  CoinGecko raw BNB/USD vs Binance US : ${(cgRaw - bin).toFixed(3)}  (${(((cgRaw - bin) / bin) * 100).toFixed(3)}%)`);
    console.log(`  effect of dividing by USDT (${cgv.usdt.toFixed(5)}) : ${(derived - cgRaw).toFixed(3)}  (${(((derived - cgRaw) / cgRaw) * 100).toFixed(3)}%)`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
