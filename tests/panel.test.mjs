import { test } from "node:test";
import assert from "node:assert/strict";
import {
  portfolioRows, watchRows, portfolioHero, assetHero, statusLines, historyAssets,
  portfolioSeries, seriesDirection, rangeLine, chartPoints, chartNote,
} from "../lib/panel.mjs";
import { valuePortfolio } from "../lib/portfolio.mjs";
import { holdingKey } from "../lib/holdings.mjs";

const SAT_1400 = new Date(2026, 9, 10, 14, 0).getTime();
const SAT_0700 = new Date(2026, 9, 10, 7, 0).getTime();
const FRI_1600 = new Date(2026, 9, 9, 16, 0).getTime();
const FAIL_1402 = new Date(2026, 9, 10, 14, 2).getTime();
const US = { start: 0, end: 1, timezone: "America/New_York" };
const q = (asset, symbol, name, price, previousClose, currency, kind, provider, extra) =>
  Object.assign({ asset, symbol, name, price, previousClose, currency, kind, asOf: SAT_0700, session: US, provider }, extra);
const healthy = { failures: 0, failingSince: null, lastSuccess: SAT_1400 };
const fresh = { failures: 0, failingSince: null, lastSuccess: null };
const failing = { failures: 2, failingSince: FAIL_1402, lastSuccess: SAT_0700 };

const quotes = {
  VOO: q("VOO", "VOO", "Vanguard S&P 500 ETF", 715.59, 711.28, "USD", "etf", "yahoo", { dayRange: { low: 712.54, high: 716.433 } }),
  VTSAX: q("VTSAX", "VTSAX", "Vanguard Total Stock Mkt", 185.93, 184.77, "USD", "fund", "yahoo", { asOf: SAT_0700 + 3600000 }),
  "crypto:bitcoin": q("crypto:bitcoin", "BTC", "Bitcoin", 78000, 77000, "USD", "crypto", "coingecko", { session: null, asOf: SAT_1400, dayRange: { low: 76500, high: 78200 } }),
  "USDAUD=X": q("USDAUD=X", "USDAUD=X", "USD/AUD", 1.5, 1.5, "AUD", "fx", "yahoo", { session: { start: 0, end: 1, timezone: "Europe/London" } }),
  NVDA: q("NVDA", "NVDA", "NVIDIA Corporation", 190.5, 192, "USD", "stock", "yahoo"),
};
const holdings = [
  { asset: "VOO", quantity: 12, cost: 410.25 },
  { asset: "VTSAX", quantity: 30.512, cost: 98.1 },
  { asset: "crypto:bitcoin", quantity: 0.05, cost: 61000, costCurrency: "AUD" },
];
const closedStates = { VOO: "closed", VTSAX: "closed", "crypto:bitcoin": "live", "USDAUD=X": "closed", NVDA: "closed" };

const make = (over) => {
  const d = Object.assign({
    quotes, states: closedStates, holdings, watch: ["NVDA", "crypto:ethereum"],
    providerHealth: { yahoo: healthy, coingecko: healthy }, baseCurrency: "AUD", nativePrices: true, now: SAT_1400,
  }, over);
  if (!d.portfolio) d.portfolio = valuePortfolio(d.holdings, d.quotes, d.states, d.baseCurrency);
  return d;
};
// The key a Portfolio row carries for its holding (costCurrency undefined: the listing currency).
const position = (asset, costCurrency) => holdingKey({ asset, costCurrency });
const series = (asset, values, currency = "USD", t0 = 0, step = 60000) =>
  ({ asset, currency, points: values.map((v, i) => [t0 + i * step, v]) });

// ---- Rows

test("portfolio rows: label, base-currency value and day move, by value", () => {
  const rows = portfolioRows(make());
  assert.deepEqual(rows.map((r) => r.label), ["VOO", "VTSAX", "₿ BTC"]);
  assert.deepEqual(rows[0], {
    key: position("VOO"), asset: "VOO", label: "VOO", crypto: false, value: "$12,881", change: "▲ 0.6%", direction: "up", tooltip: "",
  });
  assert.equal(rows[2].crypto, true);
  // 0.05 × US$78,000 × 1.5: crypto is valued through the same exchange rate as US stocks.
  assert.equal(rows[2].value, "$5,850");
});

