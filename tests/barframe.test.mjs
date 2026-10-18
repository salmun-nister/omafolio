import { test } from "node:test";
import assert from "node:assert/strict";
import { barFrame, displayPrice, shortName } from "../lib/barframe.mjs";

const FRI_1600 = new Date(2026, 9, 9, 16, 0).getTime();
const FAIL_1402 = new Date(2026, 9, 9, 14, 2).getTime();
const q = (asset, symbol, price, previousClose, provider, extra) =>
  Object.assign({ asset, symbol, name: symbol, price, previousClose, currency: "USD", kind: "etf", asOf: FRI_1600, session: null, provider }, extra);
const healthy = { failures: 0, failingSince: null, lastSuccess: FRI_1600 };
const fresh = { failures: 0, failingSince: null, lastSuccess: null };
const quotes = {
  VOO: q("VOO", "VOO", 715.59, 711.28, "yahoo"),
  VTSAX: q("VTSAX", "VTSAX", 185.93, 185.93, "yahoo"),
  "crypto:bitcoin": q("crypto:bitcoin", "BTC", 118066, 116430, "coingecko"),
};
const view = (over) => Object.assign({
  total: 412300, dayChange: 3000, dayChangePct: 0.8, gain: 0, gainPct: 0, stale: [], excluded: [],
  positions: [{ asset: "VOO", value: 100, state: "closed" }, { asset: "VTSAX", value: 100, state: "closed" }],
}, over);
const data = (over) => Object.assign({
  quotes, states: { VOO: "live", VTSAX: "live", "crypto:bitcoin": "live" },
  portfolio: view(), providerHealth: { yahoo: healthy, coingecko: healthy },
  baseCurrency: "USD", nativePrices: true,
}, over);

test("asset frame: label, value, change", () => {
  const f = barFrame("crypto:bitcoin", data());
  assert.deepEqual([f.label, f.value, f.change, f.state, f.warn, f.tooltip], ["₿", "118,066", "▲ 1.4%", "live", false, ""]);
  assert.equal(barFrame("VOO", data()).label, "VOO");
});

test("closed asset keeps its numbers and state", () => {
  const f = barFrame("VOO", data({ states: { VOO: "closed" } }));
  assert.deepEqual([f.value, f.state, f.warn], ["715.59", "closed", false]);
});

test("stale asset: warning and tooltip, with and without a failing provider", () => {
  const failing = { failures: 3, failingSince: FAIL_1402, lastSuccess: null };
  const f = barFrame("VOO", data({ states: { VOO: "stale" }, providerHealth: { yahoo: failing, coingecko: healthy } }));
  assert.equal(f.state, "stale");
  assert.equal(f.warn, true);
  assert.equal(f.tooltip, "Includes 1 stale price: VOO as of Fri 16:00 (Yahoo unavailable since 14:02)");
  const cached = barFrame("VOO", data({ states: { VOO: "stale" } }));
  assert.equal(cached.tooltip, "Includes 1 stale price: VOO as of Fri 16:00");
});

test("missing asset: dash and not-found tooltip; still loading shows no complaint", () => {
  const f = barFrame("VOOO", data({ states: { VOOO: "missing" } }));
  assert.deepEqual([f.label, f.value, f.change, f.state, f.tooltip], ["VOOO", "—", "", "missing", "VOOO not found, not included"]);
  const loading = barFrame("VOOO", data({ providerHealth: { yahoo: fresh, coingecko: healthy } }));
  assert.deepEqual([loading.value, loading.tooltip], ["…", ""]);
});

test("missing asset whose provider's first attempt failed: dash and the outage, not 'not found'", () => {
  const failed = { failures: 1, failingSince: FAIL_1402, lastSuccess: null };
  const f = barFrame("VOOO", data({ states: { VOOO: "missing" }, providerHealth: { yahoo: failed, coingecko: healthy } }));
  assert.deepEqual([f.value, f.tooltip], ["—", "Yahoo unavailable since 14:02"]);
  // The other provider's attempt state does not matter.
  const other = barFrame("VOOO", data({ states: { VOOO: "missing" }, providerHealth: { yahoo: healthy, coingecko: failed } }));
  assert.equal(other.tooltip, "VOOO not found, not included");
  const crypto = barFrame("crypto:nope", data({ states: { "crypto:nope": "missing" }, providerHealth: { yahoo: healthy, coingecko: fresh } }));
  assert.equal(crypto.value, "…");
});

test("direction follows the arrow; flat moves and missing prices are flat", () => {
  assert.equal(barFrame("crypto:bitcoin", data()).direction, "up");
  const down = barFrame("VOO", data({ quotes: { VOO: q("VOO", "VOO", 700, 711, "yahoo") }, states: { VOO: "live" } }));
  assert.deepEqual([down.direction, down.change], ["down", "▼ 1.5%"]);
  assert.equal(barFrame("VTSAX", data()).direction, "flat");
  assert.equal(barFrame("VOOO", data({ states: { VOOO: "missing" } })).direction, "flat");
  assert.equal(barFrame("portfolio", data()).direction, "up");
  assert.equal(barFrame("portfolio", data({ portfolio: view({ dayChangePct: -0.8 }) })).direction, "down");
  assert.equal(barFrame("portfolio", data({ portfolio: view({ dayChangePct: 0.04 }) })).direction, "flat");
});

