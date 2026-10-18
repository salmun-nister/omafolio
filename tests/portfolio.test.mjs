import { test } from "node:test";
import assert from "node:assert/strict";
import { fxRate, valuePortfolio, combinedSeries, rangeChange } from "../lib/portfolio.mjs";
import { cashQuotes, cashStates, cashSeries } from "../lib/cash.mjs";

const near = (a, b) => Math.abs(a - b) < 1e-9;
const q = (asset, price, previousClose, currency, kind = "stock") => ({
  asset, symbol: asset, name: asset, price, previousClose, currency, kind, asOf: 0, session: null,
  provider: asset.startsWith("crypto:") ? "coingecko" : "yahoo",
});
// Crypto is priced in US dollars, like VOO; VAS is listed in AUD, the base most tests use.
const BTC_USD = 70000;
const BTC_PREV_USD = 69000;
const quotes = {
  VOO: q("VOO", 715.59, 711.28, "USD", "etf"),
  AAPL: q("AAPL", 336.64, 340.42, "USD"),
  "crypto:bitcoin": q("crypto:bitcoin", BTC_USD, BTC_PREV_USD, "USD", "crypto"),
  VTSAX: q("VTSAX", 185.93, 185.93, "USD", "fund"),
  VAS: q("VAS", 100, 99, "AUD", "etf"),
  "USDAUD=X": q("USDAUD=X", 1.431, 1.43, "AUD", "fx"),
};
const vasHolding = { asset: "VAS", quantity: 10, cost: 90 };
const holdings = [
  { asset: "VOO", quantity: 12, cost: 410.25 },
  { asset: "AAPL", quantity: 20, cost: 180 },
  { asset: "crypto:bitcoin", quantity: 0.05, cost: 61000, costCurrency: "AUD" },
];
const allLive = { VOO: "live", AAPL: "live", "crypto:bitcoin": "live", VTSAX: "live", VAS: "live", "USDAUD=X": "live", "AUDUSD=X": "live" };
const pos = (v, asset) => v.positions.find((p) => p.asset === asset);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

// ---- fxRate

test("fxRate is 1 for equal currencies and does not need a quote", () => {
  assert.equal(fxRate("AUD", "AUD", {}), 1);
});
test("fxRate reads the <FROM><BASE>=X price", () => {
  assert.equal(fxRate("USD", "AUD", quotes), 1.431);
});
test("fxRate is null when the pair is missing", () => {
  assert.equal(fxRate("USD", "AUD", {}), null);
  assert.equal(fxRate("AUD", "USD", quotes), null); // only the USDAUD direction exists
});

// ---- valuePortfolio

