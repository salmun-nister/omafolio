// Yahoo Finance provider. Pure: builds Request objects for the caller to execute
// (curl, browser-like user agent) and parses the responses; it never touches the network.
//
// Spark (v7/finance/spark) serves both quotes and history, up to BATCH symbols per call.
// Search (v1/finance/search) serves symbol lookup.

import { ProviderError } from "../types.mjs";

/** @typedef {import("../types.mjs").AssetRef} AssetRef */
/** @typedef {import("../types.mjs").Kind} Kind */
/** @typedef {import("../types.mjs").Range} Range */
/** @typedef {import("../types.mjs").Request} Request */
/** @typedef {import("../types.mjs").Quote} Quote */
/** @typedef {import("../types.mjs").Series} Series */
/** @typedef {import("../types.mjs").SearchResult} SearchResult */

const BASE = "https://query1.finance.yahoo.com";
const BATCH = 20;

/** @type {Record<string, Kind>} */
const KIND_BY_TYPE = { EQUITY: "stock", ETF: "etf", MUTUALFUND: "fund", CURRENCY: "fx" };

/** Currencies Yahoo quotes in minor units: code -> [major currency, divisor]. */
/** @type {Record<string, [string, number]>} */
const MINOR_UNITS = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100] };

/** @type {Record<Range, {range: string, interval: string}>} */
const HISTORY_PARAMS = {
  "1D": { range: "1d", interval: "5m" },
  "1W": { range: "5d", interval: "1h" },
  "1M": { range: "1mo", interval: "1d" },
  "3M": { range: "3mo", interval: "1d" },
  "6M": { range: "6mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
};

// Mutual funds have no intraday points, so their 1D chart is the last five daily closes.
const FUND_1D_PARAMS = { range: "5d", interval: "1d" };

/** @param {AssetRef[]} assets @param {{range: string, interval: string}} p @param {"quotes"|"history"} type @param {Range} [chartRange] @returns {Request[]} */
function sparkRequests(assets, p, type, chartRange) {
  /** @type {Request[]} */
  const out = [];
  for (let i = 0; i < assets.length; i += BATCH) {
    const batch = assets.slice(i, i + BATCH);
    const symbols = batch.map(encodeURIComponent).join(",");
    /** @type {Request} */
    const req = {
      provider: "yahoo",
      type,
      url: `${BASE}/v7/finance/spark?symbols=${symbols}&range=${p.range}&interval=${p.interval}`,
      assets: batch,
    };
    if (chartRange) req.range = chartRange;
    out.push(req);
  }
  return out;
}

/**
 * Requests for current quotes: one per 20 assets, in input order. Empty input gives [].
 * @param {AssetRef[]} assets Yahoo symbols.
 * @returns {Request[]}
 */
function quoteRequests(assets) {
  return sparkRequests(assets, HISTORY_PARAMS["1D"], "quotes");
}

/**
 * Requests for price history over `range`, one per 20 assets. For "1D", funds (as reported by
 * `kindOf`) go in separate requests using daily points, because Yahoo has no intraday data for them.
 * @param {AssetRef[]} assets Yahoo symbols.
 * @param {Range} range
 * @param {(asset: AssetRef) => Kind|undefined} kindOf Known kind of an asset, or undefined if unknown.
 * @returns {Request[]}
 */
function historyRequests(assets, range, kindOf) {
  if (range !== "1D") return sparkRequests(assets, HISTORY_PARAMS[range], "history", range);
  const funds = assets.filter((a) => kindOf(a) === "fund");
  const others = assets.filter((a) => kindOf(a) !== "fund");
  return [
    ...sparkRequests(others, HISTORY_PARAMS["1D"], "history", range),
    ...sparkRequests(funds, FUND_1D_PARAMS, "history", range),
  ];
}

/**
 * Request for a symbol search; the query is URL-encoded.
 * @param {string} query
 * @returns {Request}
 */
function searchRequest(query) {
  return {
    provider: "yahoo",
    type: "search",
    url: `${BASE}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
    assets: [],
  };
}

/** @param {string} body @returns {any} */
function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new ProviderError("Yahoo returned a non-JSON body");
  }
}

/** Whether a body is Yahoo's answer for symbols it does not know: `spark.error.code` "Not Found". */
function isUnknownSymbols(/** @type {string} */ body) {
  try {
    return JSON.parse(body)?.spark?.error?.code === "Not Found";
  } catch (_) {
    return false;
  }
}

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Returns the major currency code and the divisor to apply to prices quoted in `currency`. */
function normaliseCurrency(/** @type {string} */ currency) {
  const minor = MINOR_UNITS[currency];
  return minor ? { currency: minor[0], divisor: minor[1] } : { currency, divisor: 1 };
}

/** Maps the symbol Yahoo returned back to the AssetRef the caller asked for (case-insensitive). */
function assetFor(/** @type {Request} */ request, /** @type {string} */ symbol) {
  const upper = symbol.toUpperCase();
  return request.assets.find((a) => a.toUpperCase() === upper) ?? symbol;
}

/**
 * Yields [symbol, response] for each spark result that has data. Throws ProviderError on an
 * unexpected shape. Symbols Yahoo omitted or answered without data are skipped.
 * @param {any} json
 * @returns {Array<{symbol: string, meta: any, timestamp: any, close: any}>}
 */
function sparkEntries(json) {
  const result = json?.spark?.result;
  if (!Array.isArray(result)) throw new ProviderError("Unexpected Yahoo spark response shape");
  const out = [];
  for (const r of result) {
    const resp = r?.response?.[0];
    if (typeof r?.symbol !== "string" || !resp?.meta) continue;
    out.push({
      symbol: r.symbol,
      meta: resp.meta,
      timestamp: resp.timestamp,
      close: resp.indicators?.quote?.[0]?.close,
    });
  }
  return out;
}

/**
 * The session's low and high, scaled to major units, or null unless both are
 * numbers with low <= high.
 * @param {unknown} low
 * @param {unknown} high
 * @param {number} divisor
 */
function dayRange(low, high, divisor) {
  return isNum(low) && isNum(high) && low <= high ? { low: low / divisor, high: high / divisor } : null;
}

/** @returns {Quote[]} */
function parseQuotes(/** @type {Request} */ request, /** @type {any} */ json) {
  /** @type {Quote[]} */
  const quotes = [];
  for (const { symbol, meta, timestamp } of sparkEntries(json)) {
    const kind = KIND_BY_TYPE[meta.instrumentType];
    const rawPrevious = isNum(meta.previousClose) ? meta.previousClose : meta.chartPreviousClose;
    if (!kind || !isNum(meta.regularMarketPrice) || !isNum(rawPrevious) || typeof meta.currency !== "string") continue;
    // Price time: the quote's own time, else the last chart point; with neither the quote is unusable.
    const lastPoint = Array.isArray(timestamp) ? timestamp[timestamp.length - 1] : undefined;
    const asOfSeconds = isNum(meta.regularMarketTime) ? meta.regularMarketTime : lastPoint;
    if (!isNum(asOfSeconds)) continue;
    const { currency, divisor } = normaliseCurrency(meta.currency);
    const regular = meta.currentTradingPeriod?.regular;
    const hasSession = isNum(regular?.start) && isNum(regular?.end) && typeof meta.exchangeTimezoneName === "string";
    /** @type {Quote} */
    const quote = {
      asset: assetFor(request, symbol),
      symbol,
      name: meta.longName || meta.shortName || symbol,
      price: meta.regularMarketPrice / divisor,
      previousClose: rawPrevious / divisor,
      currency,
      kind,
      asOf: asOfSeconds * 1000,
      session: null,
      provider: "yahoo",
    };
    if (hasSession) {
      quote.session = { start: regular.start * 1000, end: regular.end * 1000, timezone: meta.exchangeTimezoneName };
      if (isNum(meta.gmtoffset)) quote.session.utcOffsetSeconds = meta.gmtoffset;
    }
    const range = dayRange(meta.regularMarketDayLow, meta.regularMarketDayHigh, divisor);
    if (range) quote.dayRange = range;
    quotes.push(quote);
  }
  return quotes;
}

/** @returns {Series[]} */
function parseHistory(/** @type {Request} */ request, /** @type {any} */ json) {
  /** @type {Series[]} */
  const series = [];
  for (const { symbol, meta, timestamp, close } of sparkEntries(json)) {
    if (!Array.isArray(timestamp) || !Array.isArray(close) || typeof meta.currency !== "string") continue;
    const { currency, divisor } = normaliseCurrency(meta.currency);
    /** @type {Array<[number, number]>} */
    const points = [];
    for (let i = 0; i < timestamp.length; i++) {
      if (isNum(timestamp[i]) && isNum(close[i])) points.push([timestamp[i] * 1000, close[i] / divisor]);
    }
    series.push({ asset: assetFor(request, symbol), currency, points });
  }
  return series;
}

/** @returns {SearchResult[]} */
function parseSearch(/** @type {any} */ json) {
  if (!Array.isArray(json?.quotes)) throw new ProviderError("Unexpected Yahoo search response shape");
  /** @type {SearchResult[]} */
  const results = [];
  for (const q of json.quotes) {
    const kind = KIND_BY_TYPE[q?.quoteType];
    if (!kind || typeof q.symbol !== "string") continue;
    results.push({
      asset: q.symbol,
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      kind,
      exchange: q.exchDisp || q.exchange || "",
    });
  }
  return results;
}

/**
 * Parses the response to `request`. Returns Quote[] for "quotes", Series[] for "history" and
 * SearchResult[] for "search". Assets with unusable data (null price, unknown instrument type,
 * null closes) are omitted rather than returned as NaN. Yahoo answers HTTP 404 with its own
 * "Not Found" error body when every requested symbol is unknown; for quotes and history that is
 * an empty result. Any other 404 (a retired endpoint, an HTML page) is a provider failure.
 * @param {Request} request
 * @param {number} status HTTP status.
 * @param {string} body
 * @returns {Quote[]|Series[]|SearchResult[]}
 * @throws {ProviderError} on a non-JSON body, an unexpected shape, or any other non-200 status
 *   (including a 404 on search, and a 404 without Yahoo's "Not Found" error body).
 */
function parse(request, status, body) {
  if (status === 404 && request.type !== "search" && isUnknownSymbols(body)) return [];
  if (status !== 200) throw new ProviderError(`Yahoo returned HTTP ${status}`);
  const json = parseJson(body);
  if (request.type === "quotes") return parseQuotes(request, json);
  if (request.type === "history") return parseHistory(request, json);
  return parseSearch(json);
}

/** The Yahoo provider. */
const Provider = { id: "yahoo", quoteRequests, historyRequests, searchRequest, parse };
export default Provider;
