import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, emaSeries, maSeries, maPairAt, triggerPrice } from '../src/indicators.js';
import { evaluate, SIGNAL } from '../src/strategy.js';
import { PaperBroker } from '../src/broker.js';

const SETTINGS = { shortPeriod: 3, longPeriod: 6, maType: 'sma' };

const historyOf = (prices) => prices.map((p, i) => ({ t: 1700000000000 + i * 60000, p }));

/* ---------------------------------------------------------------- averages */

test('sma averages the window and refuses a short window', () => {
  assert.equal(sma([1, 2, 3, 4], 4), 2.5);
  assert.equal(sma([1, 2, 3], 4), null);
});

test('ema seeds with an sma then converges toward the latest value', () => {
  const series = emaSeries([1, 2, 3, 4, 5, 6], 3);
  assert.equal(series[0], null);
  assert.equal(series[1], null);
  assert.equal(series[2], 2); // sma seed of [1,2,3]
  assert.ok(series[5] > series[4]);
  assert.ok(series[5] < 6);
});

test('maSeries is aligned index-for-index with the history', () => {
  const history = historyOf([5, 4, 3, 2, 1, 6]);
  const series = maSeries(history, 3, 'sma');
  assert.equal(series.length, history.length);
  assert.equal(series[0], null);
  assert.equal(series[1], null);
  assert.equal(series[2], 4); // (5+4+3)/3
  assert.equal(series[5], (3 + 2 + 1 + 6) / 4); // rolling window of 3 => (2+1+6)/3
});

test('maPairAt returns the previous bar pair alongside the current one', () => {
  const history = historyOf([1, 2, 3, 4, 5, 6, 7]);
  const pair = maPairAt(history, history.length - 1, SETTINGS);
  assert.equal(pair.current.short, 6); // (5+6+7)/3
  assert.equal(pair.current.long, 4.5); // (2+3+4+5+6+7)/6
  assert.equal(pair.previous.short, 5); // (4+5+6)/3
  assert.equal(pair.previous.long, 3.5); // (1+2+3+4+5+6)/6
});

/* ----------------------------------------------------------------- signals */

test('a cross above emits BUY and a cross below emits SELL', () => {
  // A steady decline, then a sharp uptick: the fast average is under the slow
  // one on the previous bar and above it on the last bar.
  const rising = historyOf([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 20]);
  const result = evaluate(rising, SETTINGS);
  assert.equal(result.ready, true);
  assert.equal(result.signal, SIGNAL.BUY);
  assert.equal(result.regime, 'LONG');
});

test('the signal does not repeat while the averages stay on the same side', () => {
  const rising = historyOf([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 20]);
  assert.equal(evaluate(rising, SETTINGS).signal, SIGNAL.BUY);

  // One more bar in the same direction must not re-fire the buy.
  const continued = historyOf([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 20, 25]);
  assert.equal(evaluate(continued, SETTINGS).signal, SIGNAL.HOLD);
});

test('a cross back below emits SELL', () => {
  // A steady rise, then a sharp drop: the fast average crosses back under.
  const falling = historyOf([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1]);
  const result = evaluate(falling, SETTINGS);
  assert.equal(result.signal, SIGNAL.SELL);
  assert.equal(result.regime, 'FLAT');
});

test('a cross above followed by a cross below produces one buy and one sell', () => {
  const series = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 20, 25, 26, 27, 1, 2];
  let buys = 0;
  let sells = 0;

  for (let i = 0; i < series.length; i += 1) {
    const result = evaluate(historyOf(series.slice(0, i + 1)), SETTINGS);
    if (result.signal === SIGNAL.BUY) buys += 1;
    if (result.signal === SIGNAL.SELL) sells += 1;
  }

  assert.equal(buys, 1);
  assert.equal(sells, 1);
});

test('no signal is produced before enough history exists', () => {
  const short = historyOf([10, 9, 8, 7]);
  const result = evaluate(short, SETTINGS);
  assert.equal(result.ready, false);
  assert.equal(result.signal, SIGNAL.HOLD);
  assert.match(result.reason, /Need 7 bars/);
});

/* --------------------------------------------------------------- triggers */

test('the trigger price is where the two averages meet on the next bar', () => {
  // A steady decline leaves the fast average below the slow one.
  const prices = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const history = historyOf(prices);
  const trigger = triggerPrice(history, SETTINGS);

  assert.ok(trigger != null);
  const atTrigger = evaluate(historyOf([...prices, trigger]), SETTINGS);
  assert.ok(Math.abs(atTrigger.short - atTrigger.long) < 1e-9, 'averages should meet at the trigger');
});