test("portfolio row: stale price and stale exchange rate are explained", () => {
  const rows = portfolioRows(make({ states: Object.assign({}, closedStates, { VOO: "stale", "USDAUD=X": "stale" }) }));
  assert.match(rows[0].tooltip, /^Includes 2 stale prices: VOO as of Sat 07:00, USDAUD=X as of Sat 07:00$/);
  // Crypto is priced in US dollars, so its row depends on the same rate.
  const btc = rows.find((r) => r.asset === "crypto:bitcoin");
  assert.equal(btc.tooltip, "Includes 1 stale price: USDAUD=X as of Sat 07:00");
});

test("portfolio row left out of the total: not found, outage, no rate, still loading", () => {
  const extra = holdings.concat([{ asset: "VOOO", quantity: 1, cost: 1 }]);
  const notFound = portfolioRows(make({ holdings: extra, states: Object.assign({ VOOO: "missing" }, closedStates) })).pop();
  assert.deepEqual([notFound.value, notFound.change, notFound.direction, notFound.tooltip], ["not found", "", "flat", "VOOO not found, not included"]);

  const down = portfolioRows(make({ holdings: extra, states: Object.assign({ VOOO: "missing" }, closedStates), providerHealth: { yahoo: failing, coingecko: healthy } })).pop();
  assert.deepEqual([down.value, down.tooltip], ["—", "Yahoo unavailable since 14:02"]);

  const waiting = portfolioRows(make({ holdings: extra, states: Object.assign({ VOOO: "missing" }, closedStates), providerHealth: { yahoo: fresh, coingecko: healthy } })).pop();
  assert.deepEqual([waiting.value, waiting.tooltip], ["…", ""]);

  const eur = Object.assign({}, quotes, { SAP: q("SAP", "SAP", "SAP SE", 200, 199, "EUR", "stock", "yahoo") });
  const noRate = portfolioRows(make({ quotes: eur, holdings: holdings.concat([{ asset: "SAP", quantity: 1, cost: 1 }]), states: Object.assign({ SAP: "live" }, closedStates) })).pop();
  assert.deepEqual([noRate.label, noRate.value, noRate.tooltip], ["SAP", "—", "SAP has no exchange rate, not included"]);
});

test("watch rows: price in the asset's currency, not found, outage, loading, stale", () => {
  const states = Object.assign({ "crypto:ethereum": "missing" }, closedStates);
  const [nvda, eth] = watchRows(make({ states }));
  assert.deepEqual(nvda, { key: "NVDA", asset: "NVDA", label: "NVDA", crypto: false, value: "US$190.50", change: "▼ 0.8%", direction: "down", tooltip: "" });
  assert.deepEqual([eth.label, eth.crypto, eth.value, eth.change, eth.tooltip], ["ethereum", true, "not found", "", "ethereum not found"]);

  const down = watchRows(make({ states, providerHealth: { yahoo: healthy, coingecko: failing } }))[1];
  assert.deepEqual([down.value, down.tooltip], ["—", "CoinGecko unavailable since 14:02"]);
  const waiting = watchRows(make({ states, providerHealth: { yahoo: healthy, coingecko: fresh } }))[1];
  assert.deepEqual([waiting.value, waiting.tooltip], ["…", ""]);
  const stale = watchRows(make({ states: Object.assign({}, states, { NVDA: "stale" }) }))[0];
  assert.equal(stale.tooltip, "Includes 1 stale price: NVDA as of Sat 07:00");
});

test("watch row day move needs a positive previous close", () => {
  const zero = Object.assign({}, quotes, { NVDA: Object.assign({}, quotes.NVDA, { previousClose: 0 }) });
  assert.equal(watchRows(make({ quotes: zero, watch: ["NVDA"] }))[0].change, "—");
});

