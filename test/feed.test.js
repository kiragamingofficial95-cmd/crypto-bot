import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceFeed } from '../src/feeds/binance.js';
import { sanitiseSettings } from '../src/config.js';

test('the perp and spot feeds point at the right streams', () => {
  const perp = new BinanceFeed({ symbol: 'BNBUSDT', market: 'perp' });
  assert.equal(perp.wsUrl, 'wss://fstream.binance.com/ws/bnbusdt@bookTicker');
  assert.equal(perp.statsUrl, 'https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BNBUSDT');
  assert.equal(perp.label, 'Binance perp');

  const spot = new BinanceFeed({ symbol: 'BNBUSDT', market: 'spot' });
  assert.equal(spot.wsUrl, 'wss://stream.binance.com:9443/ws/bnbusdt@bookTicker');
  assert.equal(spot.statsUrl, 'https://api.binance.com/api/v3/ticker/24hr?symbol=BNBUSDT');
  assert.equal(spot.label, 'Binance spot');
});

test('a symbol is normalised to upper case', () => {
  const feed = new BinanceFeed({ symbol: 'bnbusdt', market: 'perp' });
  assert.equal(feed.symbol, 'BNBUSDT');
});

test('ticks are resampled into bars that carry open, high, low and close', () => {
  const feed = new BinanceFeed({ symbol: 'BNBUSDT', market: 'perp', barMs: 60000 });
  const bars = [];
  feed.on('bar', (bar) => bars.push(bar));

  feed.onTick(100);
  feed.onTick(104);
  feed.onTick(98);
  feed.onTick(101);
  assert.equal(bars.length, 0, 'the bar stays open until the interval elapses');

  feed.closeBar();
  assert.equal(bars.length, 1);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].high, 104);
  assert.equal(bars[0].low, 98);
  assert.equal(bars[0].close, 101);
});

test('closing a bar starts a fresh one', () => {
  const feed = new BinanceFeed({ symbol: 'BNBUSDT', market: 'perp', barMs: 60000 });
  const bars = [];
  feed.on('bar', (bar) => bars.push(bar));

  feed.onTick(100);
  feed.closeBar();
  feed.onTick(110);
  feed.closeBar();

  assert.equal(bars.length, 2);
  assert.equal(bars[0].close, 100);
  assert.equal(bars[1].open, 110);
  assert.equal(bars[1].close, 110);
  assert.equal(bars[1].high, 110);
});

test('a bar with no ticks is not emitted', () => {
  const feed = new BinanceFeed({ symbol: 'BNBUSDT', market: 'perp', barMs: 60000 });
  const bars = [];
  feed.on('bar', (bar) => bars.push(bar));
  feed.closeBar();
  assert.equal(bars.length, 0);
});

test('the live price tracks the newest tick', () => {
  const feed = new BinanceFeed({ symbol: 'BNBUSDT', market: 'perp', barMs: 60000 });
  feed.onTick(123.45);
  assert.equal(feed.lastPrice, 123.45);
  assert.equal(feed.status().lastPrice, 123.45);
});

test('bar length can be changed at runtime', () => {
  const feed = new BinanceFeed({ symbol: 'BNBUSDT', market: 'perp', barMs: 60000 });
  assert.equal(feed.barMs, 60000);
  feed.setBarMs(30000);
  assert.equal(feed.barMs, 30000);
});

test('settings keep the bar length within sane bounds', () => {
  assert.equal(sanitiseSettings({ barMs: 60000 }).barMs, 60000);
  assert.equal(sanitiseSettings({ barMs: 1 }).barMs, 1000);
  assert.equal(sanitiseSettings({ barMs: 99999999 }).barMs, 3600000);
  assert.equal(sanitiseSettings({}).barMs, 60000);
});
