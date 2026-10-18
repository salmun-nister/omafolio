import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assetsToFetch, fxPairs, priceState, nextDelayMs, mergeQuotes, notFound, keptSeries, inBackoff,
  recordSuccess, recordFailure, canFetchNow, STALE_AFTER_MS, CLOSED_POLL_MS, MAX_BACKOFF_MS,
} from "../lib/market.mjs";

const T0 = 1_700_000_000_000;
const H = 3_600_000;
const open = { start: T0, end: T0 + 6.5 * H, timezone: "America/New_York" };
const healthy = { failures: 0, failingSince: null, lastSuccess: T0 };
const failingSince = (t) => ({ failures: 1, failingSince: t, lastSuccess: null });
const q = (asset, currency, kind = "stock", session = null) => ({
  asset, symbol: asset, name: asset, price: 1, previousClose: 1, currency, kind, asOf: T0, session,
  provider: asset.startsWith("crypto:") ? "coingecko" : "yahoo",
});

test("constants", () => {
  assert.equal(STALE_AFTER_MS, 180000);
  assert.equal(CLOSED_POLL_MS, 900000);
  assert.equal(MAX_BACKOFF_MS, 900000);
});

test("bar items are fetched even when not held or watched", () => {
  assert.deepEqual(assetsToFetch({ bar: ["portfolio", "crypto:bitcoin"], watch: [] }, []), ["crypto:bitcoin"]);
});
test("assetsToFetch orders holdings, watch, bar and de-duplicates", () => {
  const holdings = [{ asset: "VOO", quantity: 1, cost: 1 }, { asset: "AAPL", quantity: 1, cost: 1 }];
  assert.deepEqual(
    assetsToFetch({ bar: ["portfolio", "MSFT", "VOO"], watch: ["MSFT", "AAPL", "TSLA"] }, holdings),
    ["VOO", "AAPL", "MSFT", "TSLA"],
  );
});

test("no FX pair for base-currency assets", () => {
  const quotes = { VOO: q("VOO", "USD"), "crypto:bitcoin": q("crypto:bitcoin", "USD", "crypto") };
  assert.deepEqual(fxPairs(quotes, [], "USD"), []);
  assert.deepEqual(fxPairs(quotes, [], "AUD"), ["USDAUD=X"]);
});
test("crypto is converted like any other asset: its quote currency needs a pair", () => {
  const btc = { "crypto:bitcoin": q("crypto:bitcoin", "USD", "crypto") };
  assert.deepEqual(fxPairs(btc, [], "USD"), []);
  assert.deepEqual(fxPairs(btc, [], "AUD"), ["USDAUD=X"]);
  // A crypto quote cached from before crypto was priced in USD is still converted by its own currency.
  assert.deepEqual(fxPairs({ "crypto:bitcoin": q("crypto:bitcoin", "AUD", "crypto") }, [], "AUD"), []);
  assert.deepEqual(fxPairs({ "crypto:bitcoin": q("crypto:bitcoin", "AUD", "crypto") }, [], "USD"), ["AUDUSD=X"]);
});
test("fx quotes in foreign currencies add no pair", () => {
  const quotes = { "USDEUR=X": q("USDEUR=X", "EUR", "fx") };
  assert.deepEqual(fxPairs(quotes, [], "AUD"), []);
});
test("cost currencies need FX too", () => {
  assert.deepEqual(fxPairs({}, [{ asset: "crypto:bitcoin", quantity: 1, cost: 1, costCurrency: "EUR" }], "AUD"), ["EURAUD=X"]);
  assert.deepEqual(fxPairs({}, [{ asset: "VOO", quantity: 1, cost: 1, costCurrency: "AUD" }], "AUD"), []);
  assert.deepEqual(fxPairs({}, [{ asset: "VOO", quantity: 1, cost: 1 }], "AUD"), []);
});
test("fxPairs de-duplicates and sorts", () => {
  const quotes = { A: q("A", "USD"), B: q("B", "USD"), C: q("C", "EUR") };
  const holdings = [{ asset: "A", quantity: 1, cost: 1, costCurrency: "GBP" }, { asset: "B", quantity: 1, cost: 1, costCurrency: "EUR" }];
  assert.deepEqual(fxPairs(quotes, holdings, "AUD"), ["EURAUD=X", "GBPAUD=X", "USDAUD=X"]);
});

