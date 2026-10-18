import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import coingecko from "../lib/providers/coingecko.mjs";
import { ProviderError } from "../lib/types.mjs";

const fixture = (n) => readFileSync(new URL(`./fixtures/coingecko/${n}`, import.meta.url), "utf8");
const marketsReq = coingecko.quoteRequests(["crypto:bitcoin", "crypto:ethereum", "crypto:notarealcoinx"])[0];
const chartReq = coingecko.historyRequests(["crypto:bitcoin"], "1W")[0];
const searchReq = coingecko.searchRequest("sol");
const fixtureBtc = JSON.parse(fixture("markets.json")).find((c) => c.id === "bitcoin");

/** Builds a markets body with one coin overridden on top of a valid base. */
const market = (over = {}) =>
  JSON.stringify([{ id: "x", symbol: "x", name: "X", current_price: 10, price_change_24h: 1, last_updated: "2026-10-10T02:26:54.000Z", ...over }]);
const xReq = coingecko.quoteRequests(["crypto:x"])[0];

test("quote request: one request, ids and US dollars in the url", () => {
  assert.equal(marketsReq.provider, "coingecko");
  assert.equal(marketsReq.type, "quotes");
  assert.equal(marketsReq.url, "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,notarealcoinx");
  assert.deepEqual(marketsReq.assets, ["crypto:bitcoin", "crypto:ethereum", "crypto:notarealcoinx"]);
});

test("quote request: empty list and bare prefix give no request, one valid id gives one", () => {
  assert.deepEqual(coingecko.quoteRequests([]), []);
  assert.deepEqual(coingecko.quoteRequests(["crypto:"]), []);
  assert.equal(coingecko.quoteRequests(["crypto:", "crypto:a"]).length, 1);
  assert.deepEqual(coingecko.quoteRequests(["crypto:", "crypto:a"])[0].assets, ["crypto:a"]);
});

test("ids are URL-encoded", () => {
  assert.match(coingecko.quoteRequests(["crypto:a b"])[0].url, /ids=a%20b$/);
  assert.match(coingecko.historyRequests(["crypto:a/b"], "1D")[0].url, /coins\/a%2Fb\/market_chart/);
  assert.match(coingecko.searchRequest("a&b c").url, /query=a%26b%20c$/);
});

test("crypto quotes are priced in US dollars", () => {
  const [q] = coingecko.parse(marketsReq, 200, fixture("markets.json")).filter((q) => q.asset === "crypto:bitcoin");
  assert.equal(q.currency, "USD");
  assert.equal(q.kind, "crypto");
  assert.equal(q.symbol, "BTC");
  assert.equal(q.name, "Bitcoin");
  assert.equal(q.session, null);
  assert.equal(q.provider, "coingecko");
  assert.equal(q.price, fixtureBtc.current_price);
  assert.equal(q.asOf, Date.parse(fixtureBtc.last_updated));
  assert.ok(Math.abs(q.previousClose - (q.price - fixtureBtc.price_change_24h)) < 1e-6);
});

test("quotes and history are requested and labelled in US dollars, whatever else is passed", () => {
  // A caller still passing a base currency must not change the currency asked for.
  const quotes = coingecko.quoteRequests(["crypto:x"], "AUD")[0];
  assert.match(quotes.url, /vs_currency=usd&/);
  assert.equal(coingecko.parse(quotes, 200, market())[0].currency, "USD");
  const history = coingecko.historyRequests(["crypto:x"], "1D", "AUD")[0];
  assert.match(history.url, /vs_currency=usd&/);
  assert.equal(coingecko.parse(history, 200, JSON.stringify({ prices: [[1, 2]] }))[0].currency, "USD");
});

test("unknown ids are simply absent from the result", () => {
  assert.deepEqual(coingecko.parse(marketsReq, 200, fixture("markets.json")).map((q) => q.asset).sort(), ["crypto:bitcoin", "crypto:ethereum"]);
});

test("quotes with unusable data are omitted", () => {
  assert.equal(coingecko.parse(xReq, 200, market()).length, 1);
  assert.equal(coingecko.parse(xReq, 200, market({ current_price: null })).length, 0);
  assert.equal(coingecko.parse(xReq, 200, market({ price_change_24h: null })).length, 0);
  assert.equal(coingecko.parse(xReq, 200, market({ price_change_24h: "1" })).length, 0);
  assert.equal(coingecko.parse(xReq, 200, market({ price_change_24h: 0 })).length, 1);
  assert.equal(coingecko.parse(xReq, 200, market({ last_updated: null })).length, 0);
  assert.equal(coingecko.parse(xReq, 200, market({ last_updated: "garbage" })).length, 0);
  assert.equal(coingecko.parse(xReq, 200, market({ symbol: undefined })).length, 0);
});