test("values convert to base", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  assert.ok(near(pos(v, "VOO").value, 12 * 715.59 * 1.431));
  assert.ok(near(pos(v, "AAPL").value, 20 * 336.64 * 1.431));
  assert.ok(near(pos(v, "crypto:bitcoin").value, 0.05 * BTC_USD * 1.431));
  assert.ok(near(v.total, sum(v.positions.map((p) => p.value))));
});
test("day change and percentage use previous close at today's FX", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  const voo = pos(v, "VOO");
  assert.ok(near(voo.dayChange, 12 * (715.59 - 711.28) * 1.431));
  assert.ok(near(voo.dayChangePct, ((715.59 - 711.28) / 711.28) * 100));
  assert.ok(pos(v, "AAPL").dayChange < 0);
  const dc = sum(v.positions.map((p) => p.dayChange));
  assert.ok(near(v.dayChange, dc));
  assert.ok(near(v.dayChangePct, (dc / (v.total - dc)) * 100));
});
test("gain without costCurrency is market move at today's FX", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  assert.ok(near(pos(v, "VOO").gain, 12 * (715.59 - 410.25) * 1.431));
  assert.ok(near(pos(v, "VOO").gainPct, ((715.59 - 410.25) / 410.25) * 100));
});
test("gain with costCurrency in base includes currency movement", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  assert.ok(near(pos(v, "crypto:bitcoin").gain, 0.05 * BTC_USD * 1.431 - 0.05 * 61000));
  assert.ok(near(pos(v, "crypto:bitcoin").gainPct, ((BTC_USD * 1.431 - 61000) / 61000) * 100));
});
test("crypto priced in US dollars is valued through USDAUD=X; a cached AUD crypto quote still values at 1", () => {
  const h = [{ asset: "crypto:bitcoin", quantity: 0.05, cost: 61000, costCurrency: "AUD" }];
  const v = valuePortfolio(h, quotes, allLive, "AUD");
  assert.ok(near(pos(v, "crypto:bitcoin").dayChange, 0.05 * (BTC_USD - BTC_PREV_USD) * 1.431));
  // Without the rate the coin cannot be valued, like any US-listed asset.
  assert.deepEqual(valuePortfolio(h, without(quotes, "USDAUD=X"), allLive, "AUD").excluded, ["crypto:bitcoin"]);
  // A quote cached from when crypto was priced in the base needs no rate in an AUD portfolio.
  const cachedAud = { ...without(quotes, "USDAUD=X"), "crypto:bitcoin": q("crypto:bitcoin", 100000, 98000, "AUD", "crypto") };
  const cached = valuePortfolio(h, cachedAud, allLive, "AUD");
  assert.ok(near(pos(cached, "crypto:bitcoin").value, 0.05 * 100000));
});
test("crypto without costCurrency has its cost read in US dollars, its quote currency", () => {
  const v = valuePortfolio([{ asset: "crypto:bitcoin", quantity: 1, cost: 60000 }], quotes, allLive, "AUD");
  assert.ok(near(pos(v, "crypto:bitcoin").gain, (BTC_USD - 60000) * 1.431));
  assert.ok(near(pos(v, "crypto:bitcoin").gainPct, ((BTC_USD - 60000) / 60000) * 100));
});
test("crypto bought in AUD under a USD base converts its cost through AUDUSD=X", () => {
  const h = [{ asset: "crypto:bitcoin", quantity: 1, cost: 61000, costCurrency: "AUD" }];
  const withRate = { ...quotes, "AUDUSD=X": q("AUDUSD=X", 0.7, 0.7, "USD", "fx") };
  const v = valuePortfolio(h, withRate, allLive, "USD");
  assert.ok(near(pos(v, "crypto:bitcoin").value, BTC_USD));
  assert.ok(near(pos(v, "crypto:bitcoin").gain, BTC_USD - 61000 * 0.7));
  // No AUDUSD=X rate: the cost cannot be converted, so the position is left out.
  assert.deepEqual(valuePortfolio(h, quotes, allLive, "USD").excluded, ["crypto:bitcoin"]);
});
test("cost currency differing from listing currency is converted at its own rate", () => {
  // VOO lists in USD but was bought for 600 AUD per unit.
  const h = [{ asset: "VOO", quantity: 2, cost: 600, costCurrency: "AUD" }];
  const v = valuePortfolio(h, quotes, allLive, "AUD");
  assert.ok(near(pos(v, "VOO").gain, 2 * 715.59 * 1.431 - 2 * 600));
});
test("portfolio gain and gainPct sum valued positions against total cost in base", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  const cost = 12 * 410.25 * 1.431 + 20 * 180 * 1.431 + 0.05 * 61000;
  assert.ok(near(v.gain, v.total - cost));
  assert.ok(near(v.gainPct, ((v.total - cost) / cost) * 100));
});
test("weights are percentages that sum to 100 and positions sort by value descending", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  assert.ok(near(pos(v, "VOO").weight, (pos(v, "VOO").value / v.total) * 100));
  assert.ok(near(sum(v.positions.map((p) => p.weight)), 100));
  const values = v.positions.map((p) => p.value);
  assert.deepEqual(values, [...values].sort((a, b) => b - a));
  assert.deepEqual(v.positions.map((p) => p.asset), ["VOO", "AAPL", "crypto:bitcoin"]);
});
test("a position carries its quote, state and quantity", () => {
  const v = valuePortfolio(holdings, quotes, allLive, "AUD");
  assert.equal(pos(v, "VOO").quote, quotes.VOO);
  assert.equal(pos(v, "VOO").state, "live");
  assert.equal(pos(v, "VOO").quantity, 12);
});
test("stale prices count and are listed", () => {
  const v = valuePortfolio(holdings, quotes, { ...allLive, VOO: "stale" }, "AUD");
  assert.deepEqual(v.stale, ["VOO"]);
  assert.ok(pos(v, "VOO").value > 0);
  assert.equal(pos(v, "VOO").state, "stale");
  assert.deepEqual(valuePortfolio(holdings, quotes, allLive, "AUD").stale, []);
});
test("a stale listing-currency FX quote is listed once, even when several positions use it", () => {
  const v = valuePortfolio(holdings, quotes, { ...allLive, "USDAUD=X": "stale" }, "AUD");
  assert.deepEqual(v.stale, ["USDAUD=X"]);
  assert.ok(pos(v, "VOO").value > 0);
});
test("a stale cost-currency FX quote is listed", () => {
  const h = [{ asset: "VAS", quantity: 1, cost: 10, costCurrency: "USD" }];
  const v = valuePortfolio(h, quotes, { ...allLive, "USDAUD=X": "stale" }, "AUD");
  assert.deepEqual(v.stale, ["USDAUD=X"]);
});
test("a live FX quote adds nothing to stale, and a stale one is ignored when no position uses it", () => {
  assert.deepEqual(valuePortfolio(holdings, quotes, allLive, "AUD").stale, []);
  assert.deepEqual(valuePortfolio([vasHolding], quotes, { ...allLive, "USDAUD=X": "stale" }, "AUD").stale, []);
});
test("stale asset and stale FX are both listed", () => {
  const v = valuePortfolio(holdings, quotes, { ...allLive, VOO: "stale", "USDAUD=X": "stale" }, "AUD");
  assert.deepEqual(v.stale, ["VOO", "USDAUD=X"]);
});
test("closed prices are not stale", () => {
  const v = valuePortfolio(holdings, quotes, { ...allLive, VOO: "closed" }, "AUD");
  assert.deepEqual(v.stale, []);
});
test("missing FX excludes the position and lists it", () => {
  const v = valuePortfolio([...holdings, vasHolding], without(quotes, "USDAUD=X"), allLive, "AUD");
  assert.deepEqual([...v.excluded].sort(), ["AAPL", "VOO", "crypto:bitcoin"]);
  assert.ok(near(v.total, 10 * 100));
});
test("excluded positions are kept with null figures and sort after valued ones", () => {
  const v = valuePortfolio([...holdings, vasHolding], without(quotes, "USDAUD=X"), allLive, "AUD");
  assert.deepEqual(v.positions.map((p) => p.asset), ["VAS", "VOO", "AAPL", "crypto:bitcoin"]);
  for (const k of ["value", "dayChange", "dayChangePct", "gain", "gainPct", "weight"]) {
    assert.equal(pos(v, "VOO")[k], null, k);
  }
  assert.equal(pos(v, "VOO").quantity, 12);
  assert.equal(pos(v, "VAS").weight, 100);
});
test("missing price excludes the position", () => {
  const v = valuePortfolio(holdings, without(quotes, "VOO"), allLive, "AUD");
  assert.deepEqual(v.excluded, ["VOO"]);
  assert.equal(pos(v, "VOO").quote, null);
  assert.equal(pos(v, "VOO").value, null);
});
test("a missing price state excludes the position even when a quote exists", () => {
  const v = valuePortfolio(holdings, quotes, { ...allLive, VOO: "missing" }, "AUD");
  assert.deepEqual(v.excluded, ["VOO"]);
  assert.equal(pos(v, "VOO").state, "missing");
});
test("missing FX for the cost currency excludes the position", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 5, costCurrency: "EUR" }];
  const v = valuePortfolio(h, quotes, allLive, "AUD");
  assert.deepEqual(v.excluded, ["VOO"]);
  assert.equal(v.total, 0);
});
test("zero quantity and zero cost never produce NaN or Infinity", () => {
  const v = valuePortfolio([{ asset: "VOO", quantity: 0, cost: 0 }], quotes, allLive, "AUD");
  assert.equal(v.total, 0);
  assert.equal(v.gain, 0);
  assert.equal(v.gainPct, null);
  assert.equal(v.dayChangePct, null);
  assert.equal(pos(v, "VOO").weight, null);
  assert.equal(pos(v, "VOO").gainPct, null);
  assert.deepEqual(v.excluded, []);
});
test("zero cost with non-zero quantity gives null gainPct but a gain", () => {
  const v = valuePortfolio([{ asset: "VOO", quantity: 1, cost: 0 }], quotes, allLive, "AUD");
  assert.equal(pos(v, "VOO").gainPct, null);
  assert.ok(near(pos(v, "VOO").gain, 715.59 * 1.431));
  assert.equal(v.gainPct, null);
  assert.equal(pos(v, "VOO").weight, 100);
});
test("non-zero cost gives a numeric gainPct (other side of the zero boundary)", () => {
  const v = valuePortfolio([{ asset: "VOO", quantity: 1, cost: 1 }], quotes, allLive, "AUD");
  assert.equal(typeof pos(v, "VOO").gainPct, "number");
  assert.equal(typeof v.gainPct, "number");
});
test("zero previous close gives null dayChangePct", () => {
  const qs = { ...quotes, VOO: q("VOO", 10, 0, "USD") };
  const v = valuePortfolio([{ asset: "VOO", quantity: 1, cost: 1 }], qs, allLive, "AUD");
  assert.equal(pos(v, "VOO").dayChangePct, null);
  assert.ok(near(pos(v, "VOO").dayChange, 10 * 1.431));
});
test("day change that wipes out the prior value gives null portfolio dayChangePct", () => {
  // previous value (total - dayChange) is 0 when the price rose from 0.
  const qs = { VOO: q("VOO", 10, 0, "AUD") };
  const v = valuePortfolio([{ asset: "VOO", quantity: 1, cost: 1 }], qs, allLive, "AUD");
  assert.equal(v.dayChangePct, null);
});
test("empty portfolio", () => {
  const v = valuePortfolio([], {}, {}, "AUD");
  assert.deepEqual(v.positions, []);
  assert.deepEqual(v.stale, []);
  assert.deepEqual(v.excluded, []);
  assert.equal(v.total, 0);
  assert.equal(v.dayChange, 0);
  assert.equal(v.gain, 0);
  assert.equal(v.gainPct, null);
  assert.equal(v.dayChangePct, null);
});
test("fractional fund units", () => {
  const v = valuePortfolio([{ asset: "VTSAX", quantity: 30.512, cost: 98.1 }], quotes, allLive, "USD");
  assert.ok(near(v.total, 30.512 * 185.93));
  assert.ok(near(v.gain, 30.512 * (185.93 - 98.1)));
});