test("states", () => {
  assert.equal(priceState(undefined, healthy, T0), "missing");
  assert.equal(priceState(q("VOO", "USD", "etf", open), healthy, T0 + H), "live");
  assert.equal(priceState(q("VOO", "USD", "etf", open), healthy, T0 + 8 * H), "closed");
  assert.equal(priceState(q("VOO", "USD", "etf", open), failingSince(T0 + H), T0 + H + 181000), "stale");
  assert.equal(priceState(q("VOO", "USD", "etf", open), failingSince(T0 + H), T0 + H + 179000), "live");
  assert.equal(priceState(q("VOO", "USD", "etf", open), failingSince(T0), T0 + 8 * H), "closed");
  assert.equal(priceState({ ...q("crypto:bitcoin", "AUD", "crypto"), fromCache: true }, healthy, T0), "stale");
  assert.equal(priceState({ ...q("VOO", "USD", "etf", open), fromCache: true }, healthy, T0 + 8 * H), "closed");
});
test("stale boundary: exactly 3 minutes is live", () => {
  const quote = q("VOO", "USD", "etf", open);
  const h = failingSince(T0 + H);
  assert.equal(priceState(quote, h, T0 + H + 180000), "live");
  assert.equal(priceState(quote, h, T0 + H + 180001), "stale");
});
test("session boundaries", () => {
  const quote = q("VOO", "USD", "etf", open);
  assert.equal(priceState(quote, healthy, open.start - 1), "closed");
  assert.equal(priceState(quote, healthy, open.start), "live");
  assert.equal(priceState(quote, healthy, open.end - 1), "live");
  assert.equal(priceState(quote, healthy, open.end), "closed");
});
test("undefined health counts as healthy; fromCache with open session is stale", () => {
  assert.equal(priceState(q("VOO", "USD", "etf", open), undefined, T0 + H), "live");
  assert.equal(priceState({ ...q("VOO", "USD", "etf", open), fromCache: true }, undefined, T0 + H), "stale");
});

test("schedule", () => {
  assert.equal(nextDelayMs("coingecko", {}, healthy, 60, T0), 60000);
  assert.equal(nextDelayMs("yahoo", { VOO: q("VOO", "USD", "etf", open) }, healthy, 60, T0 + H), 60000);
  assert.equal(nextDelayMs("yahoo", { VOO: q("VOO", "USD", "etf", open) }, healthy, 60, T0 + 8 * H), 900000);
  assert.equal(nextDelayMs("yahoo", {}, healthy, 120, T0), 120000);
});
test("schedule: yahoo open if any yahoo quote is open; other providers' quotes ignored", () => {
  const closed = q("AAPL", "USD", "stock", { ...open, end: T0 + H });
  const quotes = { AAPL: closed, VOO: q("VOO", "USD", "etf", open) };
  assert.equal(nextDelayMs("yahoo", quotes, healthy, 60, T0 + 2 * H), 60000);
  assert.equal(nextDelayMs("yahoo", { AAPL: closed }, healthy, 60, T0 + 2 * H), 900000);
  assert.equal(nextDelayMs("yahoo", { AAPL: closed, "crypto:bitcoin": q("crypto:bitcoin", "USD", "crypto") }, healthy, 60, T0 + 2 * H), 900000);
});
test("backoff doubles from 60s and caps at 15 minutes", () => {
  const delays = [1, 2, 3, 4, 5, 6].map((n) => nextDelayMs("yahoo", {}, { failures: n, failingSince: T0, lastSuccess: null }, 60, T0));
  assert.deepEqual(delays, [60000, 120000, 240000, 480000, 900000, 900000]);
});
test("backoff boundary: 0 vs 1 failures, and applies when market closed", () => {
  const closedQuotes = { VOO: q("VOO", "USD", "etf", open) };
  assert.equal(nextDelayMs("yahoo", {}, { failures: 0, failingSince: null, lastSuccess: null }, 300, T0), 300000);
  assert.equal(nextDelayMs("yahoo", {}, { failures: 1, failingSince: T0, lastSuccess: null }, 300, T0), 60000);
  assert.equal(nextDelayMs("yahoo", closedQuotes, { failures: 2, failingSince: T0, lastSuccess: null }, 60, T0 + 8 * H), 120000);
  assert.equal(nextDelayMs("yahoo", {}, undefined, 60, T0), 60000);
});