test("portfolio excluded because its provider is down names the outage", () => {
  const failed = { failures: 2, failingSince: FAIL_1402, lastSuccess: null };
  const f = barFrame("portfolio", data({ portfolio: view({ excluded: ["VOOO"] }), states: { VOOO: "missing" }, providerHealth: { yahoo: failed, coingecko: healthy } }));
  assert.equal(f.tooltip, "Yahoo unavailable since 14:02");
});

test("a zero previous close gives no change figure", () => {
  const f = barFrame("VOO", data({ quotes: { VOO: q("VOO", "VOO", 10, 0, "yahoo") }, states: { VOO: "live" } }));
  assert.equal(f.change, "—");
});

test("portfolio: closed only when every valued position is closed", () => {
  assert.equal(barFrame("portfolio", data()).state, "closed");
  const mixed = view({ positions: [{ asset: "VOO", value: 1, state: "closed" }, { asset: "crypto:bitcoin", value: 1, state: "live" }] });
  assert.equal(barFrame("portfolio", data({ portfolio: mixed })).state, "live");
  const excludedOnly = view({ positions: [{ asset: "VOO", value: 1, state: "closed" }, { asset: "X", value: null, state: "missing" }] });
  assert.equal(barFrame("portfolio", data({ portfolio: excludedOnly })).state, "closed");
});

test("portfolio: value, change, glyph", () => {
  const f = barFrame("portfolio", data());
  assert.deepEqual([f.label, f.value, f.change], ["󰄨", "412,300", "▲ 0.8%"]);
});

test("portfolio: stale prices pluralise and list assets", () => {
  const one = barFrame("portfolio", data({ portfolio: view({ stale: ["VOO"] }), states: { VOO: "stale" } }));
  assert.equal(one.warn, true);
  assert.match(one.tooltip, /^Includes 1 stale price: VOO as of Fri 16:00$/);
  const two = barFrame("portfolio", data({ portfolio: view({ stale: ["VOO", "VTSAX"] }) }));
  assert.match(two.tooltip, /^Includes 2 stale prices: VOO as of Fri 16:00, VTSAX as of Fri 16:00$/);
  assert.equal(barFrame("portfolio", data()).warn, false);
});

test("portfolio: excluded assets are named", () => {
  const f = barFrame("portfolio", data({ portfolio: view({ excluded: ["VOOO", "crypto:nope"] }), states: { VOOO: "missing", "crypto:nope": "missing" } }));
  assert.equal(f.warn, true);
  assert.equal(f.tooltip, "VOOO, nope not found, not included");
  const rate = barFrame("portfolio", data({ portfolio: view({ excluded: ["VOO"] }), states: { VOO: "live" } }));
  assert.equal(rate.tooltip, "VOO has no exchange rate, not included");
});

test("portfolio with nothing valued: dash once every provider has been tried, ellipsis before", () => {
  const empty = view({ total: 0, dayChangePct: null, positions: [{ asset: "VOO", value: null, state: "missing" }] });
  assert.equal(barFrame("portfolio", data({ portfolio: empty })).value, "—");
  assert.equal(barFrame("portfolio", data({ portfolio: empty, providerHealth: { yahoo: fresh, coingecko: healthy } })).value, "…");
  assert.equal(barFrame("portfolio", data({ portfolio: view({ positions: [] }), providerHealth: { yahoo: fresh, coingecko: fresh } })).value, "—");
});

// ---- Which currency an asset's price is shown in

const usdaud = { "USDAUD=X": q("USDAUD=X", "USDAUD=X", 1.5, 1.5, "yahoo", { currency: "AUD", kind: "fx" }) };

test("displayPrice with native prices on: the price in its own currency, FX or not", () => {
  assert.deepEqual(displayPrice(82699, "USD", "AUD", usdaud, true), { amount: 82699, currency: "USD", via: null });
  assert.deepEqual(displayPrice(82699, "USD", "AUD", {}, true), { amount: 82699, currency: "USD", via: null });
  assert.deepEqual(displayPrice(82699, "USD", "USD", {}, true), { amount: 82699, currency: "USD", via: null });
});

test("displayPrice with native prices off: converted to the base currency at the current rate", () => {
  assert.deepEqual(displayPrice(100, "USD", "AUD", usdaud, false), { amount: 150, currency: "AUD", via: "USDAUD=X" });
  // Already in the base currency: unchanged, no rate needed.
  assert.deepEqual(displayPrice(100, "AUD", "AUD", {}, false), { amount: 100, currency: "AUD", via: null });
});