test("rows show the move over the picked range, from the series their sparkline draws", () => {
  const byAsset = {
    VOO: series("VOO", [700, 735]),
    VTSAX: series("VTSAX", [200, 190]),
    NVDA: series("NVDA", [150, 190.5]),
  };
  const portfolio = portfolioRows(make(), byAsset, "1M");
  assert.deepEqual(portfolio.map((r) => [r.asset, r.change, r.direction]), [
    ["VOO", "▲ 5.0%", "up"],
    ["VTSAX", "▼ 5.0%", "down"],
    // No series yet: blank, rather than the day move under the range's name.
    ["crypto:bitcoin", "", "flat"],
  ]);
  const watch = watchRows(make({ watch: ["NVDA"] }), byAsset, "1Y");
  assert.deepEqual([watch[0].change, watch[0].direction], ["▲ 27.0%", "up"]);
});

test("rows on 1D keep the quote's day move, whatever the 1D series says", () => {
  const byAsset = { VOO: series("VOO", [100, 200]), NVDA: series("NVDA", [100, 200]) };
  assert.equal(portfolioRows(make(), byAsset, "1D")[0].change, "▲ 0.6%");
  assert.equal(watchRows(make({ watch: ["NVDA"] }), byAsset, "1D")[0].change, "▼ 0.8%");
});

test("a row left out of the total shows no range move either", () => {
  const extra = holdings.concat([{ asset: "VOOO", quantity: 1, cost: 1 }]);
  const row = portfolioRows(make({ holdings: extra, states: Object.assign({ VOOO: "missing" }, closedStates) }),
    { VOOO: series("VOOO", [1, 2]) }, "1W").pop();
  assert.deepEqual([row.change, row.direction], ["", "flat"]);
});

test("empty watchlist gives no rows", () => {
  assert.deepEqual(watchRows(make({ watch: [] })), []);
});

test("watch rows with native prices on: each asset in its own currency, crypto in US dollars", () => {
  const rows = watchRows(make({ watch: ["NVDA", "crypto:bitcoin"] }));
  assert.deepEqual(rows.map((r) => r.value), ["US$190.50", "US$78,000"]);
  // With a US dollar base the same prices carry the base's own prefix.
  assert.deepEqual(watchRows(make({ watch: ["NVDA", "crypto:bitcoin"], baseCurrency: "USD" })).map((r) => r.value), ["$190.50", "$78,000"]);
});

test("watch rows with native prices off: converted to the base, native with prefix when there is no rate", () => {
  const off = watchRows(make({ watch: ["NVDA", "crypto:bitcoin"], nativePrices: false }));
  assert.deepEqual(off.map((r) => r.value), ["$285.75", "$117,000"]);
  // The day move is the quote's own in both modes.
  assert.deepEqual(off.map((r) => r.change), ["▼ 0.8%", "▲ 1.3%"]);
  const noRate = Object.assign({}, quotes);
  delete noRate["USDAUD=X"];
  const fallback = watchRows(make({ quotes: noRate, watch: ["NVDA", "crypto:bitcoin"], nativePrices: false }));
  assert.deepEqual(fallback.map((r) => r.value), ["US$190.50", "US$78,000"]);
  const asx = Object.assign({}, quotes, { VAS: q("VAS", "VAS.AX", "Vanguard Aus", 100.5, 99, "AUD", "etf", "yahoo") });
  assert.equal(watchRows(make({ quotes: asx, watch: ["VAS"], nativePrices: false, states: Object.assign({ VAS: "live" }, closedStates) }))[0].value, "$100.50");
});