test("an open price its provider keeps answering without goes stale after 3 minutes", () => {
  const received = { ...q("crypto:bitcoin", "USD", "crypto"), receivedAt: T0 };
  const answeredAt = (t) => ({ failures: 0, failingSince: null, lastSuccess: t, lastFailure: null });
  assert.equal(priceState(received, answeredAt(T0), T0), "live");
  assert.equal(priceState(received, answeredAt(T0 + 180000), T0 + 180000), "live");
  assert.equal(priceState(received, answeredAt(T0 + 180001), T0 + 180001), "stale");
  // Time alone does not make it stale: only answers that leave it out do.
  assert.equal(priceState(received, answeredAt(T0), T0 + 24 * H), "live");
  // A quote with no receipt time (a cached one) is judged as before.
  assert.equal(priceState(q("crypto:bitcoin", "USD", "crypto"), answeredAt(T0 + 24 * H), T0 + 24 * H), "live");
});
test("a left-out quote is stale even after the session it arrived with has ended", () => {
  const voo = { ...q("VOO", "USD", "etf", open), receivedAt: T0 + H };
  const answeredAt = (t) => ({ failures: 0, failingSince: null, lastSuccess: t, lastFailure: null });
  // Still arriving with each closed-market poll: closed.
  assert.equal(priceState({ ...voo, receivedAt: T0 + 8 * H }, answeredAt(T0 + 8 * H), T0 + 8 * H), "closed");
  // Left out since mid-session: stale during the session, after it, and on the next day.
  assert.equal(priceState(voo, answeredAt(T0 + 2 * H), T0 + 2 * H), "stale");
  assert.equal(priceState(voo, answeredAt(T0 + 8 * H), T0 + 8 * H), "stale");
  assert.equal(priceState(voo, answeredAt(T0 + 25 * H), T0 + 25 * H), "stale");
});
test("a sibling's fresh quote does not refresh an omitted one", () => {
  const btc = q("crypto:bitcoin", "USD", "crypto");
  const eth = q("crypto:ethereum", "USD", "crypto");
  const first = mergeQuotes({}, [btc, eth], T0);
  const later = mergeQuotes(first, [eth], T0 + 24 * H);
  assert.equal(later["crypto:bitcoin"].receivedAt, T0);
  assert.equal(later["crypto:ethereum"].receivedAt, T0 + 24 * H);
  const health = recordSuccess(undefined, T0 + 24 * H);
  assert.equal(priceState(later["crypto:bitcoin"], health, T0 + 24 * H), "stale");
  assert.equal(priceState(later["crypto:ethereum"], health, T0 + 24 * H), "live");
});

test("last good quote survives and fresh replaces", () => {
  const m = mergeQuotes({ VOO: q("VOO", "USD"), AAPL: q("AAPL", "USD") }, [{ ...q("VOO", "USD"), price: 2 }], T0);
  assert.equal(m.VOO.price, 2);
  assert.ok(m.AAPL);
  assert.equal(m.VOO.fromCache, undefined);
});
test("mergeQuotes does not mutate previous and drops fromCache of replaced quote", () => {
  const previous = { VOO: { ...q("VOO", "USD"), fromCache: true } };
  const m = mergeQuotes(previous, [{ ...q("VOO", "USD"), price: 3 }], T0);
  assert.notEqual(m, previous);
  assert.equal(previous.VOO.price, 1);
  assert.equal(previous.VOO.fromCache, true);
  assert.equal("fromCache" in m.VOO, false);
});

test("notFound: only requested assets with no quote at all, fresh or cached", () => {
  assert.deepEqual(notFound(["VOO", "VOOO"], { VOO: q("VOO", "USD") }), ["VOOO"]);
  // A response that omits an asset with a last good (or cached) quote leaves it priced.
  const held = mergeQuotes({ AAPL: q("AAPL", "USD"), MSFT: { ...q("MSFT", "USD"), fromCache: true } }, [q("VOO", "USD")], T0);
  assert.deepEqual(notFound(["VOO", "AAPL", "MSFT", "VOOO"], held), ["VOOO"]);
  assert.deepEqual(notFound([], held), []);
  assert.deepEqual(notFound(["VOO"], {}), ["VOO"]);
  // Only requested assets are reported.
  assert.deepEqual(notFound(["AAPL"], { VOO: q("VOO", "USD") }), ["AAPL"]);
  // Inherited keys are not quotes.
  assert.deepEqual(notFound(["toString"], {}), ["toString"]);
});

