import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yahoo from "../lib/providers/yahoo.mjs";
import { ProviderError } from "../lib/types.mjs";

const fixture = (n) => readFileSync(new URL(`./fixtures/yahoo/${n}`, import.meta.url), "utf8");
const byAsset = (list) => Object.fromEntries(list.map((x) => [x.asset, x]));
const syms = (n) => Array.from({ length: n }, (_, i) => "S" + i);
const kindOf = () => undefined;

const quotesReq = yahoo.quoteRequests(["AAPL", "VOO", "VTSAX", "USDAUD=X"])[0];
const unknownReq = yahoo.quoteRequests(["NOTAREALTICKERX"])[0];
const historyReq1M = yahoo.historyRequests(["AAPL", "VOO", "VTSAX", "USDAUD=X"], "1M", kindOf)[0];
const historyReq1W = yahoo.historyRequests(["AAPL", "VOO", "VTSAX", "USDAUD=X"], "1W", kindOf)[0];
const searchReq = yahoo.searchRequest("vanguard total");

/** Builds a minimal spark body for one symbol. */
const spark = (meta, close = [1, 2], timestamp = [100, 200]) =>
  JSON.stringify({ spark: { result: [{ symbol: meta.symbol ?? "X", response: [{ meta, timestamp, indicators: { quote: [{ close }] } }] }], error: null } });
const baseMeta = { symbol: "X", currency: "USD", instrumentType: "EQUITY", regularMarketPrice: 10, chartPreviousClose: 9, regularMarketTime: 1000 };

test("quotes: batches at the 20-symbol boundary", () => {
  assert.equal(yahoo.quoteRequests(syms(0)).length, 0);
  assert.equal(yahoo.quoteRequests(syms(1)).length, 1);
  assert.equal(yahoo.quoteRequests(syms(20)).length, 1);
  assert.equal(yahoo.quoteRequests(syms(21)).length, 2);
  assert.equal(yahoo.quoteRequests(syms(25)).length, 2);
  assert.equal(yahoo.quoteRequests(syms(40)).length, 2);
  assert.equal(yahoo.quoteRequests(syms(41)).length, 3);
  assert.deepEqual(yahoo.quoteRequests(syms(21))[1].assets, ["S20"]);
});

test("quote request url encodes symbols and uses 1d/5m", () => {
  assert.equal(quotesReq.provider, "yahoo");
  assert.equal(quotesReq.type, "quotes");
  assert.match(quotesReq.url, /symbols=AAPL,VOO,VTSAX,USDAUD%3DX&range=1d&interval=5m$/);
});

test("history request ranges", () => {
  const url = (r) => yahoo.historyRequests(["A"], r, kindOf)[0].url;
  assert.match(url("1D"), /range=1d&interval=5m/);
  assert.match(url("1W"), /range=5d&interval=1h/);
  assert.match(url("1M"), /range=1mo&interval=1d/);
  assert.match(url("3M"), /range=3mo&interval=1d/);
  assert.match(url("6M"), /range=6mo&interval=1d/);
  assert.match(url("1Y"), /range=1y&interval=1d/);
  assert.equal(yahoo.historyRequests(["A"], "1W", kindOf)[0].range, "1W");
  assert.equal(yahoo.historyRequests(["A"], "1M", kindOf)[0].type, "history");
});

test("history batches at the 20-symbol boundary", () => {
  assert.equal(yahoo.historyRequests(syms(20), "1M", kindOf).length, 1);
  assert.equal(yahoo.historyRequests(syms(21), "1M", kindOf).length, 2);
});

test("1D history splits funds into a daily request", () => {
  const reqs = yahoo.historyRequests(["VOO", "VTSAX"], "1D", (a) => (a === "VTSAX" ? "fund" : "etf"));
  assert.equal(reqs.length, 2);
  assert.match(reqs.find((r) => r.assets.includes("VTSAX")).url, /range=5d&interval=1d/);
  assert.match(reqs.find((r) => r.assets.includes("VOO")).url, /range=1d&interval=5m/);
  assert.ok(reqs.every((r) => r.range === "1D"));
});

