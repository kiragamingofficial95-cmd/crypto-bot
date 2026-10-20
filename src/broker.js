import { config } from './config.js';

let tradeCounter = 0;
const nextTradeId = () => {
  tradeCounter += 1;
  return `t${Date.now().toString(36)}${tradeCounter.toString(36)}`;
};

/**
 * Simulated spot broker for a single pair. Buys spend the quote currency
 * (USDT), sells liquidate the whole base position (BNB). Fees are charged in
 * the currency received, which mirrors how exchanges settle spot trades.
 */
export class PaperBroker {
  constructor(options = {}) {
    this.quote = options.initialQuote ?? config.broker.initialQuote;
    this.base = 0;
    this.avgCost = 0;
    this.realisedPnl = 0;
    this.feesPaid = 0;
    this.trades = [];
    this.equityCurve = [];
    this.equityCounter = 0;
    this.settings = {
      feeRate: options.feeRate ?? config.broker.feeRate,
      buyFraction: options.buyFraction ?? config.broker.buyFraction,
      minOrderQuote: options.minOrderQuote ?? config.broker.minOrderQuote,
    };
    this.initialQuote = this.quote;
  }

  applySettings(patch = {}) {
    if (typeof patch.feeRate === 'number') this.settings.feeRate = patch.feeRate;
    if (typeof patch.buyFraction === 'number') this.settings.buyFraction = patch.buyFraction;
    if (typeof patch.minOrderQuote === 'number') this.settings.minOrderQuote = patch.minOrderQuote;
  }

  get hasPosition() {
    return this.base > 1e-12;
  }

  /** Portfolio value in quote currency at the given market price. */
  markToMarket(price) {
    const positionValue = this.base * price;
    const equity = this.quote + positionValue;
    return {
      quote: this.quote,
      base: this.base,
      positionValue,
      equity,
      unrealisedPnl: this.hasPosition ? positionValue - this.avgCost * this.base : 0,
      realisedPnl: this.realisedPnl,
      totalPnl: equity - this.initialQuote,
      totalPnlPct: this.initialQuote ? ((equity - this.initialQuote) / this.initialQuote) * 100 : 0,
      avgCost: this.avgCost,
      feesPaid: this.feesPaid,
    };
  }

  /**
   * Buys base with a fraction of the free quote balance.
   * @param {number} price
   * @param {string} reason
   * @param {number} timestamp bar time, so replayed history keeps its clock
   * @returns {{ok:boolean, trade?:object, reason?:string}}
   */
  buy(price, reason = 'signal', timestamp = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'Invalid price' };

    const spend = this.quote * this.settings.buyFraction;
    if (spend < this.settings.minOrderQuote) {
      return { ok: false, reason: `Order too small (${spend.toFixed(2)} < ${this.settings.minOrderQuote})` };
    }

    const baseBought = spend / price;
    const feeBase = baseBought * this.settings.feeRate;
    const feeValue = feeBase * price;

    const baseBefore = this.base;
    this.base = baseBefore + baseBought - feeBase;
    this.quote -= spend;
    this.feesPaid += feeValue;

    // The fee was taken out of the base, so the quote already spent (`spend`)
    // is the entire cost of the position. Adding the fee again would
    // double-count it.
    const totalCost = this.avgCost * baseBefore + spend;
    this.avgCost = this.base > 0 ? totalCost / this.base : 0;

    const trade = {
      id: nextTradeId(),
      ts: timestamp,
      side: 'BUY',
      price,
      baseQty: baseBought - feeBase,
      quoteQty: spend,
      fee: feeBase,
      feeAsset: 'base',
      realisedPnl: 0,
      quoteAfter: this.quote,
      baseAfter: this.base,
      avgCost: this.avgCost,
      reason,
    };
    this.trades.push(trade);
    return { ok: true, trade };
  }

  /** Liquidates the entire base position back into the quote currency. */
  sell(price, reason = 'signal', timestamp = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'Invalid price' };
    if (!this.hasPosition) return { ok: false, reason: 'No open position' };

    const baseSold = this.base;
    const gross = baseSold * price;
    const feeQuote = gross * this.settings.feeRate;

    const cost = this.avgCost * baseSold;
    const realised = gross - feeQuote - cost;

    this.quote += gross - feeQuote;
    this.feesPaid += feeQuote;
    this.realisedPnl += realised;
    this.base = 0;
    this.avgCost = 0;

    const trade = {
      id: nextTradeId(),
      ts: timestamp,
      side: 'SELL',
      price,
      baseQty: baseSold,
      quoteQty: gross - feeQuote,
      fee: feeQuote,
      feeAsset: 'quote',
      realisedPnl: realised,
      quoteAfter: this.quote,
      baseAfter: 0,
      avgCost: cost / baseSold,
      reason,
    };
    this.trades.push(trade);
    return { ok: true, trade };
  }

  /** Appends a point to the equity curve, thinned so long sessions stay small. */
  recordEquity(timestamp, price) {
    const snapshot = this.markToMarket(price);
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (last && Math.abs(last.equity - snapshot.equity) < 1e-9 && Math.abs(last.price - price) < 1e-9) {
      return last;
    }
    this.equityCounter += 1;
    const point = {
      t: timestamp,
      price,
      equity: snapshot.equity,
      quote: snapshot.quote,
      base: snapshot.base,
      id: this.equityCounter,
    };
    this.equityCurve.push(point);
    return point;
  }

  reset(initialQuote = this.initialQuote) {
    this.quote = initialQuote;
    this.initialQuote = initialQuote;
    this.base = 0;
    this.avgCost = 0;
    this.realisedPnl = 0;
    this.feesPaid = 0;
    this.trades = [];
    this.equityCurve = [];
    this.equityCounter = 0;
  }

  toJSON() {
    return {
      quote: this.quote,
      base: this.base,
      avgCost: this.avgCost,
      realisedPnl: this.realisedPnl,
      feesPaid: this.feesPaid,
      initialQuote: this.initialQuote,
      trades: this.trades,
      equityCurve: this.equityCurve,
    };
  }

  static fromJSON(data, options = {}) {
    const broker = new PaperBroker(options);
    if (!data) return broker;
    broker.quote = Number(data.quote) ?? broker.quote;
    broker.base = Number(data.base) ?? 0;
    broker.avgCost = Number(data.avgCost) ?? 0;
    broker.realisedPnl = Number(data.realisedPnl) ?? 0;
    broker.feesPaid = Number(data.feesPaid) ?? 0;
    broker.initialQuote = Number(data.initialQuote) ?? broker.initialQuote;
    broker.trades = Array.isArray(data.trades) ? data.trades : [];
    broker.equityCurve = Array.isArray(data.equityCurve) ? data.equityCurve : [];
    broker.equityCounter = broker.equityCurve.length;
    return broker;
  }
}
