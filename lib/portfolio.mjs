// Portfolio valuation and the combined portfolio history series.
//
// Pure functions of holdings, quotes, price states and (for history) per-asset series.
// All money is converted into the caller's base currency using FX quotes named
// `<FROM><BASE>=X` (price = units of BASE per 1 unit of FROM). Percentages are 0-100
// and are null whenever their denominator is 0.

import { holdingKey } from "./holdings.mjs";

/** @typedef {import("./types.mjs").AssetRef} AssetRef */
/** @typedef {import("./types.mjs").Quote} Quote */
/** @typedef {import("./types.mjs").Series} Series */
/** @typedef {import("./types.mjs").Holding} Holding */
/** @typedef {import("./types.mjs").PriceState} PriceState */
/** @typedef {import("./types.mjs").Range} Range */

/**
 * One holding as displayed. Money fields are in the base currency. Every numeric
 * field except `quantity` is null for an excluded position (no price, or no FX
 * rate for its listing or cost currency). One asset can be held more than once (in
 * different cost currencies), so `key` rather than `asset` identifies a position.
 * @typedef {object} PositionView
 * @property {string} key holdings.holdingKey of `holding`.
 * @property {Holding} holding The holding this position values.
 * @property {AssetRef} asset
 * @property {Quote|null} quote
 * @property {PriceState} state
 * @property {number} quantity
 * @property {number|null} value
 * @property {number|null} dayChange
 * @property {number|null} dayChangePct
 * @property {number|null} gain
 * @property {number|null} gainPct
 * @property {number|null} weight Share of the portfolio total, 0-100.
 */

/**
 * Whole-portfolio figures in the base currency. Totals cover valued positions only.
 * `positions` lists every holding: valued ones by value descending, then excluded ones.
 * @typedef {object} PortfolioView
 * @property {number} total
 * @property {number} dayChange
 * @property {number|null} dayChangePct
 * @property {number} gain
 * @property {number|null} gainPct
 * @property {PositionView[]} positions
 * @property {AssetRef[]} stale Assets whose price state is "stale", each once.
 * @property {AssetRef[]} excluded Assets with a holding left out of the totals, each once.
 */

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Grid step per chart range, in milliseconds. */
const STEP_MS = { "1D": 15 * MINUTE, "1W": HOUR, "1M": DAY, "3M": DAY, "6M": DAY, "1Y": DAY };

/**
 * Most buckets a range's grid can legitimately need. The span runs from the latest first
 * point to the latest last point among the held series, so it is the width of the
 * provider's window for that range, not the size of the portfolio: the widest is Yahoo's
 * five daily points for funds on "1D" (~6 days at 15-minute steps, ~600 buckets), and
 * "1Y" is daily over a year (~370). A grid past this means a caller paired a range with
 * another range's series - a "1Y" series on the "1D" grid is ~35k buckets, ~1e8 points,
 * which blocks the GUI thread for tens of seconds - so draw nothing and let the next
 * evaluation, with the matching series, fill it in. The count is taken before the loop,
 * so a rejected grid costs no work.
 */
const MAX_BUCKETS = 2000;

/**
 * Percentage `part / whole * 100`, or null when `whole` is 0.
 * @param {number} part
 * @param {number} whole
 * @returns {number|null}
 */
function pct(part, whole) {
  return whole === 0 ? null : (part / whole) * 100;
}

/**
 * Rate converting one unit of `from` into `base`: 1 when equal, otherwise the
 * `<from><base>=X` quote price, or null when that quote is unavailable.
 * @param {string} from
 * @param {string} base
 * @param {Record<AssetRef, Quote>} quotes
 * @returns {number|null}
 */
export function fxRate(from, base, quotes) {
  if (from === base) return 1;
  const quote = quotes[`${from}${base}=X`];
  return quote ? quote.price : null;
}

/**
 * Values the holdings in `baseCurrency`. `states` are computed by the caller
 * (see market.priceState); "stale" prices still count, "missing" ones do not. A
 * valued position whose FX pair (e.g. "USDAUD=X") has state "stale" lists that pair
 * once in `stale`.
 * @param {Holding[]} holdings
 * @param {Record<AssetRef, Quote>} quotes
 * @param {Record<AssetRef, PriceState>} states
 * @param {string} baseCurrency
 * @returns {PortfolioView}
 */
export function valuePortfolio(holdings, quotes, states, baseCurrency) {
  /** @type {Array<{view: PositionView, costBase: number}>} */
  const valued = [];
  /** @type {PositionView[]} */
  const excludedViews = [];
  /** @type {AssetRef[]} */
  const stale = [];
  /** @type {AssetRef[]} */
  const excluded = [];

  for (const h of holdings) {
    const quote = quotes[h.asset] ?? null;
    const state = states[h.asset] ?? "missing";
    if (state === "stale" && !stale.includes(h.asset)) stale.push(h.asset);

    const rate = quote ? fxRate(quote.currency, baseCurrency, quotes) : null;
    const costRate = quote ? fxRate(h.costCurrency ?? quote.currency, baseCurrency, quotes) : null;
    if (!quote || rate === null || costRate === null || state === "missing") {
      if (!excluded.includes(h.asset)) excluded.push(h.asset);
      excludedViews.push({
        key: holdingKey(h), holding: h, asset: h.asset, quote, state, quantity: h.quantity,
        value: null, dayChange: null, dayChangePct: null, gain: null, gainPct: null, weight: null,
      });
      continue;
    }

    for (const currency of [quote.currency, h.costCurrency ?? quote.currency]) {
      const pair = `${currency}${baseCurrency}=X`;
      if (currency !== baseCurrency && states[pair] === "stale" && !stale.includes(pair)) stale.push(pair);
    }

    const value = h.quantity * quote.price * rate;
    const costBase = h.quantity * h.cost * costRate;
    valued.push({
      costBase,
      view: {
        key: holdingKey(h), holding: h, asset: h.asset, quote, state, quantity: h.quantity, value,
        dayChange: h.quantity * (quote.price - quote.previousClose) * rate,
        dayChangePct: pct(quote.price - quote.previousClose, quote.previousClose),
        gain: value - costBase,
        gainPct: pct(value - costBase, costBase),
        weight: null,
      },
    });
  }

  let total = 0;
  let dayChange = 0;
  let totalCost = 0;
  for (const { view, costBase } of valued) {
    total += /** @type {number} */ (view.value);
    dayChange += /** @type {number} */ (view.dayChange);
    totalCost += costBase;
  }
  const gain = total - totalCost;

  const positions = valued.map(({ view }) => Object.assign({}, view, { weight: pct(/** @type {number} */ (view.value), total) }));
  positions.sort((a, b) => /** @type {number} */ (b.value) - /** @type {number} */ (a.value));
  positions.push(...excludedViews);

  return {
    total, dayChange, dayChangePct: pct(dayChange, total - dayChange),
    gain, gainPct: pct(gain, totalCost),
    positions, stale, excluded,
  };
}

