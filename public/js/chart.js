/* Canvas chart rendering for the dashboard.
   Two charts:
     - price  : price line, the two moving averages, a ribbon shading the gap
                between them (the actual signal), a position strip, fill markers
                and a crosshair with axis chips.
     - equity : account value over time with drawdown shading and trade marks. */

const COLORS = {
  ink: '#16241F',
  ink3: '#63756E',
  rule: '#D3DAD6',
  rule2: '#BCC7C1',
  teal: '#0E7C6B',
  oxide: '#AC3A2B',
  slate: '#6B84A6',
  surface: '#F6F8F7',
};

const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';

/* --------------------------------------------------------------- helpers */

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalised = raw / magnitude;
  let step;
  if (normalised <= 1) step = 1;
  else if (normalised <= 2) step = 2;
  else if (normalised <= 5) step = 5;
  else step = 10;
  return step * magnitude;
}

function formatClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatClockSeconds(ts) {
  const d = new Date(ts);
  return `${formatClock(ts)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Marks which bars were held long, derived from the fill history, so the
 * strip shows the periods the strategy was actually exposed to the market.
 */
function positionMask(times, trades) {
  const mask = new Array(times.length).fill(false);
  let cursor = 0;
  let isLong = false;
  for (let i = 0; i < times.length; i += 1) {
    while (cursor < trades.length && trades[cursor].ts <= times[i]) {
      isLong = trades[cursor].side === 'BUY';
      cursor += 1;
    }
    mask[i] = isLong;
  }
  return mask;
}

function nearestIndex(times, ts) {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ts) lo = mid;
    else hi = mid;
  }
  return times[hi] - ts < ts - times[lo] ? hi : lo;
}

/* ------------------------------------------------------------ price chart */

export class PriceChart {
  constructor(canvas, tipElement) {
    this.canvas = canvas;
    this.tip = tipElement;
    this.state = null;
    this.hoverIndex = null;
    this.geometry = null;

    canvas.addEventListener('pointermove', (event) => this.handlePointer(event));
    canvas.addEventListener('pointerleave', () => {
      this.hoverIndex = null;
      this.tip.hidden = true;
      if (this.state) this.draw(this.state);
    });
  }

  handlePointer(event) {
    if (!this.state || !this.geometry) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { plotLeft, plotRight, times } = this.geometry;
    if (!times.length || x < plotLeft - 12 || x > plotRight + 12) {
      this.hoverIndex = null;
      this.tip.hidden = true;
      this.draw(this.state);
      return;
    }
    const ratio = (x - plotLeft) / Math.max(1, plotRight - plotLeft);
    const index = Math.min(times.length - 1, Math.max(0, Math.round(ratio * (times.length - 1))));
    this.hoverIndex = index;
    this.draw(this.state);
  }

  draw(state) {
    this.state = state;
    const setup = setupCanvas(this.canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    const series = state.series || {};
    const closes = series.closes || [];
    const times = series.times || [];
    const fast = series.fast || [];
    const slow = series.slow || [];

    if (closes.length < 2) {
      this.geometry = null;
      return;
    }

    const padTop = 16;
    const padBottom = 24;
    const padRight = 68;
    const padLeft = 8;
    const stripHeight = 5;
    const stripGap = 5;

    const plotLeft = padLeft;
    const plotRight = width - padRight;
    const plotTop = padTop;
    const plotBottom = height - padBottom - stripHeight - stripGap;

    const values = [];
    for (const v of closes) values.push(v);
    for (const v of fast) if (v != null) values.push(v);
    for (const v of slow) if (v != null) values.push(v);
    // The trigger level is often outside the price range, so pull the scale
    // out to include it rather than drawing a line that falls off the chart.
    const triggerLevel = state.evaluation?.trigger;
    if (triggerLevel != null && Number.isFinite(triggerLevel)) values.push(triggerLevel);

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max === min) { max += 1; min -= 1; }
    const padding = (max - min) * 0.08;
    min -= padding;
    max += padding;

    const xAt = (i) => plotLeft + (i / (closes.length - 1)) * (plotRight - plotLeft);
    const yAt = (v) => plotBottom - ((v - min) / (max - min)) * (plotBottom - plotTop);

    this.geometry = { plotLeft, plotRight, plotTop, plotBottom, times, xAt, yAt, min, max };

    const lastValue = closes[closes.length - 1];
    const lastY = yAt(lastValue);

    // ---------------------------------------------------------- grid ----
    ctx.strokeStyle = COLORS.rule;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.ink3;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const step = niceStep(max - min, 5);
    const firstGrid = Math.ceil(min / step) * step;
    for (let value = firstGrid; value <= max; value += step) {
      const y = Math.round(yAt(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      // Skip a label that the last-price chip is about to cover.
      if (Math.abs(y - lastY) > 11) ctx.fillText(formatPrice(value), plotRight + 8, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // When the whole session spans only a few minutes, minute precision would
    // repeat the same label on every tick - fall back to seconds.
    const spanMs = times[times.length - 1] - times[0];
    const timeFormatter = spanMs < 10 * 60 * 1000 ? formatClockSeconds : formatClock;
    const timeTicks = Math.min(6, Math.max(2, Math.floor((plotRight - plotLeft) / 120)));
    for (let t = 0; t < timeTicks; t += 1) {
      const index = Math.round((t / (timeTicks - 1)) * (closes.length - 1));
      const x = xAt(index);
      ctx.strokeStyle = COLORS.rule;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotTop);
      ctx.lineTo(Math.round(x) + 0.5, plotBottom);
      ctx.stroke();
      ctx.fillText(timeFormatter(times[index]), x, plotBottom + stripGap + stripHeight + 5);
    }

    // ------------------------------------------- gradient under the price --
    const areaGradient = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    areaGradient.addColorStop(0, 'rgba(22, 36, 31, 0.055)');
    areaGradient.addColorStop(1, 'rgba(22, 36, 31, 0)');
    drawArea(ctx, closes, xAt, yAt, plotBottom, areaGradient);

    // ------------------------------------------------- the signal ribbon --
    // Shades the space between the fast and slow averages. Teal where the
    // recent average is on top (long bias), oxide where it is underneath.
    for (let i = 1; i < closes.length; i += 1) {
      const f0 = fast[i - 1];
      const f1 = fast[i];
      const s0 = slow[i - 1];
      const s1 = slow[i];
      if (f0 == null || f1 == null || s0 == null || s1 == null) continue;
      const above = (f0 + f1) / 2 > (s0 + s1) / 2;
      ctx.fillStyle = above ? 'rgba(14, 124, 107, 0.16)' : 'rgba(172, 58, 43, 0.11)';
      ctx.beginPath();
      ctx.moveTo(xAt(i - 1), yAt(f0));
      ctx.lineTo(xAt(i), yAt(f1));
      ctx.lineTo(xAt(i), yAt(s1));
      ctx.lineTo(xAt(i - 1), yAt(s0));
      ctx.closePath();
      ctx.fill();
    }

    // ------------------------------------------------- reference levels --
    // Session high/low, and the price the market must reach for the next
    // tick to flip the averages and change the bot's position.
    const session = state.session || {};
    const trigger = state.evaluation?.trigger;
    const triggerSide = state.evaluation?.triggerSide;

    const level = (value, text, color, dashed, weight) => {
      if (value == null || !Number.isFinite(value)) return;
      const y = Math.round(yAt(value)) + 0.5;
      if (y < plotTop - 2 || y > plotBottom + 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = weight;
      if (dashed) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label chip, left aligned inside the plot so it never fights with the
      // last-price chip on the value axis.
      ctx.font = `10px ${MONO}`;
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = COLORS.surface;
      ctx.fillRect(plotLeft + 3, y - 8, width, 16);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(plotLeft + 3.5, y - 7.5, width - 1, 15);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, plotLeft + 8, y);
    };

    if (session.high != null) level(session.high, `H ${formatPrice(session.high)}`, COLORS.ink3, true, 1);
    if (session.low != null) level(session.low, `L ${formatPrice(session.low)}`, COLORS.ink3, true, 1);
    if (trigger != null && triggerSide) {
      const isBuy = triggerSide === 'BUY';
      level(
        trigger,
        `${isBuy ? 'BUY above' : 'SELL below'} ${formatPrice(trigger)}`,
        isBuy ? COLORS.teal : COLORS.oxide,
        true,
        1.5
      );
    }

    // ------------------------------------------------------- the averages --
    drawSeries(ctx, slow, xAt, yAt, COLORS.slate, 1.5, [5, 4]);
    drawSeries(ctx, closes, xAt, yAt, COLORS.ink, 1.9, null);
    drawSeries(ctx, fast, xAt, yAt, COLORS.teal, 1.5, null);

    // -------------------------------------------------------- fill markers --
    for (const trade of state.trades || []) {
      const index = nearestIndex(times, trade.ts);
      if (index < 0) continue;
      const x = xAt(index);
      const y = yAt(closes[index]);
      const isBuy = trade.side === 'BUY';

      // Buy sits under the price pointing up, sell sits above it pointing down.
      const gap = 8;
      const size = 9;
      let apexY = isBuy ? y + gap : y - gap;
      let baseY = isBuy ? y + gap + size : y - gap - size;
      baseY = Math.max(plotTop + 4, Math.min(plotBottom - 4, baseY));
      apexY = Math.max(plotTop + 2, Math.min(plotBottom - 2, apexY));

      ctx.fillStyle = isBuy ? COLORS.teal : COLORS.oxide;
      ctx.strokeStyle = COLORS.surface;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, apexY);
      ctx.lineTo(x - 5.5, baseY);
      ctx.lineTo(x + 5.5, baseY);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();

      // A hairline ties the marker back to the price it executed at.
      ctx.strokeStyle = isBuy ? 'rgba(14, 124, 107, 0.45)' : 'rgba(172, 58, 43, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, Math.min(y, baseY));
      ctx.lineTo(Math.round(x) + 0.5, Math.max(y, baseY));
      ctx.stroke();
    }

    // ------------------------------------------------------ position strip --
    const stripTop = plotBottom + stripGap;
    const mask = positionMask(times, state.trades || []);
    ctx.fillStyle = '#E7EBE9';
    ctx.fillRect(plotLeft, stripTop, plotRight - plotLeft, stripHeight);
    ctx.fillStyle = COLORS.teal;
    let runStart = -1;
    for (let i = 0; i <= mask.length; i += 1) {
      const on = i < mask.length && mask[i];
      if (on && runStart === -1) runStart = i;
      if (!on && runStart !== -1) {
        const x0 = xAt(runStart);
        const x1 = xAt(Math.max(runStart, i - 1));
        ctx.fillRect(x0, stripTop, Math.max(1.5, x1 - x0), stripHeight);
        runStart = -1;
      }
    }
    ctx.strokeStyle = COLORS.rule2;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotLeft + 0.5, stripTop + 0.5, plotRight - plotLeft - 1, stripHeight - 1);

    // --------------------------------------------------------- last price --
    ctx.strokeStyle = COLORS.ink3;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, Math.round(lastY) + 0.5);
    ctx.lineTo(plotRight, Math.round(lastY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.hoverIndex == null) {
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(plotRight + 3, lastY - 8, padRight - 8, 16);
      ctx.fillStyle = COLORS.surface;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatPrice(lastValue), plotRight + 7, lastY);
    }

    // ---------------------------------------------------- crosshair + chips --
    if (this.hoverIndex != null && this.hoverIndex >= 0 && this.hoverIndex < closes.length) {
      const i = this.hoverIndex;
      const x = xAt(i);
      const y = yAt(closes[i]);

      ctx.strokeStyle = 'rgba(99, 117, 110, 0.55)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotTop);
      ctx.lineTo(Math.round(x) + 0.5, plotBottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(plotLeft, Math.round(y) + 0.5);
      ctx.lineTo(plotRight, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = COLORS.surface;
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // price chip on the value axis
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(plotRight + 3, y - 8, padRight - 8, 16);
      ctx.fillStyle = COLORS.surface;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatPrice(closes[i]), plotRight + 7, y);

      // time chip on the time axis
      const timeLabel = formatClockSeconds(times[i]);
      ctx.font = `10px ${MONO}`;
      const chipWidth = ctx.measureText(timeLabel).width + 10;
      const chipX = Math.max(plotLeft, Math.min(plotRight - chipWidth, x - chipWidth / 2));
      const chipY = plotBottom + stripGap + stripHeight + 3;
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(chipX, chipY, chipWidth, 15);
      ctx.fillStyle = COLORS.surface;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(timeLabel, chipX + chipWidth / 2, chipY + 7.5);

      this.renderTip(i, x, y, { times, closes, fast, slow });
    }
  }

  renderTip(index, x, y, data) {
    const tip = this.tip;
    const rows = [
      ['Time', formatClockSeconds(data.times[index])],
      ['Price', formatPrice(data.closes[index])],
    ];
    if (data.fast[index] != null) rows.push(['Fast', formatPrice(data.fast[index])]);
    if (data.slow[index] != null) rows.push(['Slow', formatPrice(data.slow[index])]);

    if (data.fast[index] != null && data.slow[index] != null) {
      const gap = data.fast[index] - data.slow[index];
      const pct = data.slow[index] ? (gap / data.slow[index]) * 100 : 0;
      rows.push(['Gap', `${gap >= 0 ? '+' : '−'}${formatPrice(Math.abs(gap))} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(3)}%)`]);
      rows.push(['Bias', gap >= 0 ? 'fast above slow' : 'fast below slow']);
    }

    tip.innerHTML = rows
      .map(([label, value]) => `<div class="tip-row"><span>${label}</span><b>${value}</b></div>`)
      .join('');
    tip.hidden = false;

    const wrapWidth = this.canvas.clientWidth;
    const tipWidth = tip.offsetWidth;
    let left = x + 14;
    if (left + tipWidth > wrapWidth - 4) left = x - tipWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, y - tip.offsetHeight - 12)}px`;
  }
}