// ---- combinedSeries

const DAY = 86_400_000;
const MIN15 = 900_000;
const HOUR_MS = 3_600_000;
const MONDAY = Date.UTC(2026, 0, 5); // a Monday, midnight UTC
const noon = (dayIndex) => MONDAY + dayIndex * DAY + DAY / 2;
const series = (asset, currency, points) => ({ asset, currency, points });
const valueAt = (s, t) => s.points.find(([pt]) => pt === t)?.[1];
const usdQuotes = { VOO: q("VOO", 700, 700, "USD"), "crypto:bitcoin": q("crypto:bitcoin", 1000, 1000, "USD", "crypto") };

test("combined series fills stock weekends from Friday", () => {
  const h = [{ asset: "crypto:bitcoin", quantity: 1, cost: 1 }, { asset: "VOO", quantity: 1, cost: 1 }];
  const btc7 = series("crypto:bitcoin", "USD", [0, 1, 2, 3, 4, 5, 6].map((d) => [noon(d), 1000]));
  const vooWeekdays = series("VOO", "USD", [[noon(0), 690], [noon(1), 691], [noon(2), 692], [noon(3), 693], [noon(4), 700]]);
  const s = combinedSeries(h, { "crypto:bitcoin": btc7, VOO: vooWeekdays }, usdQuotes, "1M", "USD");
  assert.equal(s.asset, "portfolio");
  assert.equal(s.currency, "USD");
  assert.equal(s.points.length, 7);
  assert.equal(valueAt(s, MONDAY + 5 * DAY), 1000 + 700); // Saturday
  assert.equal(valueAt(s, MONDAY + 6 * DAY), 1000 + 700); // Sunday
  assert.equal(valueAt(s, MONDAY + 4 * DAY), 1000 + 700); // Friday
  assert.equal(valueAt(s, MONDAY), 1000 + 690);
});
test("quantity multiplies the series value", () => {
  const h = [{ asset: "VOO", quantity: 3, cost: 1 }];
  const s = combinedSeries(h, { VOO: series("VOO", "USD", [[noon(0), 10]]) }, usdQuotes, "1M", "USD");
  assert.deepEqual(s.points, [[MONDAY, 30]]);
});
test("the grid starts at the latest first point, so a later-starting asset never appears mid-series", () => {
  const h = [{ asset: "crypto:bitcoin", quantity: 1, cost: 1 }, { asset: "VOO", quantity: 1, cost: 1 }];
  const btc = series("crypto:bitcoin", "USD", [[noon(0), 1000], [noon(1), 1000]]);
  const voo = series("VOO", "USD", [[noon(1), 700]]);
  const s = combinedSeries(h, { "crypto:bitcoin": btc, VOO: voo }, usdQuotes, "1M", "USD");
  assert.deepEqual(s.points, [[MONDAY + DAY, 1700]]);
});
test("crypto 24h series with a session-only stock series and flat prices has zero range change", () => {
  const T0 = MONDAY + 14 * HOUR_MS; // stock open, on a 15-minute boundary
  const h = [{ asset: "crypto:bitcoin", quantity: 1, cost: 1 }, { asset: "VOO", quantity: 1, cost: 1 }];
  const btc = series("crypto:bitcoin", "USD", Array.from({ length: 97 }, (_, i) => [T0 - 24 * HOUR_MS + i * MIN15, 1000]));
  const voo = series("VOO", "USD", Array.from({ length: 27 }, (_, i) => [T0 + i * MIN15, 700]));
  const s = combinedSeries(h, { "crypto:bitcoin": btc, VOO: voo }, usdQuotes, "1D", "USD");
  assert.equal(s.points[0][0], T0);
  assert.equal(s.points[0][1], 1700);
  assert.equal(rangeChange(s).change, 0);
});
test("a fund with five daily points does not stretch a 1D series beyond the stock session", () => {
  const T0 = MONDAY + 14 * HOUR_MS;
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }, { asset: "VTSAX", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", Array.from({ length: 27 }, (_, i) => [T0 + i * MIN15, 700]));
  const fund = series("VTSAX", "USD", [-4, -3, -2, -1, 0].map((d) => [MONDAY + d * DAY, 185]));
  const s = combinedSeries(h, { VOO: voo, VTSAX: fund }, usdQuotes, "1D", "USD");
  assert.equal(s.points[0][0], T0);
  assert.equal(s.points.length, 27);
  assert.equal(rangeChange(s).change, 0);
});
test("an FX series that starts after the asset series does not move the start; its first rate applies before it", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[noon(0), 100], [noon(1), 100], [noon(2), 100]]);
  const fx = series("USDAUD=X", "AUD", [[noon(1), 1.5], [noon(2), 1.6]]);
  const s = combinedSeries(h, { VOO: voo, "USDAUD=X": fx }, quotes, "1M", "AUD");
  // Day 0 uses the series' first rate (1.5), not the current quote (1.431): no jump where the FX series begins.
  assert.deepEqual(s.points.map(([t]) => t), [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY]);
  assert.ok(near(s.points[0][1], 150) && near(s.points[1][1], 150) && near(s.points[2][1], 160));
});
test("24 h of USD crypto with a USDAUD=X series that starts late keeps the whole window; flat prices give no change", () => {
  // At 23:15 UTC Yahoo's 1D FX series has only begun (its day starts at 23:00 UTC), while
  // CoinGecko's covers the last 24 hours.
  const end = MONDAY + DAY + 23 * HOUR_MS + MIN15;
  const h = [{ asset: "crypto:bitcoin", quantity: 1, cost: 1 }];
  const btc = series("crypto:bitcoin", "USD", Array.from({ length: 97 }, (_, i) => [end - 24 * HOUR_MS + i * MIN15, 1000]));
  const fx = series("USDAUD=X", "AUD", [[end - MIN15, 1.5], [end, 1.5]]);
  const s = combinedSeries(h, { "crypto:bitcoin": btc, "USDAUD=X": fx }, quotes, "1D", "AUD");
  assert.equal(s.points.length, 97);
  assert.equal(s.points[0][0], end - 24 * HOUR_MS);
  assert.ok(s.points.every(([, v]) => near(v, 1500)));
  assert.equal(rangeChange(s).change, 0);
});
test("an asset with no series, or an empty one, is absent from every bucket", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }, { asset: "crypto:bitcoin", quantity: 1, cost: 1 }, { asset: "AAPL", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[noon(0), 5], [noon(1), 6]]);
  const s = combinedSeries(h, { VOO: voo, AAPL: series("AAPL", "USD", []) }, usdQuotes, "1M", "USD");
  assert.deepEqual(s.points, [[MONDAY, 5], [MONDAY + DAY, 6]]);
});
test("a point exactly at t + step belongs to the next bucket; one at t + step - 1 to this one (1D, 15 min)", () => {
  const T0 = MONDAY;
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[T0, 10], [T0 + MIN15 - 1, 20], [T0 + MIN15, 30]]);
  const s = combinedSeries(h, { VOO: voo }, usdQuotes, "1D", "USD");
  assert.deepEqual(s.points, [[T0, 20], [T0 + MIN15, 30]]);
});
test("buckets start at the step-aligned floor of the earliest point and end at the latest point's bucket", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[MONDAY + 5, 10], [MONDAY + 3 * MIN15 + 5, 40]]);
  const s = combinedSeries(h, { VOO: voo }, usdQuotes, "1D", "USD");
  assert.deepEqual(s.points.map(([t]) => t), [MONDAY, MONDAY + MIN15, MONDAY + 2 * MIN15, MONDAY + 3 * MIN15]);
  assert.deepEqual(s.points.map(([, v]) => v), [10, 10, 10, 40]);
});
test("step widths: 1W is one hour, 1M, 3M, 6M and 1Y are one day", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[MONDAY, 1], [MONDAY + 3 * 3_600_000, 2]]);
  const w = combinedSeries(h, { VOO: voo }, usdQuotes, "1W", "USD");
  assert.deepEqual(w.points.map(([t]) => t - MONDAY), [0, 3_600_000, 2 * 3_600_000, 3 * 3_600_000]);
  for (const range of ["1M", "3M", "6M", "1Y"]) {
    const d = combinedSeries(h, { VOO: voo }, usdQuotes, range, "USD");
    assert.deepEqual(d.points, [[MONDAY, 2]]);
  }
});
test("combined series converts per grid point with the FX series", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo2d = series("VOO", "USD", [[noon(0), 100], [noon(1), 100]]);
  const fx2d = series("USDAUD=X", "AUD", [[noon(0), 1.4], [noon(1), 1.5]]);
  const s = combinedSeries(h, { VOO: voo2d, "USDAUD=X": fx2d }, quotes, "1M", "AUD");
  assert.deepEqual(s.points.map(([, v]) => v), [140, 150]);
  assert.equal(s.currency, "AUD");
});
test("an FX point exactly at t + step applies to the next bucket", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[noon(0), 100], [noon(1), 100]]);
  const fxAtEdge = series("USDAUD=X", "AUD", [[noon(0), 1.4], [MONDAY + DAY, 1.5]]);
  const s = combinedSeries(h, { VOO: voo, "USDAUD=X": fxAtEdge }, quotes, "1M", "AUD");
  assert.deepEqual(s.points.map(([, v]) => v), [140, 150]);
  const fxJustBefore = series("USDAUD=X", "AUD", [[noon(0), 1.4], [MONDAY + DAY - 1, 1.5]]);
  const s2 = combinedSeries(h, { VOO: voo, "USDAUD=X": fxJustBefore }, quotes, "1M", "AUD");
  assert.deepEqual(s2.points.map(([, v]) => v), [150, 150]);
});
test("current FX rate is used when there is no FX series or it is empty; a late-starting one applies its first rate from the start", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[noon(0), 100], [noon(1), 100]]);
  const none = combinedSeries(h, { VOO: voo }, quotes, "1M", "AUD");
  assert.ok(none.points.every(([, v]) => near(v, 143.1)));
  const lateFx = series("USDAUD=X", "AUD", [[noon(1), 1.5]]);
  const late = combinedSeries(h, { VOO: voo, "USDAUD=X": lateFx }, quotes, "1M", "AUD");
  assert.deepEqual(late.points, [[MONDAY, 150], [MONDAY + DAY, 150]]);
  const emptyFx = series("USDAUD=X", "AUD", []);
  const empty = combinedSeries(h, { VOO: voo, "USDAUD=X": emptyFx }, quotes, "1M", "AUD");
  assert.ok(empty.points.length === 2 && empty.points.every(([, v]) => near(v, 143.1)));
});
test("an asset with no FX at all is left out of the bucket", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }, { asset: "VAS", quantity: 1, cost: 1 }];
  const voo = series("VOO", "USD", [[noon(0), 100]]);
  const vas = series("VAS", "AUD", [[noon(0), 1000]]);
  const noFx = without(quotes, "USDAUD=X");
  const s = combinedSeries(h, { VOO: voo, VAS: vas }, noFx, "1M", "AUD");
  assert.deepEqual(s.points, [[MONDAY, 1000]]);
  const onlyVoo = combinedSeries([h[0]], { VOO: voo }, noFx, "1M", "AUD");
  assert.deepEqual(onlyVoo.points, []);
});
test("series for assets that are not held are ignored", () => {
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  const s = combinedSeries(h, {
    VOO: series("VOO", "USD", [[noon(0), 5]]),
    AAPL: series("AAPL", "USD", [[noon(0) - 10 * DAY, 99]]),
  }, usdQuotes, "1M", "USD");
  assert.deepEqual(s.points, [[MONDAY, 5]]);
});
test("empty input yields no points", () => {
  assert.deepEqual(combinedSeries([], {}, {}, "1D", "AUD"), { asset: "portfolio", currency: "AUD", points: [] });
  const h = [{ asset: "VOO", quantity: 1, cost: 1 }];
  assert.deepEqual(combinedSeries(h, { VOO: series("VOO", "USD", []) }, usdQuotes, "1D", "USD").points, []);
});

