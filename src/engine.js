import { EventEmitter } from 'node:events';
import { config, sanitiseSettings } from './config.js';
import { logger } from './logger.js';
import { fetchPairPrice, RateLimitError } from './coingecko.js';
import { BinanceFeed } from './feeds/binance.js';
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
    this.source = config.feed.source === 'binance' ? 'binance' : 'coingecko';
    this.change24h = null;

    // The newest traded price, which can be far newer than the last bar
    // close. The averages run over bars; the headline shows this.
    this.livePrice = null;
    this.livePriceAt = null;
    this.broadcastTimer = null;
    this.pendingBroadcast = false;

    this.feed = null;

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
    logger.info(
      `Engine starting on ${config.market.pair} (${this.settings.maType.toUpperCase()} ${this.settings.shortPeriod}/${this.settings.longPeriod})`
    );

    if (this.source === 'binance') {
      this.startBinanceFeed();
    } else {
      await this.poll();
      this.scheduleNext();
    }
    this.emit('state', this.getState());
  }

  /**
   * Streams the live market over a websocket. Ticks update the headline
   * price immediately; the bar closes drive the averages.
   */
  startBinanceFeed() {
    this.feed = new BinanceFeed({
      symbol: config.feed.binance.symbol,
      market: config.feed.binance.market,
      barMs: this.settings.barMs ?? config.feed.barMs,
    });

    this.feed.on('tick', ({ price }) => {
      this.lastFetchAt = Date.now();
      this.updateLivePrice(price);
    });

    this.feed.on('bar', (bar) => {
      this.ingest(bar.close, 'binance', bar.t);
    });

    this.feed.on('status', (status) => {
      if (status.change24h != null) this.change24h = status.change24h;
      if (status.state === 'live') {
        this.status = STATUS.LIVE;
        this.lastError = null;
      } else if (status.state === 'reconnecting' || status.state === 'connecting') {
        if (this.status === STATUS.LIVE) this.status = STATUS.STARTING;
      }
      this.emit('state', this.getState());
    });

    this.feed.start();
    logger.info(
      `Feed: ${this.feed.label} ${this.feed.symbol} streaming, bars of ${Math.round(this.feed.barMs / 1000)}s`
    );
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    if (this.feed) this.feed.stop();
    this.feed = null;
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
   * Records the newest traded price without touching the bar series.
   *
   * A websocket feed produces many ticks a second, so the broadcast is
   * throttled - the dashboard does not need a message per print.
   */
  updateLivePrice(price) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.livePrice = price;
    this.livePriceAt = Date.now();

    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit('state', this.getState());
    }, 500);
    this.broadcastTimer.unref?.();
  }

  /**
   * Feeds a price into the pipeline. This is the single entry point for data,
   * whether it came from a bar close, from CoinGecko or was pushed in manually.
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
    this.livePrice = price;
    this.livePriceAt = ts;
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
    if (this.feed) this.feed.setBarMs(this.settings.barMs);
    logger.info(`Settings updated: ${JSON.stringify(this.settings)}`);
    // Apply the new poll interval immediately rather than waiting for the
    // pending timer to fire.
    if (this.running && this.source === 'coingecko') this.scheduleNext();
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
    // The headline price is the newest trade, which for a websocket feed is
    // far newer than the last bar close the averages are built on.
    const price = this.livePrice ?? last?.p ?? null;
    const barClose = last?.p ?? null;
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
      sourceLabel: this.source === 'binance' ? (this.feed?.label ?? 'Binance') : 'CoinGecko',
      lastError: this.lastError,
      lastFetchAt: this.lastFetchAt,
      livePriceAt: this.livePriceAt,
      nextPollAt: this.nextPollAt,
      pollCount: this.pollCount,
      running: this.running,
      settings: this.settings,
      price,
      barClose,
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
        feedSource: this.source,
        binanceSymbol: config.feed.binance.symbol,
        binanceMarket: config.feed.binance.market,
        barMs: this.settings.barMs ?? config.feed.barMs,
        feedState: this.feed?.state ?? null,
      },
      firstTs: first?.t ?? null,
    };
  }
}

export { STATUS };