test("keptSeries: the answer's series, else the previous one", () => {
  const old = { asset: "VOO", currency: "USD", points: [[1, 1]] };
  const fresh = { asset: "VOO", currency: "USD", points: [[2, 2]] };
  const other = { asset: "AAPL", currency: "USD", points: [[3, 3]] };
  assert.equal(keptSeries(old, [fresh, other], "VOO"), fresh);
  assert.equal(keptSeries(null, [fresh], "VOO"), fresh);
  // A successful answer that leaves the asset out keeps what was held.
  assert.equal(keptSeries(old, [other], "VOO"), old);
  assert.equal(keptSeries(old, [], "VOO"), old);
  assert.equal(keptSeries(null, [other], "VOO"), null);
  // A failed request keeps it too.
  assert.equal(keptSeries(old, null, "VOO"), old);
  assert.equal(keptSeries(null, null, "VOO"), null);
});

test("inBackoff: from the latest failure until nextDelayMs's backoff has passed", () => {
  const after = (n, at) => ({ failures: n, failingSince: T0, lastSuccess: null, lastFailure: at });
  // One failure: 60 s.
  assert.equal(inBackoff(after(1, T0), T0), true);
  assert.equal(inBackoff(after(1, T0), T0 + 59999), true);
  assert.equal(inBackoff(after(1, T0), T0 + 60000), false);
  // The window counts from the latest failure, not the first.
  assert.equal(inBackoff(after(2, T0 + H), T0 + H + 119999), true);
  assert.equal(inBackoff(after(2, T0 + H), T0 + H + 120000), false);
  // Capped like the poll backoff.
  assert.equal(inBackoff(after(9, T0), T0 + MAX_BACKOFF_MS - 1), true);
  assert.equal(inBackoff(after(9, T0), T0 + MAX_BACKOFF_MS), false);
  // Same window the feed waits before retrying.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const d = nextDelayMs("coingecko", {}, after(n, T0), 60, T0);
    assert.equal(inBackoff(after(n, T0), T0 + d - 1), true);
    assert.equal(inBackoff(after(n, T0), T0 + d), false);
  }
  // Failure count boundary, whatever lastFailure says: 0 is not resting, 1 is.
  assert.equal(inBackoff({ failures: 0, failingSince: null, lastSuccess: T0, lastFailure: T0 }, T0), false);
  assert.equal(inBackoff({ failures: 1, failingSince: T0, lastSuccess: T0, lastFailure: T0 }, T0), true);
  // Healthy, never failed, or unknown: never in backoff.
  assert.equal(inBackoff({ failures: 0, failingSince: null, lastSuccess: T0, lastFailure: null }, T0), false);
  assert.equal(inBackoff(recordSuccess(after(3, T0), T0 + 1), T0 + 2), false);
  assert.equal(inBackoff(undefined, T0), false);
  // Straight from recordFailure.
  assert.equal(inBackoff(recordFailure(undefined, T0), T0 + 59999), true);
  assert.equal(inBackoff(recordFailure(undefined, T0), T0 + 60000), false);
});

test("health transitions", () => {
  const start = { failures: 0, failingSince: null, lastSuccess: 5, lastFailure: null };
  const f1 = recordFailure(start, 100);
  assert.deepEqual(f1, { failures: 1, failingSince: 100, lastSuccess: 5, lastFailure: 100 });
  assert.deepEqual(recordFailure(f1, 200), { failures: 2, failingSince: 100, lastSuccess: 5, lastFailure: 200 });
  assert.deepEqual(recordSuccess(f1, 300), { failures: 0, failingSince: null, lastSuccess: 300, lastFailure: null });
  assert.deepEqual(start, { failures: 0, failingSince: null, lastSuccess: 5, lastFailure: null });
  assert.deepEqual(recordFailure(undefined, 7), { failures: 1, failingSince: 7, lastSuccess: null, lastFailure: 7 });
  assert.deepEqual(recordSuccess(undefined, 7), { failures: 0, failingSince: null, lastSuccess: 7, lastFailure: null });
});

test("manual refresh inside the window is refused", () => {
  assert.equal(canFetchNow(T0, 60, T0 + 59000), false);
  assert.equal(canFetchNow(T0, 60, T0 + 59999), false);
  assert.equal(canFetchNow(T0, 60, T0 + 60000), true);
  assert.equal(canFetchNow(null, 60, T0), true);
});

test("fx pairs include the rates followed cash needs", () => {
  const quotes = { VOO: q("VOO", "USD") };
  assert.deepEqual(fxPairs(quotes, [], "AUD", ["cash:EUR", "cash:AUD", "VOO", "cash:USD"]), ["EURAUD=X", "USDAUD=X"]);
  assert.deepEqual(fxPairs(quotes, [], "AUD"), ["USDAUD=X"]);
});