test("1D history: no funds or only funds gives one request; fund batching is separate", () => {
  assert.equal(yahoo.historyRequests(["VOO"], "1D", () => "etf").length, 1);
  assert.equal(yahoo.historyRequests(["VTSAX"], "1D", () => "fund").length, 1);
  assert.equal(yahoo.historyRequests(syms(21), "1D", () => "fund").length, 2);
  assert.equal(yahoo.historyRequests(["VTSAX"], "1M", () => "fund")[0].url.includes("range=1mo&interval=1d"), true);
});

test("search request encodes the query", () => {
  assert.equal(searchReq.type, "search");
  assert.match(searchReq.url, /\/v1\/finance\/search\?q=vanguard%20total&quotesCount=8&newsCount=0$/);
  assert.match(yahoo.searchRequest("a&b=c").url, /q=a%26b%3Dc&/);
});

test("parses stock, ETF, fund and FX quotes with sessions", () => {
  const q = byAsset(yahoo.parse(quotesReq, 200, fixture("spark-quotes.json")));
  assert.equal(q.AAPL.kind, "stock");
  assert.equal(q.VOO.kind, "etf");
  assert.equal(q.VTSAX.kind, "fund");
  assert.equal(q["USDAUD=X"].kind, "fx");
  assert.equal(q.AAPL.currency, "USD");
  assert.equal(q["USDAUD=X"].currency, "AUD");
  assert.ok(q.AAPL.session.end > q.AAPL.session.start);
  assert.equal(q.AAPL.session.timezone, "America/New_York");
  assert.equal(q.AAPL.provider, "yahoo");
  assert.equal(q.AAPL.name, "Apple Inc.");
  assert.equal(q.AAPL.price, 336.64);
  assert.equal(q.AAPL.asOf, 1791576000 * 1000);
  assert.equal(q.AAPL.session.start, 1791552600 * 1000);
});

test("fund previous close comes from chartPreviousClose", () => {
  const q = byAsset(yahoo.parse(quotesReq, 200, fixture("spark-quotes.json")));
  assert.equal(typeof q.VTSAX.previousClose, "number");
  assert.equal(q.VTSAX.previousClose, 184.76999);
  assert.equal(q.AAPL.previousClose, 340.42);
});

test("all-unknown 404 is an empty result, not an error", () => {
  assert.equal(readFileSync(new URL("./fixtures/yahoo/spark-404.status", import.meta.url), "utf8").trim(), "404");
  assert.deepEqual(yahoo.parse(unknownReq, 404, fixture("spark-404.json")), []);
  assert.deepEqual(yahoo.parse(historyReq1M, 404, fixture("spark-404.json")), []);
});

test("a 404 without Yahoo's Not Found body is a provider failure", () => {
  const html = "<!doctype html><html><body>404 Not Found</body></html>";
  assert.throws(() => yahoo.parse(quotesReq, 404, html), ProviderError);
  assert.throws(() => yahoo.parse(historyReq1M, 404, html), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 404, ""), ProviderError);
  // JSON, but not the unknown-symbols error.
  assert.throws(() => yahoo.parse(quotesReq, 404, "{}"), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 404, '{"spark":{"result":null,"error":{"code":"Bad Request"}}}'), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 404, '{"finance":{"error":{"code":"Not Found"}}}'), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 404, "null"), ProviderError);
  // The Not Found body only counts with a 404.
  assert.throws(() => yahoo.parse(quotesReq, 403, fixture("spark-404.json")), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 200, fixture("spark-404.json")), ProviderError);
});

test("status boundaries: 404 on search and other non-200 throw", () => {
  assert.throws(() => yahoo.parse(searchReq, 404, "{}"), ProviderError);
  for (const s of [199, 201, 403, 429, 500]) assert.throws(() => yahoo.parse(quotesReq, s, fixture("spark-quotes.json")), ProviderError);
  assert.doesNotThrow(() => yahoo.parse(quotesReq, 200, fixture("spark-quotes.json")));
});

