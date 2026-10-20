import { EventEmitter } from 'node:events';
import { config, sanitiseSettings } from './config.js';
import { logger } from './logger.js';
import { fetchPairPrice, RateLimitError } from './coingecko.js';
import { evaluate, SIGNAL } from './strategy.js';
import { maSeries } from './indicators.js';
import { PaperBroker } from './broker.js';
import { Store } from './store.js';

const STATUS = {
  STARTING: 'starting',
  LIVE: 'live',
  RATE_LIMITED: 'rate-limited',
  ERROR: 'error',
  STOPPED: 'stopped',
};

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.store = new Store();
    this.settings = sanitiseSettings({});
    this.history = [];
    this.broker = new PaperBroker();
    this.status = STATUS.STARTING;
    this.lastError = null;
    this.lastFetchAt = null;
    this.nextPollAt = null;
    this.pollTimer = null;
    this.running = false;
    this.pollCount = 0;
    this.lastEvaluation = null;
    this.source = 'coingecko';
    this.change24h = null;

    this.restore();
  }

  // ---------------------------------------------------------------- lifecycle

  restore() {
    const saved = this.store.load();
    if (!saved) return;

    if (Array.isArray(saved.history)) {
      this.history = saved.history
        .filter((h) => Number.isFinite(h?.p) && Number.isFinite(h?.t))
        .slice(-config.feed.maxHistory);
    }
    if (saved.broker) {
      this.broker = PaperBroker.fromJSON(saved.broker, {
        initialQuote: saved.broker.initialQuote ?? config.broker.initialQuote,
        feeRate: this.settings.feeRate,
        buyFraction: this.settings.buyFraction,
      });
    }
    if (saved.settings) {
      this.settings = sanitiseSettings({ ...this.settings, ...saved.settings });
      this.broker.applySettings(this.settings);
    }
    if (saved.status === STATUS.LIVE) this.status = STATUS.STARTING;

    logger.info(
      `Restored session: ${this.history.length} bars, ${this.broker.trades.length} trades, equity ${this.broker.markToMarket(this.history.at(-1)?.p ?? 0).equity.toFixed(2)}`
    );
  }

  persist({ immediate = false } = {}) {
    this.store.save(
      {
        savedAt: Date.now(),
        history: this.history,
        broker: this.broker.toJSON(),
        settings: this.settings,
      },
      { immediate }
    );
  }

  async start() {
    if (this.running) return;
    this.running = true;
    logger.info(`Engine starting on ${config.market.pair} (${this.settings.maType.toUpperCase()} ${this.settings.shortPeriod}/${this.settings.longPeriod})`);
    await this.poll();
    this.scheduleNext();
    this.emit('state', this.getState());
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.status = STATUS.STOPPED;
    this.persist({ immediate: true });
    logger.info('Engine stopped');
  }

  scheduleNext(delayOverride) {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const delay = delayOverride ?? this.settings.pollMs;
    this.nextPollAt = Date.now() + delay;
    this.pollTimer = setTimeout(() => {
      this.poll().catch((err) => logger.error(`Poll loop crashed: ${err.message}`));
    }, delay);
    this.pollTimer.unref?.();
    this.emit('state', this.getState());
  }

  // --------------------------------------------------------------------- feed

  /** Pulls a fresh price from CoinGecko and feeds it into the pipeline. */
  async poll() {
    try {
      const result = await fetchPairPrice(config.market.baseId, config.market.quoteId);
      this.source = 'coingecko';
      this.status = STATUS.LIVE;
      this.lastError = null;
      this.lastFetchAt = result.fetchedAt;
      this.change24h = result.change24h;
      this.pollCount += 1;
      this.ingest(result.price, 'coingecko');
      if (this.running) this.scheduleNext();
    } catch (err) {
      this.handleFeedError(err);
      if (this.running) {
        const backoff = err instanceof RateLimitError ? Math.min(err.retryAfterMs, 300000) : Math.min(this.settings.pollMs * 2, 120000);
        this.scheduleNext(backoff);
      }
    }
  }

  handleFeedError(err) {
    this.lastError = err.message;
    if (err instanceof RateLimitError) {
      this.status = STATUS.RATE_LIMITED;
      logger.warn(`Rate limited by CoinGecko - pausing for ${Math.round(err.retryAfterMs / 1000)}s`);
    } else {
      this.status = STATUS.ERROR;
      logger.error(`Feed error: ${err.message}`);
    }
    this.emit('state', this.getState());
  }

  /**
   * Feeds a price into the pipeline. This is the single entry point for data,
   * whether it came from CoinGecko or was pushed in manually.
   *
   * @param {number} price
   * @param {string} source
   * @param {number|null} timestamp epoch ms; supply one to replay history
   */
  ingest(price, source = 'manual', timestamp = null) {
    if (!Number.isFinite(price) || price <= 0) {
      logger.warn(`Ignored invalid price: ${price}`);
      return null;
    }

    const ts = Number.isFinite(timestamp) ? timestamp : Date.now();
    this.source = source;
    this.history.push({ t: ts, p: price });
    if (this.history.length > config.feed.maxHistory) {
      this.history = this.history.slice(-config.feed.maxHistory);
    }

    const evaluation = evaluate(this.history, this.settings);
    this.lastEvaluation = evaluation;

    let trade = null;
    if (evaluation.signal === SIGNAL.BUY) {
      const result = this.broker.buy(price, evaluation.reason, ts);
      if (result.ok) {
        trade = result.trade;
        logger.trade(`BUY ${config.market.baseSymbol} @ ${price.toPrecision(6)} - ${evaluation.reason}`);
      } else {
        logger.warn(`Buy signal skipped: ${result.reason}`);
      }
    } else if (evaluation.signal === SIGNAL.SELL) {
      const result = this.broker.sell(price, evaluation.reason, ts);
      if (result.ok) {
        trade = result.trade;
        logger.trade(`SELL ${config.market.baseSymbol} @ ${price.toPrecision(6)} - ${evaluation.reason}`);
      } else {
        logger.warn(`Sell signal skipped: ${result.reason}`);
      }
    }

    this.broker.recordEquity(ts, price);

    if (trade) this.emit('trade', trade);
    this.emit('state', this.getState());
    this.persist();
    return { evaluation, trade };
  }

  // ------------------------------------------------------------------ control

  updateSettings(patch) {
    this.settings = sanitiseSettings({ ...this.settings, ...patch });
    this.broker.applySettings(this.settings);
    logger.info(`Settings updated: ${JSON.stringify(this.settings)}`);
    // Apply the new poll interval immediately rather than waiting for the
    // pending timer to fire.
    if (this.running) this.scheduleNext();
    this.emit('state', this.getState());
    return this.settings;
  }

  /** Manual order placed from the dashboard, outside the crossover logic. */
  manualTrade(side, price, quoteAmount) {
    const executionPrice = Number(price) || this.history.at(-1)?.p;
    if (!Number.isFinite(executionPrice)) return { ok: false, reason: 'No price available yet' };
    const timestamp = this.history.at(-1)?.t ?? Date.now();

    let result;
    if (String(side).toUpperCase() === 'BUY') {
      if (Number.isFinite(quoteAmount) && quoteAmount > 0) {
        const fraction = Math.min(1, quoteAmount / this.broker.quote);
        const previous = this.broker.settings.buyFraction;
        this.broker.settings.buyFraction = fraction;
        result = this.broker.buy(executionPrice, 'manual', timestamp);
        this.broker.settings.buyFraction = previous;
      } else {
        result = this.broker.buy(executionPrice, 'manual', timestamp);
      }
    } else if (String(side).toUpperCase() === 'SELL') {
      result = this.broker.sell(executionPrice, 'manual', timestamp);
    } else {
      return { ok: false, reason: `Unknown side "${side}"` };
    }

    if (result.ok) {
      logger.trade(`Manual ${String(side).toUpperCase()} ${config.market.baseSymbol} @ ${executionPrice.toPrecision(6)}`);
      this.broker.recordEquity(timestamp, executionPrice);
      this.emit('trade', result.trade);
      this.emit('state', this.getState());
      this.persist();
    }
    return result;
  }

  reset() {
    this.history = [];
    this.broker.reset(config.broker.initialQuote);
    this.lastEvaluation = null;
    this.persist({ immediate: true });
    logger.info('Session reset - paper account cleared');
    this.emit('state', this.getState());
  }

  // -------------------------------------------------------------------- state

  getState() {
    const last = this.history.at(-1);
    const price = last?.p ?? null;
    const snapshot = this.broker.markToMarket(price ?? 0);

    const chartWindow = this.history.slice(-600);
    const offset = this.history.length - chartWindow.length;
    const fastSeries = maSeries(chartWindow, this.settings.shortPeriod, this.settings.maType);
    const slowSeries = maSeries(chartWindow, this.settings.longPeriod, this.settings.maType);

    const first = chartWindow[0];
    const prevClose = this.history.length > 1 ? this.history[this.history.length - 2].p : price;

    const windowCloses = chartWindow.map((h) => h.p);
    const session = windowCloses.length
      ? { high: Math.max(...windowCloses), low: Math.min(...windowCloses) }
      : { high: null, low: null };

    return {
      pair: config.market.pair,
      baseSymbol: config.market.baseSymbol,
      quoteSymbol: config.market.quoteSymbol,
      status: this.status,
      source: this.source,
      lastError: this.lastError,
      lastFetchAt: this.lastFetchAt,
      nextPollAt: this.nextPollAt,
      pollCount: this.pollCount,
      running: this.running,
      settings: this.settings,
      price,
      prevClose,
      changePct: price && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      change24h: this.change24h,
      evaluation: this.lastEvaluation,
      session,
      account: snapshot,
      trades: this.broker.trades.slice(-200),
      equityCurve: this.broker.equityCurve.slice(-600),
      series: {
        times: chartWindow.map((h) => h.t),
        closes: chartWindow.map((h) => h.p),
        fast: fastSeries,
        slow: slowSeries,
      },
      bars: this.history.length,
      market: {
        baseId: config.market.baseId,
        quoteId: config.market.quoteId,
        apiKeyConfigured: Boolean(config.coingecko.apiKey),
        keyType: config.coingecko.apiKey ? config.coingecko.keyType : 'none',
      },
      firstTs: first?.t ?? null,
    };
  }
}

export { STATUS };