test('crossing the trigger is what actually flips the signal', () => {
  const prices = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const history = historyOf(prices);
  const trigger = triggerPrice(history, SETTINGS);

  // Below the trigger nothing happens, above it the bot buys.
  assert.equal(evaluate(historyOf([...prices, trigger - 0.01]), SETTINGS).signal, SIGNAL.HOLD);
  assert.equal(evaluate(historyOf([...prices, trigger + 0.01]), SETTINGS).signal, SIGNAL.BUY);
});

test('the trigger side follows the current regime', () => {
  // Falling series: flat regime, so the next trigger is a buy.
  const falling = historyOf([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const fallingResult = evaluate(falling, SETTINGS);
  assert.equal(fallingResult.regime, 'FLAT');
  assert.equal(fallingResult.triggerSide, SIGNAL.BUY);
  assert.ok(fallingResult.trigger > falling.at(-1).p, 'a buy trigger sits above the last price');

  // Rising series: long regime, so the next trigger is a sell.
  const rising = historyOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const risingResult = evaluate(rising, SETTINGS);
  assert.equal(risingResult.regime, 'LONG');
  assert.equal(risingResult.triggerSide, SIGNAL.SELL);
  assert.ok(risingResult.trigger < rising.at(-1).p, 'a sell trigger sits below the last price');
});

test('the trigger works for exponential averages too', () => {
  const prices = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const settings = { shortPeriod: 3, longPeriod: 6, maType: 'ema' };
  const trigger = triggerPrice(historyOf(prices), settings);

  assert.ok(trigger != null, 'an ema trigger should be found');
  const atTrigger = evaluate(historyOf([...prices, trigger]), settings);
  assert.ok(Math.abs(atTrigger.short - atTrigger.long) < 1e-6, 'ema averages should meet at the trigger');
});

test('no trigger is offered before there is enough history', () => {
  assert.equal(triggerPrice(historyOf([1, 2, 3]), SETTINGS), null);
});

/* ------------------------------------------------------------------ broker */

test('a buy spends quote currency, credits base and charges a fee', () => {
  const broker = new PaperBroker({ initialQuote: 1000, feeRate: 0.001, buyFraction: 1 });
  const result = broker.buy(100, 'test');

  assert.equal(result.ok, true);
  assert.equal(broker.quote, 0);
  // 1000 / 100 = 10 BNB bought, less 0.1% fee.
  assert.ok(Math.abs(broker.base - 9.99) < 1e-9);
  assert.ok(Math.abs(broker.avgCost - 100 / 0.999) < 1e-6);
  assert.equal(broker.trades.length, 1);
  assert.equal(broker.trades[0].side, 'BUY');
});

test('a sell liquidates the position and realises the profit net of fees', () => {
  const broker = new PaperBroker({ initialQuote: 1000, feeRate: 0, buyFraction: 1 });
  broker.buy(100, 'test');
  const result = broker.sell(110, 'test');

  assert.equal(result.ok, true);
  assert.equal(broker.base, 0);
  assert.equal(broker.quote, 1100);
  assert.equal(broker.realisedPnl, 100);
});

test('selling with no position is rejected', () => {
  const broker = new PaperBroker({ initialQuote: 1000 });
  const result = broker.sell(100, 'test');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No open position/);
});

test('an order below the minimum size is rejected', () => {
  const broker = new PaperBroker({ initialQuote: 5, minOrderQuote: 10, buyFraction: 1 });
  const result = broker.buy(100, 'test');
  assert.equal(result.ok, false);
  assert.match(result.reason, /too small/);
});

test('equity reflects both the cash balance and the open position', () => {
  const broker = new PaperBroker({ initialQuote: 1000, feeRate: 0, buyFraction: 1 });
  broker.buy(100, 'test');
  const snapshot = broker.markToMarket(110);
  assert.equal(snapshot.equity, 1100);
  assert.equal(snapshot.unrealisedPnl, 100);
  assert.equal(snapshot.totalPnl, 100);
});

test('round-tripping through JSON preserves the account', () => {
  const broker = new PaperBroker({ initialQuote: 1000, feeRate: 0.001 });
  broker.buy(100, 'test');
  broker.recordEquity(1700000000000, 100);

  const restored = PaperBroker.fromJSON(broker.toJSON(), { initialQuote: 1000 });
  assert.equal(restored.quote, broker.quote);
  assert.equal(restored.base, broker.base);
  assert.equal(restored.trades.length, 1);
  assert.equal(restored.equityCurve.length, 1);
});

test('a fill carries the bar timestamp so replayed history keeps its clock', () => {
  const broker = new PaperBroker({ initialQuote: 1000, feeRate: 0 });
  const barTime = 1700000000000;
  const buy = broker.buy(100, 'test', barTime);
  assert.equal(buy.trade.ts, barTime);

  const sell = broker.sell(110, 'test', barTime + 60000);
  assert.equal(sell.trade.ts, barTime + 60000);
});