function drawSeries(ctx, values, xAt, yAt, color, lineWidth, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value == null) { started = false; continue; }
    const x = xAt(i);
    const y = yAt(value);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawArea(ctx, values, xAt, yAt, baselineY, fillStyle) {
  ctx.beginPath();
  ctx.moveTo(xAt(0), baselineY);
  for (let i = 0; i < values.length; i += 1) ctx.lineTo(xAt(i), yAt(values[i]));
  ctx.lineTo(xAt(values.length - 1), baselineY);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/* ----------------------------------------------------------- equity chart */

export class EquityChart {
  constructor(canvas) {
    this.canvas = canvas;
  }

  draw(state) {
    const setup = setupCanvas(this.canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    const curve = state.equityCurve || [];
    if (curve.length < 2) {
      ctx.fillStyle = COLORS.ink3;
      ctx.font = `11px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('equity curve starts after the first tick', width / 2, height / 2);
      return;
    }

    const padTop = 12;
    const padBottom = 18;
    const padRight = 8;
    const padLeft = 8;
    const plotLeft = padLeft;
    const plotRight = width - padRight;
    const plotTop = padTop;
    const plotBottom = height - padBottom;

    const equities = curve.map((p) => p.equity);
    const initial = state.account?.initialQuote ?? curve[0].equity;

    let min = Math.min(...equities);
    let max = Math.max(...equities);
    min = Math.min(min, initial);
    max = Math.max(max, initial);
    if (max === min) { max += 1; min -= 1; }
    const pad = (max - min) * 0.14;
    min -= pad;
    max += pad;

    const xAt = (i) => plotLeft + (i / (curve.length - 1)) * (plotRight - plotLeft);
    const yAt = (v) => plotBottom - ((v - min) / (max - min)) * (plotBottom - plotTop);

    const profitable = equities[equities.length - 1] >= initial;

    // ------------------------------------------------- drawdown shading ----
    // The band between the running peak and the curve is the drawdown.
    let peak = -Infinity;
    const peaks = equities.map((value) => {
      peak = Math.max(peak, value);
      return peak;
    });
    ctx.fillStyle = 'rgba(172, 58, 43, 0.10)';
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(peaks[0]));
    for (let i = 0; i < curve.length; i += 1) ctx.lineTo(xAt(i), yAt(peaks[i]));
    for (let i = curve.length - 1; i >= 0; i -= 1) ctx.lineTo(xAt(i), yAt(equities[i]));
    ctx.closePath();
    ctx.fill();

    // --------------------------------------------------- baseline (start) ---
    ctx.strokeStyle = COLORS.rule2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, Math.round(yAt(initial)) + 0.5);
    ctx.lineTo(plotRight, Math.round(yAt(initial)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // --------------------------------------------------------- area fill ----
    const gradient = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    gradient.addColorStop(0, profitable ? 'rgba(14, 124, 107, 0.18)' : 'rgba(172, 58, 43, 0.15)');
    gradient.addColorStop(1, 'rgba(14, 124, 107, 0)');
    drawArea(ctx, equities, xAt, yAt, plotBottom, gradient);

    // ------------------------------------------------------------- line ----
    ctx.strokeStyle = profitable ? COLORS.teal : COLORS.oxide;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < curve.length; i += 1) {
      const x = xAt(i);
      const y = yAt(equities[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ------------------------------------------------------ trade markers ---
    const curveTimes = curve.map((p) => p.t);
    for (const trade of state.trades || []) {
      const index = nearestIndex(curveTimes, trade.ts);
      if (index < 0) continue;
      const x = xAt(index);
      const y = yAt(equities[index]);
      const isBuy = trade.side === 'BUY';
      ctx.fillStyle = isBuy ? COLORS.teal : COLORS.oxide;
      ctx.strokeStyle = COLORS.surface;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }

    // ---------------------------------------------------------- end dot ----
    const lastX = xAt(curve.length - 1);
    const lastY = yAt(equities[equities.length - 1]);
    ctx.fillStyle = profitable ? COLORS.teal : COLORS.oxide;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();

    // ------------------------------------------------------- end label ----
    const change = ((equities[equities.length - 1] - initial) / initial) * 100;
    const label = `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(2)}%`;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = profitable ? COLORS.teal : COLORS.oxide;
    ctx.fillText(label, plotRight, plotTop);
  }
}

/* --------------------------------------------------------------- pricing */

export function formatPrice(value, symbol = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let decimals = 2;
  if (abs < 0.01) decimals = 8;
  else if (abs < 1) decimals = 6;
  else if (abs < 100) decimals = 4;
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return symbol ? `${text} ${symbol}` : text;
}

export function formatAmount(value, decimals = 4) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function formatMoney(value, symbol = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${text} ${symbol}` : text;
}
