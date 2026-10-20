/**
 * Seeds the dashboard with a realistic BNB/USDT series so the chart, the
 * averages and the fills table can be reviewed without waiting on the feed.
 *
 *   node scripts/seed-demo.js [http://localhost:3000]
 */
const base = process.argv[2] || 'http://localhost:3000';

const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  return response.json();
};

// A gentle wave with noise: trends up, pulls back, trends up again. This is
// shaped so the fast average crosses the slow one more than once.
const wave = (i, length) => {
  const t = i / length;
  const primary = Math.sin(t * Math.PI * 3.1) * 26;
  const secondary = Math.sin(t * Math.PI * 6.4) * 9;
  const drift = t * 18;
  return primary + secondary + drift;
};

async function main() {
  await post('/api/reset', {});
  await post('/api/settings', { shortPeriod: 8, longPeriod: 24, maType: 'sma' });

  const length = 120;
  // Lay the ticks out one minute apart, ending now, so the time axis reads
  // like a real session rather than a burst of identical timestamps.
  const stepMs = 60000;
  const end = Date.now();
  const start = end - (length - 1) * stepMs;

  let price = 712;

  for (let i = 0; i < length; i += 1) {
    const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    price += wave(i, length) / length + noise * 0.6;
    const rounded = Math.round(price * 100) / 100;
    const t = start + i * stepMs;

    const result = await post('/api/tick', { price: rounded, t });
    if (result.signal !== 'HOLD') {
      console.log(`  ${result.signal.padEnd(4)} @ ${rounded}  ${new Date(t).toLocaleTimeString()}`);
    }
  }

  const { state } = await post('/api/poll', {});
  console.log(`\nseeded ${length} bars, ${state.trades.length} fills`);
  console.log(`price ${state.price?.toFixed(2)}  equity ${state.account.equity.toFixed(2)}  P&L ${state.account.totalPnl.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
