import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCash, cashCurrency, cashPairs, cashQuotes, cashStates, startingCost, searchCash,
} from "../lib/cash.mjs";

const NOW = new Date(2026, 9, 18, 12, 0).getTime();
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
  assert.equal(searchCash("yen")[0].asset, "cash:JPY");
  assert.equal(searchCash("Swiss")[0].asset, "cash:CHF");
  assert.deepEqual(searchCash("  "), []);
  assert.deepEqual(searchCash("zzz"), []);
});
