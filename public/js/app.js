import { PriceChart, EquityChart, formatPrice, formatAmount, formatMoney } from './chart.js';

const $ = (id) => document.getElementById(id);

const els = {
  pair: $('pair-name'),
  feed: $('feed-name'),
  bars: $('bars-count'),
  statusChip: $('status-chip'),
  statusText: $('status-text'),
  price: $('price'),
  delta: $('delta'),
  legendFast: $('legend-fast'),
  legendSlow: $('legend-slow'),
  legendRange: $('legend-range'),
  chart: $('chart'),
  chartEmpty: $('chart-empty'),
  chartTip: $('chart-tip'),
  signalWord: $('signal-word'),
  signalReason: $('signal-reason'),
  triggerBox: $('trigger-box'),
  triggerLabel: $('trigger-label'),
  triggerPrice: $('trigger-price'),
  triggerAway: $('trigger-away'),
  spreadFill: $('spread-fill'),
  spreadValue: $('spread-value'),
  avgFastPeriod: $('avg-fast-period'),
  avgSlowPeriod: $('avg-slow-period'),
  avgFast: $('avg-fast'),
  avgSlow: $('avg-slow'),
  avgDiff: $('avg-diff'),
  avgType: $('avg-type'),
  baseLabel: $('base-label'),
  posBase: $('pos-base'),
  posAvg: $('pos-avg'),
  posValue: $('pos-value'),
  posPnl: $('pos-pnl'),
  positionNote: $('position-note'),
  acctEquity: $('acct-equity'),
  acctQuote: $('acct-quote'),
  acctPnl: $('acct-pnl'),
  acctFees: $('acct-fees'),
  accountNote: $('account-note'),
  fillsBody: $('fills-body'),
  fillsNote: $('fills-note'),
  equityNote: $('equity-note'),
  equityCanvas: $('equity-chart'),
  form: $('settings-form'),
  inShort: $('in-short'),
  inLong: $('in-long'),
  inType: $('in-type'),
  inPoll: $('in-poll'),
  inTick: $('in-tick'),
  toast: $('toast'),
};

const priceChart = new PriceChart(els.chart, els.chartTip);
const equityChart = new EquityChart(els.equityCanvas);

let state = null;
let settingsDirty = false;
const seenTrades = new Set();
let toastTimer = null;

/* --------------------------------------------------------------- helpers */

function setSigned(element, value, { decimals = 2, suffix = '' } = {}) {
  if (value == null || !Number.isFinite(value)) {
    element.textContent = '—';
    element.classList.remove('pos', 'neg');
    return;
  }
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  element.textContent = `${sign}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${suffix}`;
  element.classList.toggle('pos', value > 0);
  element.classList.toggle('neg', value < 0);
}

