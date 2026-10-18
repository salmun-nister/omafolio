import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCash, cashCurrency, cashPairs, cashQuotes, cashStates, startingCost, searchCash,
  historySources, cashSeries,
} from "../lib/cash.mjs";

const NOW = new Date(2026, 9, 18, 12, 0).getTime();
const DAY = 24 * 3600 * 1000;
const rate = {
  asset: "EURAUD=X", symbol: "EURAUD=X", name: "EUR/AUD", price: 1.65, previousClose: 1.64,
  currency: "AUD", kind: "fx", asOf: NOW - 60000, provider: "yahoo",
  session: { start: 0, end: 1, timezone: "Europe/London" }, dayRange: { low: 1.63, high: 1.66 },
};

test("references: only cash: names cash, and the currency follows the prefix", () => {
  assert.equal(isCash("cash:EUR"), true);
  assert.equal(isCash("VOO"), false);
  assert.equal(isCash("crypto:bitcoin"), false);
  assert.equal(cashCurrency("cash:EUR"), "EUR");
});

test("pairs: one per foreign currency, none for the base, non-cash ignored", () => {
  assert.deepEqual(cashPairs(["cash:USD", "VOO", "cash:EUR", "cash:AUD", "cash:EUR"], "AUD"), ["EURAUD=X", "USDAUD=X"]);
});

test("quote: priced in the base at the rate, with its close, time, session and day range", () => {
  const q = cashQuotes(["cash:EUR", "VOO"], { "EURAUD=X": rate }, "AUD", NOW)["cash:EUR"];
  assert.deepEqual([q.asset, q.symbol, q.name, q.kind, q.provider, q.currency, q.price, q.previousClose, q.asOf],
    ["cash:EUR", "EUR cash", "Euro", "cash", "yahoo", "AUD", 1.65, 1.64, rate.asOf]);
  assert.deepEqual([q.session, q.dayRange], [rate.session, rate.dayRange]);
});

test("quote: base-currency cash is 1 now; no rate means no quote; an unlisted code is named by its code", () => {
  const out = cashQuotes(["cash:AUD", "cash:EUR", "cash:XYZ", "VOO"],
    { "XYZAUD=X": Object.assign({}, rate, { asset: "XYZAUD=X" }) }, "AUD", NOW);
  const aud = out["cash:AUD"];
  assert.deepEqual([aud.price, aud.previousClose, aud.asOf, aud.session, aud.currency], [1, 1, NOW, null, "AUD"]);
  assert.equal("cash:EUR" in out, false);
  assert.equal(out["cash:XYZ"].name, "XYZ");
  assert.deepEqual(Object.keys(out).sort(), ["cash:AUD", "cash:XYZ"]);
});

test("states: a cash asset has its rate's state, base cash is live, no state is missing", () => {
  assert.deepEqual(cashStates(["cash:EUR", "cash:AUD", "cash:JPY", "VOO"], { "EURAUD=X": "stale" }, "AUD"),
    { "cash:EUR": "stale", "cash:AUD": "live", "cash:JPY": "missing" });
});

test("starting cost: 1 for base cash, the current rate when known, else 0", () => {
  assert.equal(startingCost("cash:AUD", {}, "AUD"), 1);
  assert.equal(startingCost("cash:EUR", { "EURAUD=X": rate }, "AUD"), 1.65);
  assert.equal(startingCost("cash:JPY", {}, "AUD"), 0);
});

test("search: by code or name, case-insensitive, blank finds nothing", () => {
  assert.deepEqual(searchCash("eur")[0], { asset: "cash:EUR", symbol: "EUR cash", name: "Euro", kind: "cash", exchange: "Cash" });
  assert.equal(searchCash("euro")[0].asset, "cash:EUR");
  assert.equal(searchCash("yen")[0].asset, "cash:JPY");
  assert.equal(searchCash("Swiss")[0].asset, "cash:CHF");
  assert.deepEqual(searchCash("  "), []);
  assert.deepEqual(searchCash("zzz"), []);
});

test("search: codes match from two letters, names from a word's start from three", () => {
  // Short tickers ("T", "KO", "MA") must not be buried under currencies.
  assert.deepEqual(searchCash("t"), []);
  assert.deepEqual(searchCash("ko"), []);
  assert.deepEqual(searchCash("ma"), []);
  assert.deepEqual(searchCash("kor").map((r) => r.asset), ["cash:KRW", "cash:CZK"]);
  assert.deepEqual(searchCash("US").map((r) => r.asset), ["cash:USD"]);
  assert.deepEqual(searchCash("dollar").map((r) => r.asset).slice(0, 3), ["cash:USD", "cash:AUD", "cash:CAD"]);
});

test("cash series: never start later than the history they are charted with", () => {
  // At 23:15 UTC Yahoo's 1D rate has only just begun (its day starts at 23:00 UTC), while a
  // stock's 1D series began at the open. The cash series holds the rate's first value back
  // to that start, as portfolio.combinedSeries does for exchange rates, so holding foreign
  // cash does not cut the portfolio chart down to minutes.
  const start = NOW - 10 * 3600 * 1000;
  const voo = { asset: "VOO", currency: "USD", points: [[start, 500], [NOW - 3 * 3600 * 1000, 510]] };
  const eur = { asset: "EURAUD=X", currency: "AUD", points: [[NOW - 900000, 1.6], [NOW, 1.61]] };
  const out = cashSeries(["cash:EUR", "cash:AUD"], { VOO: voo, "EURAUD=X": eur }, "AUD", "1D", NOW);
  assert.deepEqual(out["cash:EUR"].points, [[start, 1.6], [NOW - 900000, 1.6], [NOW, 1.61]]);
  assert.equal(out["cash:AUD"].points[0][0], start);
});

test("history sources: cash becomes its rate pair, base cash needs nothing", () => {
  assert.deepEqual(historySources(["VOO", "cash:EUR", "cash:AUD", "EURAUD=X"], "AUD"), ["VOO", "EURAUD=X"]);
});

test("cash series: the rate's series under the cash asset; none while the rate has none", () => {
  const eur = { asset: "EURAUD=X", currency: "AUD", points: [[0, 1.6], [60000, 1.65]] };
  const out = cashSeries(["cash:EUR", "cash:JPY", "VOO"], { "EURAUD=X": eur }, "AUD", "1M", NOW);
  assert.deepEqual(out["cash:EUR"], { asset: "cash:EUR", currency: "AUD", points: eur.points });
  assert.deepEqual(Object.keys(out), ["cash:EUR"]);
});

test("cash series: base cash is flat at 1 across the range's span", () => {
  assert.deepEqual(cashSeries(["cash:AUD"], {}, "AUD", "1W", NOW)["cash:AUD"],
    { asset: "cash:AUD", currency: "AUD", points: [[NOW - 7 * DAY, 1], [NOW, 1]] });
  assert.deepEqual(cashSeries(["cash:AUD"], {}, "AUD", "1Y", NOW)["cash:AUD"].points[0], [NOW - 365 * DAY, 1]);
});

test("cash series: base cash ends where the latest fetched series ends, so a closed market adds no flat tail", () => {
  const voo = { asset: "VOO", currency: "USD", points: [[NOW - 3 * DAY, 500], [NOW - 2 * DAY, 510]] };
  assert.deepEqual(cashSeries(["cash:AUD"], { VOO: voo, EMPTY: { asset: "EMPTY", currency: "USD", points: [] } }, "AUD", "1D", NOW)["cash:AUD"].points,
    [[NOW - 3 * DAY, 1], [NOW - 2 * DAY, 1]]);
});