/**
 * Last point of `points` (time-ordered) with time < `limit`, or undefined.
 * @param {Array<[number, number]>} points
 * @param {number} limit
 */
function lastBefore(points, limit) {
  let found;
  for (const p of points) {
    if (p[0] >= limit) break;
    found = p;
  }
  return found;
}

/**
 * Portfolio value over time in `baseCurrency`. The range's grid (15 min for 1D,
 * 1 h for 1W, 1 day from 1M up) runs from the step-aligned floor of the LATEST first
 * point among the held assets' series (providers return different windows per range;
 * starting earlier would add assets mid-series and fake a jump) to the bucket holding
 * the latest point. FX series do not move the start: Yahoo's are often shorter than
 * the assets they convert (a 1D rate starts at 23:00 UTC, CoinGecko's coins cover
 * 24 hours), and clipping to them would cut the chart down to minutes. Held assets
 * with no series (or an empty one) are omitted from every bucket. In each bucket
 * `[t, t + step)` every held asset contributes its last point before `t + step`
 * (forward fill) converted at the FX in effect then: the last point of the
 * `<FROM><BASE>=X` series before `t + step`; before that series' first point, its
 * first point (so the rate does not jump where the series begins); with no series
 * (or an empty one), the current quote rate. An asset with no FX at all is omitted
 * from that bucket, and a bucket where nothing contributes yields no point. Points
 * are at bucket starts.
 * @param {Holding[]} holdings
 * @param {Record<AssetRef, Series>} seriesByAsset
 * @param {Record<AssetRef, Quote>} quotes
 * @param {Range} range
 * @param {string} baseCurrency
 * @returns {Series}
 */
export function combinedSeries(holdings, seriesByAsset, quotes, range, baseCurrency) {
  const step = STEP_MS[range];
  const held = holdings
    .map((h) => ({ quantity: h.quantity, series: seriesByAsset[h.asset] }))
    .filter((h) => h.series && h.series.points.length > 0);

  /** @type {Array<[number, number]>} */
  const points = [];
  if (held.length > 0) {
    // Start where every held asset's series has begun, so the composition is constant
    // across the whole series.
    let start = -Infinity;
    let latest = -Infinity;
    for (const { series } of held) {
      start = Math.max(start, series.points[0][0]);
      latest = Math.max(latest, series.points[series.points.length - 1][0]);
    }
    const gridStart = Math.floor(start / step) * step;
    const buckets = Math.floor((latest - gridStart) / step) + 1;
    // `points` is still empty here, so the guard returns the no-history series (the panel
    // draws its "No history yet" note) rather than walking a grid no range can need.
    if (!(step > 0) || buckets > MAX_BUCKETS) return { asset: "portfolio", currency: baseCurrency, points };
    for (let t = gridStart; t <= latest; t += step) {
      const end = t + step;
      let sum = 0;
      let contributed = false;
      for (const { quantity, series } of held) {
        const point = lastBefore(series.points, end);
        if (!point) continue;
        const rate = rateAt(series.currency, baseCurrency, end, seriesByAsset, quotes);
        if (rate === null) continue;
        sum += quantity * point[1] * rate;
        contributed = true;
      }
      if (contributed) points.push([t, sum]);
    }
  }
  return { asset: "portfolio", currency: baseCurrency, points };
}

/**
 * FX rate into base in effect just before `end`: the `<from><base>=X` series' last point
 * before `end`, or its first point when `end` is before the series begins; the current
 * quote rate when there is no series or it is empty; null when none is known.
 * @param {string} from
 * @param {string} base
 * @param {number} end
 * @param {Record<AssetRef, Series>} seriesByAsset
 * @param {Record<AssetRef, Quote>} quotes
 * @returns {number|null}
 */
function rateAt(from, base, end, seriesByAsset, quotes) {
  if (from === base) return 1;
  const points = seriesByAsset[`${from}${base}=X`]?.points ?? [];
  if (points.length === 0) return fxRate(from, base, quotes);
  return (lastBefore(points, end) ?? points[0])[1];
}

/**
 * Change from the first to the last point of `series`. Fewer than two points is
 * no change; `pct` is null when the first value is 0.
 * @param {Series} series
 * @returns {{change: number, pct: number|null}}
 */
export function rangeChange(series) {
  const { points } = series;
  if (points.length < 2) return { change: 0, pct: null };
  const first = points[0][1];
  const change = points[points.length - 1][1] - first;
  return { change, pct: pct(change, first) };
}