function showToast(message, tone = 'info') {
  els.toast.textContent = message;
  els.toast.dataset.tone = tone;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

/* ------------------------------------------------------------- rendering */

function render(next) {
  state = next;

  els.pair.textContent = state.pair;
  els.feed.textContent = state.source === 'coingecko' ? 'CoinGecko' : `pushed (${state.source})`;
  els.bars.textContent = `${state.bars} bars`;

  els.statusChip.dataset.status = state.status;
  els.statusText.textContent = state.status === 'rate-limited' ? 'rate limited' : state.status;
  els.statusChip.title = state.lastError || `last fetch ${state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleTimeString() : 'never'}`;

  // --- price ---
  els.price.textContent = state.price != null ? formatPrice(state.price) : '—';
  const change = state.change24h ?? state.changePct;
  setSigned(els.delta, change, { decimals: 2, suffix: '%' });
  els.delta.classList.toggle('up', (change ?? 0) > 0);
  els.delta.classList.toggle('down', (change ?? 0) < 0);
  els.delta.title = state.change24h != null ? '24 hour change' : 'change since last tick';

  // --- averages + signal ---
  const evaluation = state.evaluation;
  const hasAverages = evaluation && evaluation.short != null;

  els.avgFastPeriod.textContent = state.settings.shortPeriod;
  els.avgSlowPeriod.textContent = state.settings.longPeriod;
  els.avgType.textContent = state.settings.maType.toUpperCase();
  els.legendFast.textContent = hasAverages ? formatPrice(evaluation.short) : '—';
  els.legendSlow.textContent = hasAverages ? formatPrice(evaluation.long) : '—';

  // Session range, so the axis can be read at a glance.
  const closes = state.series?.closes || [];
  if (closes.length) {
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    els.legendRange.textContent = `${formatPrice(low)} – ${formatPrice(high)}`;
  } else {
    els.legendRange.textContent = '—';
  }

  if (evaluation) {
    els.signalWord.textContent = evaluation.regime === 'LONG' ? 'LONG' : 'FLAT';
    els.signalWord.dataset.regime = evaluation.regime;
    els.signalReason.textContent = evaluation.reason;
    els.signalReason.title = evaluation.reason;

    const spread = evaluation.spread;
    const spreadPct = evaluation.spreadPct;
    els.spreadValue.textContent = spread != null ? `${spread > 0 ? '+' : spread < 0 ? '−' : ''}${formatPrice(Math.abs(spread))}` : '—';

    const magnitude = Math.min(50, Math.abs(spreadPct ?? 0) * 50);
    const positive = (spreadPct ?? 0) >= 0;
    els.spreadFill.dataset.side = positive ? 'up' : 'down';
    els.spreadFill.style.left = positive ? '50%' : `${50 - magnitude}%`;
    els.spreadFill.style.width = `${magnitude}%`;

    els.avgFast.textContent = formatPrice(evaluation.short);
    els.avgSlow.textContent = formatPrice(evaluation.long);
    els.avgDiff.textContent = spreadPct != null ? `${spreadPct > 0 ? '+' : spreadPct < 0 ? '−' : ''}${Math.abs(spreadPct).toFixed(3)}%` : '—';

    // The next trigger: the level the market has to reach for the averages
    // to cross and the bot to change hands.
    if (evaluation.trigger != null && evaluation.triggerSide) {
      const isBuy = evaluation.triggerSide === 'BUY';
      els.triggerBox.dataset.side = evaluation.triggerSide;
      els.triggerBox.hidden = false;
      els.triggerLabel.textContent = isBuy ? 'Buy above' : 'Sell below';
      els.triggerPrice.textContent = formatPrice(evaluation.trigger);
      const distance = evaluation.triggerDistancePct;
      if (distance != null) {
        els.triggerAway.textContent = `${distance >= 0 ? '+' : '−'}${Math.abs(distance).toFixed(2)}% from ${formatPrice(state.price)}`;
      } else {
        els.triggerAway.textContent = '';
      }
      els.triggerBox.title = 'The price the next tick must reach for the recent average to cross the longer one.';
    } else {
      els.triggerBox.dataset.side = '';
      els.triggerBox.hidden = true;
    }
  }

  // --- position ---
  const account = state.account;
  els.baseLabel.textContent = `${state.baseSymbol} held`;
  els.posBase.textContent = formatAmount(account.base, 6);
  els.posAvg.textContent = account.avgCost ? formatPrice(account.avgCost) : '—';
  els.posValue.textContent = `${formatMoney(account.positionValue)} ${state.quoteSymbol}`;
  setSigned(els.posPnl, account.unrealisedPnl, { decimals: 2 });
  els.positionNote.textContent = account.base > 0 ? 'open position' : 'no open position';

  // --- account ---
  els.acctEquity.textContent = `${formatMoney(account.equity)} ${state.quoteSymbol}`;
  els.acctQuote.textContent = `${formatMoney(account.quote)} ${state.quoteSymbol}`;
  setSigned(els.acctPnl, account.totalPnl, { decimals: 2 });
  els.acctPnl.title = `${account.totalPnlPct >= 0 ? '+' : ''}${account.totalPnlPct.toFixed(2)}% against the starting balance`;
  els.acctFees.textContent = formatMoney(account.feesPaid);
  els.accountNote.textContent = `${account.totalPnlPct >= 0 ? '+' : ''}${account.totalPnlPct.toFixed(2)}%`;

  // --- fills ---
  renderFills(state.trades);
  els.fillsNote.textContent = state.trades.length
    ? `${state.trades.length} fill${state.trades.length === 1 ? '' : 's'}`
    : 'no trades yet';

  // --- equity ---
  els.equityNote.textContent = `${formatMoney(account.equity)} ${state.quoteSymbol}`;

  // --- charts ---
  const hasSeries = state.series?.closes?.length >= 2;
  els.chartEmpty.hidden = hasSeries;
  priceChart.draw(state);
  equityChart.draw(state);

  if (!settingsDirty) syncSettingsForm(state.settings);
}

function renderFills(trades) {
  const fresh = trades.filter((trade) => !seenTrades.has(trade.id));

  if (!trades.length) {
    if (els.fillsBody.querySelector('.empty-row') === null) {
      els.fillsBody.innerHTML = '<tr class="empty-row"><td colspan="7">The crossover has not fired yet.</td></tr>';
    }
    return;
  }

  const emptyRow = els.fillsBody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  // Only rebuild when the fill set actually changed, so the scroll position
  // and the flash animation survive ordinary price updates.
  const rows = els.fillsBody.querySelectorAll('tr[data-id]');
  if (rows.length === trades.length) return;

  for (const trade of trades) seenTrades.add(trade.id);
  els.fillsBody.innerHTML = trades
    .map((trade) => fillRow(trade, fresh.some((f) => f.id === trade.id)))
    .join('');
}

function fillRow(trade, isNew = false) {
  const pnl = trade.realisedPnl;
  const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
  const pnlText = trade.side === 'SELL'
    ? `${pnl >= 0 ? '+' : '−'}${formatAmount(Math.abs(pnl), 2)}`
    : '—';

  return `<tr data-id="${trade.id}"${isNew ? ` class="new-${trade.side.toLowerCase()}"` : ''}>
    <td>${new Date(trade.ts).toLocaleTimeString()}</td>
    <td><span class="side-tag ${trade.side === 'BUY' ? 'buy' : 'sell'}">${trade.side}</span></td>
    <td>${formatPrice(trade.price)}</td>
    <td>${formatAmount(trade.baseQty, 6)}</td>
    <td>${formatAmount(trade.quoteQty, 2)}</td>
    <td>${formatAmount(trade.fee, 6)}</td>
    <td class="num ${pnlClass}">${pnlText}</td>
  </tr>`;
}

function syncSettingsForm(settings) {
  els.inShort.value = settings.shortPeriod;
  els.inLong.value = settings.longPeriod;
  els.inType.value = settings.maType;
  els.inPoll.value = Math.round(settings.pollMs / 1000);
}

/* -------------------------------------------------------------- transport */

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    els.statusChip.dataset.status = 'live';
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') render(message.state);
    if (message.type === 'trade') {
      const side = message.trade.side === 'BUY' ? 'Bought' : 'Sold';
      showToast(`${side} ${message.trade.baseQty.toFixed(6)} at ${formatPrice(message.trade.price)}`);
    }
  });

  socket.addEventListener('close', () => {
    els.statusChip.dataset.status = 'stopped';
    els.statusText.textContent = 'reconnecting';
    setTimeout(connect, 1500);
  });

  socket.addEventListener('error', () => socket.close());
}