test("watchlist hero follows its row: native when on, base when off, the day range in the same currency", () => {
  const on = assetHero("crypto:bitcoin", make(), null);
  assert.deepEqual([on.value, on.change, on.details], ["US$78,000", "▲ 1.3%", [{ label: "Day range · US$", value: "76,500–78,200" }]]);
  const off = assetHero("crypto:bitcoin", make({ nativePrices: false }), null);
  assert.deepEqual([off.value, off.change, off.details], ["$117,000", "▲ 1.3%", [{ label: "Day range", value: "114.8k–117.3k" }]]);
  const noRate = Object.assign({}, quotes);
  delete noRate["USDAUD=X"];
  const fallback = assetHero("crypto:bitcoin", make({ quotes: noRate, nativePrices: false }), null);
  assert.deepEqual([fallback.value, fallback.details[0]], ["US$78,000", { label: "Day range · US$", value: "76,500–78,200" }]);
});

test("position hero keeps its base value and native quantity × price whatever nativePrices says", () => {
  for (const nativePrices of [true, false]) {
    const h = assetHero("crypto:bitcoin", make({ nativePrices }), position("crypto:bitcoin", "AUD"));
    assert.deepEqual([h.value, h.subLabel, h.details[2]], ["$5,850", "0.05 × US$78,000", { label: "Day range · US$", value: "76,500–78,200" }], String(nativePrices));
    assert.equal(portfolioRows(make({ nativePrices }))[2].value, "$5,850");
  }
});

// ---- Heroes

test("portfolio hero: total, day move, unrealised gain", () => {
  const h = portfolioHero(make());
  assert.equal(h.title, "Total value · AUD");
  assert.equal(h.value, "$27,240");
  assert.deepEqual([h.change, h.direction], ["▲ 0.8%", "up"]);
  assert.equal(h.subLabel, "Unrealised");
  assert.equal(h.sub, "+$12,316 · ▲ 82.5%");
  assert.equal(h.subDirection, "up");
  assert.deepEqual([h.details, h.asOf, h.tooltip], [[], "", ""]);
});

test("portfolio hero with nothing valued shows the bar's placeholder and no gain", () => {
  const h = portfolioHero(make({ quotes: {}, states: {}, providerHealth: { yahoo: fresh, coingecko: fresh } }));
  assert.deepEqual([h.value, h.change, h.subLabel, h.sub], ["…", "", "", ""]);
  const empty = portfolioHero(make({ holdings: [] }));
  assert.deepEqual([empty.value, empty.sub], ["—", ""]);
});

test("portfolio hero tooltip is the bar's", () => {
  const h = portfolioHero(make({ states: Object.assign({}, closedStates, { VOO: "stale" }) }));
  assert.equal(h.tooltip, "Includes 1 stale price: VOO as of Sat 07:00");
});

test("position hero: value, quantity × price, gain, avg cost, weight, day range, as of", () => {
  const h = assetHero("VOO", make(), position("VOO"));
  assert.equal(h.title, "VOO · Vanguard S&P 500 ETF");
  assert.equal(h.value, "$12,881");
  assert.deepEqual([h.change, h.direction], ["▲ 0.6%", "up"]);
  assert.equal(h.subLabel, "12 × US$715.59");
  assert.equal(h.sub, "+$5,496 · ▲ 74.4%");
  assert.deepEqual(h.details, [
    { label: "Avg cost", value: "US$410.25" },
    { label: "Weight", value: "47%" },
    { label: "Day range · US$", value: "712.54–716.43" },
  ]);
  assert.equal(h.asOf, "as of 07:00");
  assert.equal(h.tooltip, "");
});

test("position hero: cost currency, weight below 10%, no day range, earlier day", () => {
  const btc = assetHero("crypto:bitcoin", make(), position("crypto:bitcoin", "AUD"));
  assert.equal(btc.details[0].value, "$61,000");
  assert.equal(btc.subLabel, "0.05 × US$78,000");
  assert.equal(btc.value, "$5,850");
  const vtsax = assetHero("VTSAX", make(), position("VTSAX"));
  assert.equal(vtsax.details[2].value, "—");
  const small = make({ holdings: holdings.map((h) => (h.asset === "VTSAX" ? Object.assign({}, h, { quantity: 1 }) : h)) });
  assert.equal(assetHero("VTSAX", small, position("VTSAX")).details[1].value, "1.5%");
  const yesterday = make({ quotes: Object.assign({}, quotes, { VOO: Object.assign({}, quotes.VOO, { asOf: FRI_1600 }) }) });
  assert.equal(assetHero("VOO", yesterday, position("VOO")).asOf, "as of Fri 16:00");
});

