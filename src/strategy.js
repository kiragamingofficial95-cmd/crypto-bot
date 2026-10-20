import { maPairAt, triggerPrice } from './indicators.js';

export const SIGNAL = {
  BUY: 'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
};

/**
 * Classic moving-average crossover.
 *
 *   recent average crosses ABOVE the longer average -> BUY
 *   recent average crosses BACK BELOW the longer one   -> SELL
 *
 * The cross is only reported on the bar where it actually happens: the
 * previous bar's relationship is used to prove the averages were on the other
 * side. Without that check the bot would re-fire a buy on every tick for as
 * long as the fast average stayed above the slow one.
 */
export function evaluate(history, settings) {
  const index = history.length - 1;
  const { current, previous } = maPairAt(history, index, settings);

  const ready =
    current.short !== null &&
    current.long !== null &&
    previous.short !== null &&
    previous.long !== null;

  const result = {
    ready,
    short: current.short,
    long: current.long,
    previousShort: previous.short,
    previousLong: previous.long,
    spread: ready ? current.short - current.long : null,
    spreadPct: ready && current.long !== 0 ? ((current.short - current.long) / current.long) * 100 : null,
    signal: SIGNAL.HOLD,
    regime: 'UNKNOWN',
    reason: 'Not enough price history yet',
    bars: history.length,
    trigger: null,
    triggerSide: null,
    triggerDistancePct: null,
  };

  if (!ready) {
    result.reason = `Need ${settings.longPeriod + 1} bars before the first cross can be detected (have ${history.length})`;
    return result;
  }

  const crossedAbove = previous.short <= previous.long && current.short > current.long;
  const crossedBelow = previous.short >= previous.long && current.short < current.long;

  if (crossedAbove) {
    result.signal = SIGNAL.BUY;
    result.regime = 'LONG';
    result.reason = 'Recent average crossed above the longer average';
  } else if (crossedBelow) {
    result.signal = SIGNAL.SELL;
    result.regime = 'FLAT';
    result.reason = 'Recent average crossed back below the longer average';
  } else {
    result.regime = current.short > current.long ? 'LONG' : 'FLAT';
    result.reason =
      current.short > current.long
        ? 'Recent average is still above the longer average - holding'
        : 'Recent average is still below the longer average - no position';
  }

  // The level the market has to reach for the next bar to change hands.
  const trigger = triggerPrice(history, settings);
  if (trigger != null && Number.isFinite(trigger)) {
    const price = history[history.length - 1].p;
    const side = current.short > current.long ? SIGNAL.SELL : SIGNAL.BUY;
    result.trigger = trigger;
    result.triggerSide = side;
    result.triggerDistancePct = price ? ((trigger - price) / price) * 100 : null;
  }

  return result;
}