test("status: 200 parses, 429 and other failures throw ProviderError", () => {
  assert.doesNotThrow(() => coingecko.parse(marketsReq, 200, "[]"));
  assert.throws(() => coingecko.parse(marketsReq, 429, "{}"), ProviderError);
  assert.throws(() => coingecko.parse(marketsReq, 500, "[]"), ProviderError);
  assert.throws(() => coingecko.parse(marketsReq, 404, "[]"), ProviderError);
  assert.throws(() => coingecko.parse(searchReq, 429, "{}"), ProviderError);
});

test("bad bodies throw ProviderError", () => {
  assert.throws(() => coingecko.parse(marketsReq, 200, "<html>"), ProviderError);
  assert.throws(() => coingecko.parse(marketsReq, 200, "{}"), ProviderError);
  assert.throws(() => coingecko.parse(chartReq, 200, "{}"), ProviderError);
  assert.throws(() => coingecko.parse(searchReq, 200, "[]"), ProviderError);
});

test("history: one request per coin with days per range", () => {
  const days = (r) => coingecko.historyRequests(["crypto:bitcoin"], r)[0].url;
  assert.match(days("1D"), /days=1$/);
  assert.match(days("1W"), /days=7$/);
  assert.match(days("1M"), /days=30$/);
  assert.match(days("3M"), /days=90$/);
  assert.match(days("6M"), /days=180$/);
  assert.match(days("1Y"), /days=365$/);
  const reqs = coingecko.historyRequests(["crypto:bitcoin", "crypto:ethereum"], "1W");
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].url, "https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=7");
  assert.equal(reqs[1].range, "1W");
  assert.deepEqual(reqs[1].assets, ["crypto:ethereum"]);
  assert.deepEqual(coingecko.historyRequests([], "1W"), []);
  assert.deepEqual(coingecko.historyRequests(["crypto:"], "1W"), []);
});

test("history parses ms timestamps into a series", () => {
  const raw = JSON.parse(fixture("chart-7.json")).prices;
  const [s] = coingecko.parse(chartReq, 200, fixture("chart-7.json"));
  assert.equal(s.asset, "crypto:bitcoin");
  assert.equal(s.currency, "USD");
  assert.equal(s.points.length, raw.length);
  assert.deepEqual(s.points[0], raw[0]);
});

test("history drops non-numeric points; empty prices give an empty series", () => {
  const body = (prices) => JSON.stringify({ prices });
  assert.deepEqual(coingecko.parse(chartReq, 200, body([[1, 2], [3, null], [null, 4], [5, 6]]))[0].points, [[1, 2], [5, 6]]);
  assert.deepEqual(coingecko.parse(chartReq, 200, body([]))[0].points, []);
});

test("search returns crypto:<id> refs", () => {
  const results = coingecko.parse(searchReq, 200, fixture("search.json"));
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.asset.startsWith("crypto:") && r.kind === "crypto" && r.exchange === ""));
  const sol = results.find((r) => r.asset === "crypto:solana");
  assert.deepEqual(sol, { asset: "crypto:solana", symbol: "SOL", name: "Solana", kind: "crypto", exchange: "" });
});

test("search skips entries without an id", () => {
  const body = JSON.stringify({ coins: [{ name: "N", symbol: "N" }, { id: "n", name: "N", symbol: "N" }] });
  assert.deepEqual(coingecko.parse(searchReq, 200, body).map((r) => r.asset), ["crypto:n"]);
});

test("day range is the 24-hour low and high when both are given with low <= high", () => {
  const [q] = coingecko.parse(marketsReq, 200, fixture("markets.json")).filter((q) => q.asset === "crypto:bitcoin");
  assert.deepEqual(q.dayRange, { low: fixtureBtc.low_24h, high: fixtureBtc.high_24h });
  assert.deepEqual(coingecko.parse(xReq, 200, market({ low_24h: 9, high_24h: 9 }))[0].dayRange, { low: 9, high: 9 });
  assert.equal("dayRange" in coingecko.parse(xReq, 200, market({ low_24h: 9.01, high_24h: 9 }))[0], false);
  assert.equal("dayRange" in coingecko.parse(xReq, 200, market({ low_24h: 9 }))[0], false);
  assert.equal("dayRange" in coingecko.parse(xReq, 200, market({ low_24h: null, high_24h: 11 }))[0], false);
});
