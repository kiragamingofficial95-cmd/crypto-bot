/**
 * Moving-average maths. Every function is pure so the strategy layer can ask
 * "what did the averages look like one bar ago?" without keeping shadow state
 * that could drift out of sync with the price history.
 */

/** Simple moving average of the last `period` values. */
export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return null;
  const window = values.slice(-period);
  let sum = 0;
  for (const v of window) sum += v;
  return sum / period;
}

/**
 * Exponential moving average seeded with the SMA of the first `period` values.
 * Returns the full series so callers can read any index, not just the tail.
 */
export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return [];
  const out = new Array(values.length).fill(null);

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;

  const k = 2 / (period + 1);
  let prev = out[period - 1];
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA value at a specific index, or null when there isn't enough history. */
export function emaAt(values, period, index) {
  if (index >= values.length) return null;
  const series = emaSeries(values.slice(0, index + 1), period);
  return series.length ? series[series.length - 1] : null;
}

/**
 * Returns the value of a moving average ending at `index` (inclusive).
 * `history` is an array of { t, p } price points.
 */
export function maAt(history, index, period, type) {
  if (index < 0) return null;
  const values = history.slice(0, index + 1).map((h) => h.p);
  if (type === 'ema') return emaAt(values, period, values.length - 1);
  return sma(values, period);
}

/**
 * Full moving-average series aligned index-for-index with `history`.
 * SMA uses a rolling window sum and EMA is computed once, so both are O(n)
 * rather than the O(n * period) you get from calling `maAt` per bar.
 */
export function maSeries(history, period, type) {
  const n = history.length;
  const out = new Array(n).fill(null);
  if (n < period || period < 1) return out;

  if (type === 'ema') {
    const series = emaSeries(history.map((h) => h.p), period);
    for (let i = 0; i < n; i += 1) out[i] = series[i] ?? null;
    return out;
  }

  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += history[i].p;
  out[period - 1] = sum / period;
  for (let i = period; i < n; i += 1) {
    sum += history[i].p - history[i - period].p;
    out[i] = sum / period;
  }
  return out;
}

/**
 * The price at which the fast average would meet the slow average on the next
 * bar. It is the level the market has to reach for the bot to act:
 * above it the recent average crosses up (buy), below it it crosses back
 * down (sell).
 *
 * For a simple moving average both averages are linear in the next price, so
 * the crossing has a closed form. An exponential average is not linear, so it
 * is found by bisection.
 */
export function triggerPrice(history, settings) {
  const { shortPeriod: k, longPeriod: m, maType } = settings;
  if (!history.length || history.length < m || !(m > k)) return null;

  const closes = history.map((h) => h.p);

  if (maType === 'ema') {
    // The final EMA value is linear in the next price:
    //   ema_last = P * alpha + ema_prev * (1 - alpha)
    // and ema_prev depends only on earlier bars, so the crossing of the two
    // averages can be solved for directly.
    const alphaFast = 2 / (k + 1);
    const alphaSlow = 2 / (m + 1);
    const prevFast = emaAt(closes, k, closes.length - 1);
    const prevSlow = emaAt(closes, m, closes.length - 1);
    if (prevFast == null || prevSlow == null) return null;

    const numerator = (1 - alphaSlow) * prevSlow - (1 - alphaFast) * prevFast;
    const denominator = alphaFast - alphaSlow;
    if (denominator === 0) return null;
    return numerator / denominator;
  }

  // Simple average: fast = (sumFast + P) / k, slow = (sumSlow + P) / m.
  let sumFast = 0;
  for (let i = closes.length - (k - 1); i < closes.length; i += 1) sumFast += closes[i];
  let sumSlow = 0;
  for (let i = closes.length - (m - 1); i < closes.length; i += 1) sumSlow += closes[i];
  return (sumSlow * k - sumFast * m) / (m - k);
}

/**
 * The pair of averages (recent + longer) as of a given bar, plus the same
 * pair one bar earlier. `previous` is what the crossover test compares
 * against to avoid firing the same signal on every subsequent tick.
 */
export function maPairAt(history, index, { shortPeriod, longPeriod, maType }) {
  const current = {
    short: maAt(history, index, shortPeriod, maType),
    long: maAt(history, index, longPeriod, maType),
  };

  const previous = {
    short: maAt(history, index - 1, shortPeriod, maType),
    long: maAt(history, index - 1, longPeriod, maType),
  };

  return { current, previous };
}