test("weight boundary: 9.95% shows one decimal, 10% and up are whole", () => {
  const view = (weight) => {
    const d = make();
    d.portfolio = Object.assign({}, d.portfolio, {
      positions: d.portfolio.positions.map((p) => (p.asset === "VOO" ? Object.assign({}, p, { weight }) : p)),
    });
    return assetHero("VOO", d, position("VOO")).details[1].value;
  };
  assert.equal(view(9.94), "9.9%");
  assert.equal(view(10), "10%");
  assert.equal(view(null), "—");
});

test("position hero for a holding left out of the total", () => {
  const extra = holdings.concat([{ asset: "VOOO", quantity: 1, cost: 1 }]);
  const h = assetHero("VOOO", make({ holdings: extra, states: Object.assign({ VOOO: "missing" }, closedStates) }), position("VOOO"));
  assert.deepEqual([h.title, h.value, h.change, h.subLabel, h.sub, h.asOf], ["VOOO", "not found", "", "", "", ""]);
  assert.deepEqual(h.details.map((d) => d.value), ["—", "—", "—"]);
  assert.equal(h.tooltip, "VOOO not found, not included");
});

test("watchlist hero has no holding stats, even for an asset that is held", () => {
  const h = assetHero("VOO", make(), null);
  assert.equal(h.value, "US$715.59");
  assert.deepEqual([h.change, h.subLabel, h.sub], ["▲ 0.6%", "", ""]);
  assert.deepEqual(h.details, [{ label: "Day range · US$", value: "712.54–716.43" }]);
  assert.equal(h.asOf, "as of 07:00");
  const nvda = assetHero("NVDA", make(), null);
  assert.equal(nvda.title, "NVDA · NVIDIA Corporation");
});

test("title is just the symbol when the name adds nothing", () => {
  const plain = Object.assign({}, quotes, { NVDA: Object.assign({}, quotes.NVDA, { name: "NVDA" }) });
  assert.equal(assetHero("NVDA", make({ quotes: plain }), null).title, "NVDA");
});

// ---- Status line

test("status: every stock quote closed gives the US closed line with the latest quote's weekday", () => {
  assert.deepEqual(statusLines(["VOO", "VTSAX", "crypto:bitcoin", "USDAUD=X"], make()), ["󰒲 US market closed · last close Sat"]);
  const friday = Object.assign({}, quotes, {
    VOO: Object.assign({}, quotes.VOO, { asOf: FRI_1600 }), VTSAX: Object.assign({}, quotes.VTSAX, { asOf: FRI_1600 - 1 }),
  });
  assert.deepEqual(statusLines(["VOO", "VTSAX"], make({ quotes: friday })), ["󰒲 US market closed · last close Fri"]);
});

test("status: one open stock quote, or no stock quotes, gives no line; FX does not count", () => {
  assert.deepEqual(statusLines(["VOO", "VTSAX"], make({ states: Object.assign({}, closedStates, { VTSAX: "live" }) })), []);
  assert.deepEqual(statusLines(["VOO"], make({ states: Object.assign({}, closedStates, { VOO: "stale" }) })), []);
  assert.deepEqual(statusLines(["crypto:bitcoin"], make()), []);
  assert.deepEqual(statusLines([], make()), []);
  assert.deepEqual(statusLines(["VOO", "USDAUD=X"], make({ states: Object.assign({}, closedStates, { "USDAUD=X": "live" }) })), ["󰒲 US market closed · last close Sat"]);
});