test("a symbol missing from the result is simply absent", () => {
  const body = JSON.parse(fixture("spark-quotes.json"));
  body.spark.result = body.spark.result.filter((r) => r.symbol !== "VOO");
  const q = yahoo.parse(quotesReq, 200, JSON.stringify(body));
  assert.deepEqual(q.map((x) => x.asset).sort(), ["AAPL", "USDAUD=X", "VTSAX"]);
});

test("a symbol with a null price is omitted, not returned as NaN", () => {
  const body = JSON.parse(fixture("spark-quotes.json"));
  body.spark.result.find((r) => r.symbol === "AAPL").response[0].meta.regularMarketPrice = null;
  const q = yahoo.parse(quotesReq, 200, JSON.stringify(body));
  assert.ok(!q.some((x) => x.asset === "AAPL"));
  assert.equal(q.length, 3);
});

test("unknown instrument types are omitted from quotes", () => {
  assert.deepEqual(yahoo.parse(quotesReq, 200, spark({ ...baseMeta, instrumentType: "FUTURE" })), []);
});

test("minor-unit currencies are scaled to major units", () => {
  for (const [minor, major] of [["GBp", "GBP"], ["GBX", "GBP"], ["ZAc", "ZAR"]]) {
    const [q] = yahoo.parse(quotesReq, 200, spark({ ...baseMeta, currency: minor, regularMarketPrice: 250, chartPreviousClose: 200 }));
    assert.equal(q.currency, major);
    assert.equal(q.price, 2.5);
    assert.equal(q.previousClose, 2);
  }
  const [gbp] = yahoo.parse(quotesReq, 200, spark({ ...baseMeta, currency: "GBP", regularMarketPrice: 250, chartPreviousClose: 200 }));
  assert.equal(gbp.price, 250);
  const [s] = yahoo.parse(historyReq1M, 200, spark({ ...baseMeta, currency: "GBp" }, [150, 250]));
  assert.equal(s.currency, "GBP");
  assert.deepEqual(s.points, [[100000, 1.5], [200000, 2.5]]);
});

test("missing session fields give a null session", () => {
  const [q] = yahoo.parse(quotesReq, 200, spark(baseMeta));
  assert.equal(q.session, null);
});

test("malformed body throws ProviderError", () => {
  assert.throws(() => yahoo.parse(quotesReq, 200, "<html>"), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 500, "{}"), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 200, "{}"), ProviderError);
  assert.throws(() => yahoo.parse(quotesReq, 200, JSON.stringify({ spark: { result: null, error: { code: "x" } } })), ProviderError);
  assert.throws(() => yahoo.parse(searchReq, 200, "{}"), ProviderError);
  assert.throws(() => yahoo.parse(searchReq, 200, "nope"), ProviderError);
});

test("history parses series in ms with finite points", () => {
  const s = byAsset(yahoo.parse(historyReq1M, 200, fixture("spark-1M.json")));
  assert.equal(Object.keys(s).length, 4);
  assert.equal(s.AAPL.currency, "USD");
  assert.ok(s.AAPL.points[0][0] > 1e12);
});

test("history drops null closes", () => {
  const s = yahoo.parse(historyReq1M, 200, fixture("spark-1M.json"));
  for (const series of s) assert.ok(series.points.every(([t, p]) => Number.isFinite(t) && Number.isFinite(p)));
  const fx = yahoo.parse(historyReq1W, 200, fixture("spark-1W.json")).find((x) => x.asset === "USDAUD=X");
  assert.equal(fx.points.length, 118); // recorded fixture has 119 closes, one null
  const [one] = yahoo.parse(historyReq1M, 200, spark(baseMeta, [1, null, 3], [1, 2, 3]));
  assert.deepEqual(one.points, [[1000, 1], [3000, 3]]);
});

test("1W history works on 5d/1h", () => {
  const s = byAsset(yahoo.parse(historyReq1W, 200, fixture("spark-1W.json")));
  assert.equal(s.AAPL.points.length, 36);
});

test("fund 5d/1d history parses", () => {
  const req = yahoo.historyRequests(["VTSAX"], "1D", () => "fund")[0];
  const [s] = yahoo.parse(req, 200, fixture("spark-1D-fund.json"));
  assert.equal(s.asset, "VTSAX");
  assert.equal(s.points.length, 5);
});