/* ---------------------------------------------------------------- actions */

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = {
    shortPeriod: Number(els.inShort.value),
    longPeriod: Number(els.inLong.value),
    maType: els.inType.value,
    pollMs: Number(els.inPoll.value) * 1000,
  };
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(settings) });
    settingsDirty = false;
    showToast('Strategy updated');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

['inShort', 'inLong', 'inType', 'inPoll'].forEach((id) => {
  els[id].addEventListener('input', () => { settingsDirty = true; });
});

$('btn-poll').addEventListener('click', async () => {
  try {
    await api('/api/poll', { method: 'POST' });
    showToast('Polled CoinGecko');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('btn-reset').addEventListener('click', async () => {
  if (!window.confirm('Reset the paper account and clear all price history?')) return;
  try {
    const payload = await api('/api/reset', { method: 'POST' });
    seenTrades.clear();
    els.fillsBody.innerHTML = '<tr class="empty-row"><td colspan="7">The crossover has not fired yet.</td></tr>';
    render(payload.state);
    showToast('Session reset');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('btn-buy').addEventListener('click', () => placeOrder('BUY'));
$('btn-sell').addEventListener('click', () => placeOrder('SELL'));

async function placeOrder(side) {
  try {
    await api('/api/trade', { method: 'POST', body: JSON.stringify({ side }) });
    showToast(`${side === 'BUY' ? 'Buy' : 'Sell'} order filled`);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

$('btn-tick').addEventListener('click', async () => {
  const price = Number(els.inTick.value);
  if (!Number.isFinite(price) || price <= 0) {
    showToast('Enter a valid price', 'error');
    return;
  }
  try {
    const payload = await api('/api/tick', { method: 'POST', body: JSON.stringify({ price }) });
    els.inTick.value = '';
    showToast(`Pushed ${formatPrice(price)} · signal ${payload.signal}`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

els.inTick.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('btn-tick').click();
});

/* ------------------------------------------------------------------ boot */

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state) {
      priceChart.draw(state);
      equityChart.draw(state);
    }
  }, 120);
});

async function boot() {
  try {
    const payload = await api('/api/state');
    render(payload.state);
  } catch (err) {
    showToast(err.message, 'error');
  }
  connect();
}

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    if (state) {
      priceChart.draw(state);
      equityChart.draw(state);
    }
  });
}

boot();