test("status: a closed market outside the US is not called US", () => {
  const asx = Object.assign({}, quotes, { VAS: q("VAS.AX", "VAS.AX", "Vanguard Aus", 100, 99, "AUD", "etf", "yahoo", { asset: "VAS", session: { start: 0, end: 1, timezone: "Australia/Sydney" } }) });
  assert.deepEqual(statusLines(["VOO", "VAS"], make({ quotes: asx, states: Object.assign({ VAS: "closed" }, closedStates) })), ["󰒲 Markets closed · last close Sat"]);
});

test("status: provider outages, with the outage replacing the closed line", () => {
  assert.deepEqual(statusLines(["VOO"], make({ providerHealth: { yahoo: failing, coingecko: healthy } })), ["Stock prices unavailable since 14:02 (Yahoo)"]);
  assert.deepEqual(statusLines(["VOO"], make({ providerHealth: { yahoo: healthy, coingecko: failing } })),
    ["󰒲 US market closed · last close Sat", "Crypto prices unavailable since 14:02 (CoinGecko)"]);
  const sinceFriday = { failures: 9, failingSince: FRI_1600, lastSuccess: null };
  assert.deepEqual(statusLines([], make({ providerHealth: { yahoo: sinceFriday, coingecko: sinceFriday } })),
    ["Stock prices unavailable since Fri 16:00 (Yahoo)", "Crypto prices unavailable since Fri 16:00 (CoinGecko)"]);
});

// ---- History and charts

test("history assets: holdings, exchange rates, watchlist, each once", () => {
  assert.deepEqual(historyAssets(make({ watch: ["NVDA", "VOO"] }), ["USDAUD=X"]), ["VOO", "VTSAX", "crypto:bitcoin", "USDAUD=X", "NVDA"]);
});

test("portfolio series waits for every valued holding, ignores excluded ones", () => {
  const d = make({ holdings: holdings.concat([{ asset: "VOOO", quantity: 1, cost: 1 }]), states: Object.assign({ VOOO: "missing" }, closedStates) });
  const all = {
    VOO: series("VOO", [700, 710], "USD", 0, 86400000),
    VTSAX: series("VTSAX", [180, 185], "USD", 0, 86400000),
    "crypto:bitcoin": series("crypto:bitcoin", [70000, 75000], "USD", 0, 86400000),
  };
  const s = portfolioSeries(d, all, "1M");
  assert.equal(s.points.length, 2);
  assert.ok(Math.abs(s.points[0][1] - (12 * 700 * 1.5 + 30.512 * 180 * 1.5 + 0.05 * 70000 * 1.5)) < 1e-6);
  const partial = Object.assign({}, all);
  delete partial.VTSAX;
  assert.equal(portfolioSeries(d, partial, "1M"), null);
  assert.equal(portfolioSeries(d, Object.assign({}, all, { VTSAX: series("VTSAX", []) }), "1M"), null);
  // One point is not history yet (the same threshold chartNote uses); two are.
  assert.equal(portfolioSeries(d, Object.assign({}, all, { VTSAX: series("VTSAX", [185]) }), "1M"), null);
  assert.notEqual(portfolioSeries(d, Object.assign({}, all, { VTSAX: series("VTSAX", [180, 185], "USD", 0, 86400000) }), "1M"), null);
  assert.equal(portfolioSeries(make({ holdings: [] }), all, "1M"), null);
});

test("series direction: up, down, level, too short", () => {
  assert.equal(seriesDirection(series("X", [1, 2])), "up");
  assert.equal(seriesDirection(series("X", [2, 1])), "down");
  assert.equal(seriesDirection(series("X", [2, 3, 2])), "flat");
  assert.equal(seriesDirection(series("X", [2])), "flat");
  assert.equal(seriesDirection(null), "flat");
});