test("search maps types", () => {
  const r = yahoo.parse(searchReq, 200, fixture("search.json"));
  assert.ok(r.some((x) => x.kind === "fund" && x.asset === "VTSAX"));
  const vxus = r.find((x) => x.symbol === "VXUS");
  assert.equal(vxus.kind, "etf");
  assert.equal(vxus.exchange, "NASDAQ");
  assert.equal(vxus.name, "Vanguard Total International Stock Index Fund ETF Shares");
});

test("search drops other types and falls back to shortname and exchange", () => {
  const body = JSON.stringify({ quotes: [
    { symbol: "OPT", quoteType: "OPTION", exchDisp: "X" },
    { symbol: "EQ", quoteType: "EQUITY", shortname: "Short", exchange: "NMS" },
  ] });
  assert.deepEqual(yahoo.parse(searchReq, 200, body), [{ asset: "EQ", symbol: "EQ", name: "Short", kind: "stock", exchange: "NMS" }]);
});

test("asOf falls back to the last chart timestamp when regularMarketTime is missing", () => {
  const { regularMarketTime, ...meta } = baseMeta;
  const [q] = yahoo.parse(quotesReq, 200, spark(meta, [1, 2], [100, 200]));
  assert.equal(q.asOf, 200000);
  const [kept] = yahoo.parse(quotesReq, 200, spark(baseMeta, [1, 2], [100, 200]));
  assert.equal(kept.asOf, 1000000);
});

test("a quote with neither regularMarketTime nor timestamps is omitted", () => {
  const { regularMarketTime, ...meta } = baseMeta;
  assert.deepEqual(yahoo.parse(quotesReq, 200, spark(meta, [], [])), []);
  assert.deepEqual(yahoo.parse(quotesReq, 200, spark(meta, null, null)), []);
});

test("day range comes from the session low and high; funds have none", () => {
  const q = byAsset(yahoo.parse(quotesReq, 200, fixture("spark-quotes.json")));
  assert.deepEqual(q.VOO.dayRange, { low: 712.54, high: 716.433 });
  assert.equal("dayRange" in q.VTSAX, false);
});

test("day range needs both ends with low <= high, and is scaled for minor units", () => {
  const parse = (meta) => yahoo.parse(quotesReq, 200, spark(meta))[0];
  assert.deepEqual(parse({ ...baseMeta, regularMarketDayLow: 5, regularMarketDayHigh: 5 }).dayRange, { low: 5, high: 5 });
  assert.equal("dayRange" in parse({ ...baseMeta, regularMarketDayLow: 5.01, regularMarketDayHigh: 5 }), false);
  assert.equal("dayRange" in parse({ ...baseMeta, regularMarketDayLow: 5 }), false);
  assert.equal("dayRange" in parse({ ...baseMeta, regularMarketDayLow: "4", regularMarketDayHigh: 5 }), false);
  assert.deepEqual(parse({ ...baseMeta, currency: "GBp", regularMarketDayLow: 150, regularMarketDayHigh: 250 }).dayRange, { low: 1.5, high: 2.5 });
});

test("session records the exchange's UTC offset when Yahoo gives one", () => {
  const q = byAsset(yahoo.parse(quotesReq, 200, fixture("spark-quotes.json")));
  assert.equal(q.VOO.session.utcOffsetSeconds, -14400);
  assert.equal(q["USDAUD=X"].session.utcOffsetSeconds, 3600);
  const period = { currentTradingPeriod: { regular: { start: 1, end: 2 } }, exchangeTimezoneName: "America/New_York" };
  const without = yahoo.parse(quotesReq, 200, spark({ ...baseMeta, ...period }))[0];
  assert.equal("utcOffsetSeconds" in without.session, false);
  const bad = yahoo.parse(quotesReq, 200, spark({ ...baseMeta, ...period, gmtoffset: "-14400" }))[0];
  assert.equal("utcOffsetSeconds" in bad.session, false);
});
