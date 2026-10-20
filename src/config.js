import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Node >= 20.12 can load .env natively. Absence of the file is not an error.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env present - rely on process.env + defaults */
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const str = (value, fallback) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : fallback;
};

const pair = str(process.env.PAIR, 'BNB/USDT');
const [baseSymbol, quoteSymbol] = pair.split('/');

// On a container host the state has to live on a mounted volume, so both
// directories can be pointed somewhere else.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const logDir = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(ROOT, 'logs');

export const config = {
  port: num(process.env.PORT, 3000),

  coingecko: {
    apiKey: str(process.env.COINGECKO_API_KEY, ''),
    // "demo" sends x-cg-demo-api-key, "pro" sends x-cg-pro-api-key
    keyType: str(process.env.COINGECKO_KEY_TYPE, 'demo').toLowerCase(),
    baseUrl: 'https://api.coingecko.com/api/v3',
  },

  market: {
    pair: pair.toUpperCase(),
    baseSymbol: str(process.env.BASE_SYMBOL, baseSymbol || 'BNB').toUpperCase(),
    quoteSymbol: str(process.env.QUOTE_SYMBOL, quoteSymbol || 'USDT').toUpperCase(),
    baseId: str(process.env.BASE_ID, 'binancecoin'),
    quoteId: str(process.env.QUOTE_ID, 'tether'),
  },

  strategy: {
    shortPeriod: num(process.env.SHORT_PERIOD, 10),
    longPeriod: num(process.env.LONG_PERIOD, 30),
    maType: str(process.env.MA_TYPE, 'sma').toLowerCase(),
  },

  feed: {
    // "binance" streams the live market over a websocket, "coingecko" polls
    // the aggregate price. The binance feed is the default because it is
    // real time; the coingecko feed is slow by design.
    source: str(process.env.FEED_SOURCE, 'binance').toLowerCase(),
    pollMs: num(process.env.POLL_MS, 20000),
    maxHistory: num(process.env.MAX_HISTORY, 2000),
    requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 15000),

    binance: {
      symbol: str(process.env.BINANCE_SYMBOL, 'BNBUSDT').toUpperCase(),
      // "perp" is the USD-M perpetual (BINANCE:BNBUSDT.P on TradingView),
      // "spot" is the spot market.
      market: str(process.env.BINANCE_MARKET, 'perp').toLowerCase(),
    },

    // Ticks are resampled into bars of this length and the moving averages
    // run over bar closes. 60000 means a bar is one minute, so a fast
    // average of 10 covers ten minutes.
    barMs: num(process.env.BAR_MS, 60000),
  },

  broker: {
    initialQuote: num(process.env.INITIAL_QUOTE, 10000),
    feeRate: num(process.env.FEE_RATE, 0.001),
    buyFraction: num(process.env.BUY_FRACTION, 0.98),
    minOrderQuote: num(process.env.MIN_ORDER_QUOTE, 10),
  },

  paths: {
    root: ROOT,
    data: dataDir,
    stateFile: path.join(dataDir, 'state.json'),
    public: path.join(ROOT, 'public'),
    logs: logDir,
  },

  auth: {
    // When no password is set the dashboard is open - fine on a laptop,
    // never fine on the public internet.
    user: str(process.env.AUTH_USER, 'admin'),
    password: str(process.env.AUTH_PASSWORD, ''),
    // Optional: a fixed secret for the session cookie. When absent it is
    // derived from the password, which means rotating the password
    // invalidates every existing session.
    secret: str(process.env.AUTH_SECRET, ''),
  },
};

/**
 * Normalises and bounds user/runtime supplied settings so a bad value can
 * never put the engine into an unrecoverable state.
 */
export function sanitiseSettings(input = {}) {
  const out = {};
  const short = num(input.shortPeriod, config.strategy.shortPeriod);
  const long = num(input.longPeriod, config.strategy.longPeriod);

  out.shortPeriod = Math.min(500, Math.max(2, Math.round(short)));
  out.longPeriod = Math.min(1000, Math.max(out.shortPeriod + 1, Math.round(long)));
  out.maType = ['sma', 'ema'].includes(String(input.maType).toLowerCase())
    ? String(input.maType).toLowerCase()
    : config.strategy.maType;
  out.pollMs = Math.min(300000, Math.max(2000, Math.round(num(input.pollMs, config.feed.pollMs))));
  out.barMs = Math.min(3600000, Math.max(1000, Math.round(num(input.barMs, config.feed.barMs))));
  out.buyFraction = Math.min(1, Math.max(0.01, num(input.buyFraction, config.broker.buyFraction)));
  out.feeRate = Math.min(0.05, Math.max(0, num(input.feeRate, config.broker.feeRate)));

  return out;
}