test("range line: move over the range, empty without a usable series", () => {
  assert.deepEqual(rangeLine(series("X", [100, 107.9]), "1M"), { text: "▲ 7.9% over 1M", direction: "up" });
  assert.deepEqual(rangeLine(series("X", [100, 99]), "1D"), { text: "▼ 1.0% over 1D", direction: "down" });
  assert.deepEqual(rangeLine(series("X", [100, 100]), "1W"), { text: "— 0.0% over 1W", direction: "flat" });
  assert.deepEqual(rangeLine(series("X", [0, 1]), "1Y"), { text: "", direction: "flat" });
  assert.deepEqual(rangeLine(series("X", [1]), "1Y"), { text: "", direction: "flat" });
  assert.deepEqual(rangeLine(null, "1Y"), { text: "", direction: "flat" });
});

test("chart points span the box, low at the bottom, high at the top", () => {
  assert.deepEqual(chartPoints([[0, 10], [5, 20], [9, 15]], 100, 50, 2), [[0, 48], [50, 2], [100, 25]]);
});

test("chart points: level series is a middle line; fewer than two points or no box is nothing", () => {
  assert.deepEqual(chartPoints([[0, 5], [1, 5]], 10, 20, 2), [[0, 10], [10, 10]]);
  assert.deepEqual(chartPoints([[0, 5]], 10, 20, 2), []);
  assert.deepEqual(chartPoints([], 10, 20, 2), []);
  assert.deepEqual(chartPoints([[0, 5], [1, 6]], 0, 20, 2), []);
  assert.deepEqual(chartPoints([[0, 5], [1, 6]], 10, 0, 2), []);
});

test("status: last close is the exchange's weekday when the quote carries its offset", () => {
  // Friday 16:00 New York = Saturday 07:00 in Sydney; the line must say Friday anywhere.
  const fridayClose = Date.UTC(2026, 9, 9, 20, 0);
  const ny = { start: 0, end: 1, timezone: "America/New_York", utcOffsetSeconds: -14400 };
  const withOffset = Object.assign({}, quotes, {
    VOO: Object.assign({}, quotes.VOO, { asOf: fridayClose, session: ny }),
    VTSAX: Object.assign({}, quotes.VTSAX, { asOf: fridayClose - 60000, session: Object.assign({}, ny, { utcOffsetSeconds: 39600 }) }),
  });
  // The latest quote (VOO) decides, with its own offset.
  assert.deepEqual(statusLines(["VOO", "VTSAX"], make({ quotes: withOffset })), ["󰒲 US market closed · last close Fri"]);
});

test("series direction follows the displayed percentage: 0.04% is flat, 0.06% is not", () => {
  assert.equal(seriesDirection(series("X", [100, 100.04])), "flat");
  assert.equal(seriesDirection(series("X", [100, 100.06])), "up");
  assert.equal(seriesDirection(series("X", [100, 99.94])), "down");
  assert.equal(seriesDirection(series("X", [0, 1])), "flat");
});

test("chart note names the failing provider whose history is missing", () => {
  const voo = { VOO: series("VOO", [1, 2]), VTSAX: series("VTSAX", [1, 2]) };
  const cgDown = { yahoo: healthy, coingecko: failing };
  assert.equal(chartNote(make(), {}, ""), "No history yet");
  assert.equal(chartNote(make({ providerHealth: cgDown }), voo, ""), "History unavailable (CoinGecko)");
  // The failing provider's assets all have history: nothing to blame.
  assert.equal(chartNote(make({ providerHealth: cgDown }), { "crypto:bitcoin": series("b", [1, 2]) }, ""), "No history yet");
  assert.equal(chartNote(make({ providerHealth: { yahoo: failing, coingecko: failing } }), {}, ""), "History unavailable (Yahoo, CoinGecko)");
  // A one-point series is no history either.
  assert.equal(chartNote(make({ providerHealth: cgDown }), Object.assign({ "crypto:bitcoin": series("b", [1]) }, voo), ""), "History unavailable (CoinGecko)");
  // The position view only needs its own asset.
  assert.equal(chartNote(make({ providerHealth: cgDown }), {}, "VOO"), "No history yet");
  assert.equal(chartNote(make({ providerHealth: cgDown }), {}, "crypto:bitcoin"), "History unavailable (CoinGecko)");
});