// ---- rangeChange

test("rangeChange", () => {
  assert.deepEqual(rangeChange({ asset: "p", currency: "AUD", points: [[0, 100], [1, 110]] }), { change: 10, pct: 10 });
});
test("rangeChange uses first and last points and can be negative", () => {
  assert.deepEqual(rangeChange({ asset: "p", currency: "AUD", points: [[0, 200], [1, 500], [2, 150]] }), { change: -50, pct: -25 });
});
test("rangeChange with fewer than two points is zero with null pct", () => {
  assert.deepEqual(rangeChange({ asset: "p", currency: "AUD", points: [] }), { change: 0, pct: null });
  assert.deepEqual(rangeChange({ asset: "p", currency: "AUD", points: [[0, 100]] }), { change: 0, pct: null });
});
test("rangeChange pct is null when the first value is 0, numeric otherwise", () => {
  assert.deepEqual(rangeChange({ asset: "p", currency: "AUD", points: [[0, 0], [1, 5]] }), { change: 5, pct: null });
  assert.deepEqual(rangeChange({ asset: "p", currency: "AUD", points: [[0, 1], [1, 5]] }), { change: 4, pct: 400 });
});

test("one asset held in two cost currencies: each position keeps its holding, and the asset is listed once", () => {
  const two = [{ asset: "AAPL", quantity: 1, cost: 50 }, { asset: "AAPL", quantity: 10, cost: 20, costCurrency: "EUR" }];
  const stale = valuePortfolio(two, quotes, Object.assign({}, allLive, { AAPL: "stale" }), "USD");
  assert.deepEqual(stale.stale, ["AAPL"]);
  // No EURUSD=X: the EUR-cost holding is left out, its sibling still valued.
  assert.deepEqual(stale.excluded, ["AAPL"]);
  assert.deepEqual(stale.positions.map((p) => [p.holding, p.value === null]), [[two[0], false], [two[1], true]]);
  assert.notEqual(stale.positions[0].key, stale.positions[1].key);
  const missing = valuePortfolio(two, {}, {}, "USD");
  assert.deepEqual(missing.excluded, ["AAPL"]);
});

