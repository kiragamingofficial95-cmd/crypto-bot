import { config } from './config.js';
import { logger } from './logger.js';

const KEY_HEADERS = {
  demo: 'x-cg-demo-api-key',
  pro: 'x-cg-pro-api-key',
};

function authHeaders() {
  const { apiKey, keyType } = config.coingecko;
  if (!apiKey) return {};
  const header = KEY_HEADERS[keyType];
  if (!header) {
    logger.warn(`Unknown COINGECKO_KEY_TYPE "${keyType}" - sending no key header. Use "demo" or "pro".`);
    return {};
  }
  return { [header]: apiKey };
}

export class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

async function request(path, params) {
  // The base URL has a path segment ("/api/v3"), so the relative path must not
  // start with a slash or URL resolution would discard that prefix.
  const base = config.coingecko.baseUrl.endsWith('/') ? config.coingecko.baseUrl : `${config.coingecko.baseUrl}/`;
  const url = new URL(path.replace(/^\//, ''), base);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(config.feed.requestTimeoutMs),
    });
  } catch (err) {
    throw new Error(`CoinGecko request failed: ${err.message}`);
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    const resetAt = Number(response.headers.get('x-ratelimit-reset')) || 0;
    const retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : resetAt > 0 ? Math.max(0, resetAt * 1000 - Date.now()) : 60000;
    throw new RateLimitError('CoinGecko rate limit reached', retryAfterMs);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`CoinGecko HTTP ${response.status} ${response.statusText} ${body.slice(0, 200)}`.trim());
  }

  return response.json();
}

/**
 * Fetches the price of `baseId` and `quoteId` denominated in USD, then derives
 * the direct BASE/QUOTE rate by dividing the two. CoinGecko has no native
 * BNB/USDT market, so this ratio is the faithful equivalent of the pair.
 */
async function fetchUsdPrices(baseId, quoteId) {
  const ids = quoteId === baseId ? [baseId] : [baseId, quoteId];
  const payload = await request('/simple/price', {
    ids: ids.join(','),
    vs_currencies: 'usd',
    precision: 'full',
    include_24hr_change: 'true',
  });

  const baseUsd = Number(payload?.[baseId]?.usd);
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) {
    throw new Error(`CoinGecko returned no USD price for "${baseId}"`);
  }

  let quoteUsd = 1;
  let change24h = null;
  const rawChange = Number(payload?.[baseId]?.usd_24h_change);
  if (Number.isFinite(rawChange)) change24h = rawChange;

  if (quoteId !== baseId) {
    const parsed = Number(payload?.[quoteId]?.usd);
    if (Number.isFinite(parsed) && parsed > 0) quoteUsd = parsed;
  }

  return { baseUsd, quoteUsd, change24h };
}

/** Fallback path when /simple/price misbehaves for a given id set. */
async function fetchUsdPricesViaMarkets(baseId, quoteId) {
  const ids = quoteId === baseId ? [baseId] : [baseId, quoteId];
  const payload = await request('/coins/markets', {
    vs_currency: 'usd',
    ids: ids.join(','),
    precision: 'full',
    per_page: ids.length,
  });

  const row = (id) => payload.find((entry) => entry.id === id);
  const baseUsd = Number(row(baseId)?.current_price);
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) {
    throw new Error(`CoinGecko markets returned no USD price for "${baseId}"`);
  }
  let quoteUsd = 1;
  if (quoteId !== baseId) {
    const parsed = Number(row(quoteId)?.current_price);
    if (Number.isFinite(parsed) && parsed > 0) quoteUsd = parsed;
  }
  const rawChange = Number(row(baseId)?.price_change_percentage_24h);
  const change24h = Number.isFinite(rawChange) ? rawChange : null;
  return { baseUsd, quoteUsd, change24h };
}

/**
 * @returns {Promise<{price:number, baseUsd:number, quoteUsd:number, fetchedAt:number}>}
 */
export async function fetchPairPrice(baseId = config.market.baseId, quoteId = config.market.quoteId) {
  let usd;
  try {
    usd = await fetchUsdPrices(baseId, quoteId);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    if (/\bHTTP 404\b/.test(err.message)) throw err; // wrong path - the fallback would 404 too
    logger.warn(`simple/price failed (${err.message}) - falling back to /coins/markets`);
    usd = await fetchUsdPricesViaMarkets(baseId, quoteId);
  }

  const price = usd.baseUsd / usd.quoteUsd;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Derived an invalid pair price (${price})`);
  }

  return { price, baseUsd: usd.baseUsd, quoteUsd: usd.quoteUsd, change24h: usd.change24h ?? null, fetchedAt: Date.now() };
}

/** Cheap liveness probe used by the dashboard's status chip. */
export async function ping() {
  const started = Date.now();
  await request('/ping', {});
  return Date.now() - started;
}