// ---- One asset held in two cost currencies

const twoAapl = (withEurRate) => {
  const aapl = q("AAPL", "AAPL", "Apple Inc.", 100, 100, "USD", "stock", "yahoo");
  const eurusd = q("EURUSD=X", "EURUSD=X", "EUR/USD", 2, 2, "USD", "fx", "yahoo");
  const quotes2 = withEurRate ? { AAPL: aapl, "EURUSD=X": eurusd } : { AAPL: aapl };
  return make({
    quotes: quotes2,
    states: { AAPL: "live", "EURUSD=X": "live" },
    holdings: [{ asset: "AAPL", quantity: 1, cost: 50 }, { asset: "AAPL", quantity: 10, cost: 20, costCurrency: "EUR" }],
    watch: [],
    baseCurrency: "USD",
  });
};

test("each holding of one asset is its own row, and its hero shows that holding's cost", () => {
  const d = twoAapl(true);
  const rows = portfolioRows(d);
  // Sorted by value, so the EUR-cost holding (USD 1,000) comes before the file's first entry (USD 100).
  assert.deepEqual(rows.map((r) => [r.key, r.value]), [[position("AAPL", "EUR"), "$1,000"], [position("AAPL"), "$100"]]);
  const eur = assetHero("AAPL", d, rows[0].key);
  assert.deepEqual([eur.value, eur.subLabel, eur.sub, eur.details[0]],
    ["$1,000", "10 × $100.00", "+$600 · ▲ 150.0%", { label: "Avg cost", value: "€20.00" }]);
  const usd = assetHero("AAPL", d, rows[1].key);
  assert.deepEqual([usd.value, usd.subLabel, usd.sub, usd.details[0]],
    ["$100", "1 × $100.00", "+$50 · ▲ 100.0%", { label: "Avg cost", value: "$50.00" }]);
});

test("a holding left out of the total stays out of the chart when another holding of its asset is valued", () => {
  const d = twoAapl(false);
  assert.equal(d.portfolio.total, 100);
  const s = portfolioSeries(d, { AAPL: series("AAPL", [100, 100], "USD", 0, 86400000) }, "1M");
  assert.deepEqual(s.points.map((p) => p[1]), [100, 100]);
  // With the rate both are valued and both are charted.
  const both = portfolioSeries(twoAapl(true), { AAPL: series("AAPL", [100, 100], "USD", 0, 86400000) }, "1M");
  assert.deepEqual(both.points.map((p) => p[1]), [1100, 1100]);
});

test("a watched price converted at a stale rate warns on its row and hero; shown as quoted it does not", () => {
  const states = Object.assign({}, closedStates, { NVDA: "live", "USDAUD=X": "stale" });
  const off = make({ states, watch: ["NVDA"], nativePrices: false });
  assert.equal(watchRows(off)[0].tooltip, "Includes 1 stale price: USDAUD=X as of Sat 07:00");
  assert.equal(assetHero("NVDA", off, null).tooltip, "Includes 1 stale price: USDAUD=X as of Sat 07:00");
  const on = make({ states, watch: ["NVDA"] });
  assert.equal(watchRows(on)[0].tooltip, "");
  assert.equal(assetHero("NVDA", on, null).tooltip, "");
});

test("a position valued with a stale cost-currency rate says so on its row and hero", () => {
  const d = twoAapl(true);
  const staleEur = make({ quotes: d.quotes, holdings: d.holdings, watch: [], baseCurrency: "USD", states: { AAPL: "live", "EURUSD=X": "stale" } });
  const [eurRow, usdRow] = portfolioRows(staleEur);
  assert.equal(eurRow.tooltip, "Includes 1 stale price: EURUSD=X as of Sat 07:00");
  assert.equal(assetHero("AAPL", staleEur, eurRow.key).tooltip, "Includes 1 stale price: EURUSD=X as of Sat 07:00");
  // The USD-cost holding does not use that rate.
  assert.equal(usdRow.tooltip, "");
});