// ---- Cash (lib/cash.mjs derives its quotes, states and series from exchange rates)

const cents = (n) => Math.round(n * 100) / 100; // rates are binary fractions
const CASH_NOW = Date.UTC(2026, 9, 16, 12);
const rateQuote = (asset, price, previousClose, currency) => ({
  asset, symbol: asset, name: asset, price, previousClose, currency, kind: "fx", asOf: CASH_NOW, session: null, provider: "yahoo",
});
const cashHoldings = [
  { asset: "cash:EUR", quantity: 5000, cost: 1.6, costCurrency: "AUD" },
  { asset: "cash:AUD", quantity: 2000, cost: 1, costCurrency: "AUD" },
];
/** Quotes and states as MarketService publishes them: fetched rates plus derived cash. */
const withCash = (rates, base) => {
  const assets = cashHoldings.map((h) => h.asset);
  const fetchedStates = Object.fromEntries(Object.keys(rates).map((a) => [a, "live"]));
  return {
    quotes: Object.assign({}, rates, cashQuotes(assets, rates, base, CASH_NOW)),
    states: Object.assign({}, fetchedStates, cashStates(assets, fetchedStates, base)),
  };
};

test("cash is valued at the rate, moves with it, and gains against the rate converted at", () => {
  const { quotes, states } = withCash({ "EURAUD=X": rateQuote("EURAUD=X", 1.65, 1.64, "AUD") }, "AUD");
  const p = valuePortfolio(cashHoldings, quotes, states, "AUD");
  const eur = p.positions.find((x) => x.asset === "cash:EUR");
  assert.deepEqual([eur.value, eur.dayChange, eur.gain].map(cents), [8250, 50, 250]);
  assert.equal(p.positions.find((x) => x.asset === "cash:AUD").gain, 0);
  assert.equal(cents(p.total), 10250);
});

test("after a base change, cash bought with AUD gains through the AUD rate", () => {
  const { quotes, states } = withCash({
    "EURUSD=X": rateQuote("EURUSD=X", 1.09, 1.08, "USD"),
    "AUDUSD=X": rateQuote("AUDUSD=X", 0.66, 0.66, "USD"),
  }, "USD");
  const p = valuePortfolio([cashHoldings[0]], quotes, states, "USD");
  assert.equal(cents(p.positions[0].value), 5450);
  assert.equal(cents(p.positions[0].gain), cents(5450 - 5000 * 1.6 * 0.66));
});

test("a portfolio of base cash alone charts flat", () => {
  const s = combinedSeries([cashHoldings[1]], cashSeries(["cash:AUD"], {}, "AUD", "1M", CASH_NOW), {}, "1M", "AUD");
  assert.ok(s.points.length >= 2);
  assert.deepEqual(rangeChange(s), { change: 0, pct: 0 });
});
