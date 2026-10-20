import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Live Binance feed.
 *
 * Two markets are supported:
 *   perp - the USD-M perpetual (BINANCE:BNBUSDT.P on TradingView)
 *          wss://fstream.binance.com/ws/<symbol>@bookTicker
 *   spot - spot trading
 *          wss://stream.binance.com:9443/ws/<symbol>@bookTicker
 *
 * The socket pushes on every price change, which is far too fast to feed a
 * moving-average crossover directly. Ticks are therefore resampled into
 * fixed bars and the averages run over bar closes, so "fast 10 / slow 30"
 * means ten and thirty bars rather than ten and thirty individual prints.
 */
export class BinanceFeed extends EventEmitter {
  constructor({ symbol = 'BNBUSDT', market = 'perp', barMs = 60000, staleMs = 90000 } = {}) {
    super();
    this.symbol = String(symbol).toUpperCase();
    this.market = market === 'spot' ? 'spot' : 'perp';
    this.barMs = Math.max(1000, barMs);
    this.staleMs = staleMs;

    this.state = 'idle';
    this.lastPrice = null;
    this.change24h = null;
    this.lastTickAt = null;
    this.lastMessageAt = null;
    this.bar = null;
    this.barCount = 0;

    this.socket = null;
    this.barTimer = null;
    this.statsTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
  }

  get wsUrl() {
    const host = this.market === 'perp' ? 'wss://fstream.binance.com/ws' : 'wss://stream.binance.com:9443/ws';
    return `${host}/${this.symbol.toLowerCase()}@bookTicker`;
  }

  get statsUrl() {
    const base = this.market === 'perp' ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
    return `${base}/ticker/24hr?symbol=${this.symbol}`;
  }

  get label() {
    return this.market === 'perp' ? 'Binance perp' : 'Binance spot';
  }

  start() {
    this.stopped = false;
    this.connect();

    // Bars close on a wall-clock schedule whether or not ticks arrive, so
    // the series stays evenly spaced.
    this.barTimer = setInterval(() => this.closeBar(), this.barMs);
    this.barTimer.unref?.();

    this.fetchStats();
    this.statsTimer = setInterval(() => this.fetchStats(), 5 * 60 * 1000);
    this.statsTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.barTimer);
    clearInterval(this.statsTimer);
    clearTimeout(this.reconnectTimer);
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }
    this.socket = null;
    this.state = 'stopped';
  }

  /**
   * Changes the bar length. Bars already collected keep their original
   * spacing, so the cleanest time to change this is on a fresh session.
   */
  setBarMs(barMs) {
    const next = Math.max(1000, Math.round(barMs));
    if (next === this.barMs) return;
    this.barMs = next;
    clearInterval(this.barTimer);
    this.barTimer = setInterval(() => this.closeBar(), this.barMs);
    this.barTimer.unref?.();
    this.emit('status', this.status());
  }

  connect() {
    if (this.stopped) return;
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let socket;
    try {
      socket = new WebSocket(this.wsUrl);
    } catch (err) {
      logger.error(`Binance socket could not be created: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.setState('live');
      logger.info(`Binance ${this.market} connected for ${this.symbol}`);
    });

    socket.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const bid = Number(message.b);
      const ask = Number(message.a);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;

      // Mid price: the spread on a liquid perp is a fraction of a cent, and
      // the mid is the fairest single number to chart and to trade on.
      this.onTick((bid + ask) / 2);
    });

    socket.on('error', (err) => {
      logger.warn(`Binance socket error: ${err.message}`);
    });

    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.setState('reconnecting');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    logger.warn(`Binance ${this.market} disconnected - reconnecting in ${Math.round(delay / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', this.status());
  }

  status() {
    return {
      state: this.state,
      label: this.label,
      symbol: this.symbol,
      market: this.market,
      barMs: this.barMs,
      lastPrice: this.lastPrice,
      change24h: this.change24h,
      lastTickAt: this.lastTickAt,
      barCount: this.barCount,
    };
  }

  onTick(price) {
    const now = Date.now();
    this.lastPrice = price;
    this.lastTickAt = now;

    // A silent connection is a dead connection; force a reconnect.
    if (this.state === 'live' && this.lastMessageAt && now - this.lastMessageAt > this.staleMs) {
      logger.warn('Binance feed went quiet - reconnecting');
      this.socket?.terminate();
      return;
    }

    if (!this.bar) {
      this.bar = { t: now, open: price, high: price, low: price, close: price };
    } else {
      this.bar.high = Math.max(this.bar.high, price);
      this.bar.low = Math.min(this.bar.low, price);
      this.bar.close = price;
    }

    this.emit('tick', { price, t: now });
  }

  closeBar() {
    if (!this.bar) return;
    const bar = this.bar;
    this.bar = null;
    this.barCount += 1;
    this.emit('bar', { ...bar, t: bar.t + this.barMs });
  }

  /** Rolling 24 hour statistics, used only for the dashboard headline. */
  async fetchStats() {
    try {
      const response = await fetch(this.statsUrl, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const change = Number(payload.priceChangePercent);
      if (Number.isFinite(change)) {
        this.change24h = change;
        this.emit('status', this.status());
        return;
      }
      throw new Error('no change figure in the response');
    } catch {
      // The exchange statistics endpoint is blocked in some regions. The
      // 24 hour figure is cosmetic, so fall back to the aggregate feed
      // rather than leaving it blank.
      await this.fetchStatsFallback();
    }
  }

  async fetchStatsFallback() {
    try {
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd&precision=full&include_24hr_change=true';
      const headers = {};
      if (config.coingecko.apiKey) {
        headers[config.coingecko.keyType === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = config.coingecko.apiKey;
      }
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const change = Number(payload?.binancecoin?.usd_24h_change);
      if (Number.isFinite(change)) {
        this.change24h = change;
        this.emit('status', this.status());
      }
    } catch {
      // Nothing more to try; the headline simply shows no 24 hour figure.
    }
  }
}