test("displayPrice with native prices off and no rate falls back to the native price", () => {
  assert.deepEqual(displayPrice(100, "USD", "AUD", {}, false), { amount: 100, currency: "USD", via: null });
  // A rate for another pair does not help.
  assert.deepEqual(displayPrice(100, "EUR", "AUD", usdaud, false), { amount: 100, currency: "EUR", via: null });
});

test("bar asset frame, native prices on: own currency with its prefix when it is not the base", () => {
  const btc = barFrame("crypto:bitcoin", data({ baseCurrency: "AUD", quotes: Object.assign({}, quotes, usdaud) }));
  assert.deepEqual([btc.label, btc.value, btc.change], ["₿", "US$118,066", "▲ 1.4%"]);
  assert.equal(barFrame("VOO", data({ baseCurrency: "AUD" })).value, "US$715.59");
  // In the base currency the price is plain.
  assert.equal(barFrame("crypto:bitcoin", data({ baseCurrency: "USD" })).value, "118,066");
});

test("bar asset frame, native prices off: converted to the base and plain; native with prefix without a rate", () => {
  const withRate = data({ baseCurrency: "AUD", nativePrices: false, quotes: Object.assign({}, quotes, usdaud) });
  const btc = barFrame("crypto:bitcoin", withRate);
  // 118066 × 1.5 = 177099; the move is the quote's own.
  assert.deepEqual([btc.value, btc.change, btc.direction], ["177,099", "▲ 1.4%", "up"]);
  assert.equal(barFrame("VOO", withRate).value, "1,073");
  const noRate = data({ baseCurrency: "AUD", nativePrices: false });
  assert.deepEqual([barFrame("crypto:bitcoin", noRate).value, barFrame("crypto:bitcoin", noRate).change], ["US$118,066", "▲ 1.4%"]);
  assert.equal(barFrame("VOO", data({ baseCurrency: "USD", nativePrices: false })).value, "715.59");
});

test("a price converted at a stale rate is stale and names the rate; native prices do not care", () => {
  const failing = { failures: 3, failingSince: FAIL_1402, lastSuccess: null };
  const staleRate = (over) => data(Object.assign({
    baseCurrency: "AUD", nativePrices: false, quotes: Object.assign({}, quotes, usdaud),
    states: { VOO: "live", "crypto:bitcoin": "live", "USDAUD=X": "stale" },
    providerHealth: { yahoo: failing, coingecko: healthy },
  }, over));
  const btc = barFrame("crypto:bitcoin", staleRate());
  assert.deepEqual([btc.value, btc.state, btc.warn], ["177,099", "stale", true]);
  assert.equal(btc.tooltip, "Includes 1 stale price: USDAUD=X as of Fri 16:00 (Yahoo unavailable since 14:02)");
  // Both stale: both named.
  const both = barFrame("VOO", staleRate({ states: { VOO: "stale", "USDAUD=X": "stale" } }));
  assert.deepEqual([both.state, both.tooltip.startsWith("Includes 2 stale prices: VOO as of")], ["stale", true]);
  // A closed asset stays closed but still warns about the rate.
  const closed = barFrame("VOO", staleRate({ states: { VOO: "closed", "USDAUD=X": "stale" } }));
  assert.deepEqual([closed.state, closed.warn], ["closed", true]);
  // Shown as quoted, the rate is not used and does not matter.
  const native = barFrame("crypto:bitcoin", staleRate({ nativePrices: true }));
  assert.deepEqual([native.value, native.state, native.warn, native.tooltip], ["US$118,066", "live", false, ""]);
  // A live rate leaves a live price alone.
  const fine = barFrame("crypto:bitcoin", staleRate({ states: { "crypto:bitcoin": "live", "USDAUD=X": "live" } }));
  assert.deepEqual([fine.state, fine.warn, fine.tooltip], ["live", false, ""]);
});

test("portfolio frame stays plain in the base currency whatever nativePrices says", () => {
  for (const nativePrices of [true, false]) {
    const f = barFrame("portfolio", data({ baseCurrency: "AUD", nativePrices }));
    assert.equal(f.value, "412,300");
  }
});

test("a cash reference is named by its currency", () => {
  assert.equal(shortName("cash:EUR"), "EUR cash");
  assert.equal(shortName("crypto:bitcoin"), "bitcoin");
});

test("portfolio: cash, which never closes, does not keep the frame from showing closed", () => {
  const positions = [
    { asset: "VOO", value: 100, state: "closed" },
    { asset: "cash:AUD", value: 50, state: "live" },
    { asset: "cash:EUR", value: 50, state: "live" },
  ];
  assert.equal(barFrame("portfolio", data({ portfolio: view({ positions }) })).state, "closed");
  // Cash alone is not a market: the frame stays live.
  assert.equal(barFrame("portfolio", data({ portfolio: view({ positions: positions.slice(1) }) })).state, "live");
});
