// Cash: money held in a currency, named "cash:" plus its ISO 4217 code ("cash:EUR").
//
// Cash is never fetched. Its price is derived from the `<CCY><BASE>=X` exchange rate the
// plugin fetches anyway to convert foreign assets: one euro is worth the EUR→base rate, in
// the base currency. Cash in the base currency is always worth 1. This module turns cash
// references into ordinary quotes, price states and series, so everything downstream values
// and draws cash like any other asset. Functions take any list of assets and act on the
// cash ones only.
// Pure ES module: runs in Node and in QML's JS engine.

/** @typedef {import("./types.mjs").AssetRef} AssetRef */
/** @typedef {import("./types.mjs").Quote} Quote */
/** @typedef {import("./types.mjs").PriceState} PriceState */
/** @typedef {import("./types.mjs").SearchResult} SearchResult */
/** @typedef {import("./types.mjs").Series} Series */
/** @typedef {import("./types.mjs").Range} Range */

const PREFIX = "cash:";

/**
 * Currencies offered by search, in the order results are listed, with their names. Yahoo
 * prices each against the others as `<CCY><BASE>=X`. A code missing here still works when
 * Yahoo knows its rate; it is then named by its code.
 * @type {Array<[string, string]>}
 */
const CURRENCIES = [
  ["USD", "US dollar"], ["AUD", "Australian dollar"], ["EUR", "Euro"], ["GBP", "British pound"],
  ["JPY", "Japanese yen"], ["CAD", "Canadian dollar"], ["NZD", "New Zealand dollar"],
  ["CHF", "Swiss franc"], ["SGD", "Singapore dollar"], ["HKD", "Hong Kong dollar"],
  ["CNY", "Chinese yuan"], ["KRW", "South Korean won"], ["TWD", "Taiwan dollar"],
  ["INR", "Indian rupee"], ["THB", "Thai baht"], ["MYR", "Malaysian ringgit"],
  ["IDR", "Indonesian rupiah"], ["PHP", "Philippine peso"], ["VND", "Vietnamese dong"],
  ["PKR", "Pakistani rupee"], ["SEK", "Swedish krona"], ["NOK", "Norwegian krone"],
  ["DKK", "Danish krone"], ["ISK", "Icelandic króna"], ["PLN", "Polish złoty"],
  ["CZK", "Czech koruna"], ["HUF", "Hungarian forint"], ["RON", "Romanian leu"],
  ["TRY", "Turkish lira"], ["ILS", "Israeli shekel"], ["AED", "UAE dirham"],
  ["SAR", "Saudi riyal"], ["QAR", "Qatari riyal"], ["KWD", "Kuwaiti dinar"],
  ["EGP", "Egyptian pound"], ["NGN", "Nigerian naira"], ["KES", "Kenyan shilling"],
  ["ZAR", "South African rand"], ["MXN", "Mexican peso"], ["BRL", "Brazilian real"],
  ["ARS", "Argentine peso"], ["CLP", "Chilean peso"], ["COP", "Colombian peso"],
];

/**
 * Whether `asset` is cash.
 * @param {AssetRef} asset
 */
export function isCash(asset) {
  return asset.startsWith(PREFIX);
}

/**
 * The currency a cash reference holds ("cash:EUR" -> "EUR").
 * @param {AssetRef} asset
 */
export function cashCurrency(asset) {
  return asset.slice(PREFIX.length);
}

/** Name of a currency code: from the table, or the code itself. @param {string} code */
function currencyName(code) {
  const entry = CURRENCIES.find((c) => c[0] === code);
  return entry ? entry[1] : code;
}

/** The rate pair valuing `code` in `base`. @param {string} code @param {string} base */
const pairOf = (code, base) => code + base + "=X";

/**
 * The cash assets among `assets`, each once.
 * @param {AssetRef[]} assets
 */
function cashAmong(assets) {
  return assets.filter((a, i) => isCash(a) && assets.indexOf(a) === i);
}

/**
 * Exchange-rate pairs the cash among `assets` is priced with: one per currency other than
 * `baseCurrency`, de-duplicated and alphabetical.
 * @param {AssetRef[]} assets
 * @param {string} baseCurrency
 * @returns {AssetRef[]}
 */
export function cashPairs(assets, baseCurrency) {
  const pairs = cashAmong(assets)
    .map(cashCurrency)
    .filter((c) => c !== baseCurrency)
    .map((c) => pairOf(c, baseCurrency));
  return pairs.filter((p, i) => pairs.indexOf(p) === i).sort();
}

/**
 * A quote for each cash asset among `assets`, keyed by its reference, priced in
 * `baseCurrency`. Foreign cash takes its rate quote's price, previous close, time, session
 * and day range, and gets no quote while that rate has none. Cash in the base currency is
 * 1, as of `now`, with no session.
 * @param {AssetRef[]} assets
 * @param {Record<AssetRef, Quote>} quotes Fetched quotes, rate pairs included.
 * @param {string} baseCurrency
 * @param {number} now Epoch milliseconds.
 * @returns {Record<AssetRef, Quote>}
 */
export function cashQuotes(assets, quotes, baseCurrency, now) {
  /** @type {Record<AssetRef, Quote>} */
  const out = {};
  for (const asset of cashAmong(assets)) {
    const code = cashCurrency(asset);
    /** @type {Quote} */
    const quote = {
      asset, symbol: code + " cash", name: currencyName(code), kind: "cash", provider: "yahoo",
      currency: baseCurrency, price: 1, previousClose: 1, asOf: now, session: null,
    };
    if (code !== baseCurrency) {
      const rate = quotes[pairOf(code, baseCurrency)];
      if (!rate) continue;
      quote.price = rate.price;
      quote.previousClose = rate.previousClose;
      quote.asOf = rate.asOf;
      quote.session = rate.session;
      if (rate.dayRange) quote.dayRange = rate.dayRange;
    }
    out[asset] = quote;
  }
  return out;
}

/**
 * Price state of each cash asset among `assets`: its rate's state ("missing" when the rate
 * has none); always "live" for cash in the base currency.
 * @param {AssetRef[]} assets
 * @param {Record<AssetRef, PriceState>} states States of fetched assets, rate pairs included.
 * @param {string} baseCurrency
 * @returns {Record<AssetRef, PriceState>}
 */
export function cashStates(assets, states, baseCurrency) {
  /** @type {Record<AssetRef, PriceState>} */
  const out = {};
  for (const asset of cashAmong(assets)) {
    const code = cashCurrency(asset);
    out[asset] = code === baseCurrency ? "live" : states[pairOf(code, baseCurrency)] || "missing";
  }
  return out;
}

/**
 * Assets whose history must be fetched to draw `assets`: each non-cash asset as it is, each
 * foreign cash asset replaced by its rate pair, cash in the base currency dropped (its
 * history is flat and made up here). Each once, in input order.
 * @param {AssetRef[]} assets
 * @param {string} baseCurrency
 * @returns {AssetRef[]}
 */
export function historySources(assets, baseCurrency) {
  /** @type {AssetRef[]} */
  const out = [];
  for (const asset of assets) {
    let source = asset;
    if (isCash(asset)) {
      const code = cashCurrency(asset);
      if (code === baseCurrency) continue;
      source = pairOf(code, baseCurrency);
    }
    if (out.indexOf(source) < 0) out.push(source);
  }
  return out;
}

/** Span each chart range covers, in milliseconds. */
const DAY = 24 * 3600 * 1000;
const SPAN_MS = { "1D": DAY, "1W": 7 * DAY, "1M": 30 * DAY, "1Y": 365 * DAY };

/**
 * A series per cash asset among `assets`: foreign cash gets its rate pair's series under its
 * own name (none while the rate has none); cash in the base currency a flat line at 1 spanning
 * `range` and ending at the latest point of any fetched series (`now` when there is none).
 * It so starts no later and ends no later than the history it is charted with: it never
 * moves the start of the combined portfolio chart, nor stretches it past a market's close.
 * @param {AssetRef[]} assets
 * @param {Record<AssetRef, Series>} seriesByAsset Fetched history for `range`, rate pairs included.
 * @param {string} baseCurrency
 * @param {Range} range
 * @param {number} now Epoch milliseconds.
 * @returns {Record<AssetRef, Series>}
 */
export function cashSeries(assets, seriesByAsset, baseCurrency, range, now) {
  /** @type {Record<AssetRef, Series>} */
  const out = {};
  let end = -Infinity;
  for (const series of Object.values(seriesByAsset)) {
    const last = series.points[series.points.length - 1];
    if (last && last[0] > end) end = last[0];
  }
  if (end === -Infinity) end = now;
  for (const asset of cashAmong(assets)) {
    const code = cashCurrency(asset);
    if (code === baseCurrency) {
      out[asset] = { asset, currency: baseCurrency, points: [[end - SPAN_MS[range], 1], [end, 1]] };
      continue;
    }
    const rate = seriesByAsset[pairOf(code, baseCurrency)];
    if (rate) out[asset] = { asset, currency: rate.currency, points: rate.points };
  }
  return out;
}

/**
 * The cost a new holding of cash starts at, so it starts at no gain: 1 for cash in the base
 * currency, the current rate when its quote is known, otherwise 0 (as any new holding).
 * @param {AssetRef} asset A cash reference.
 * @param {Record<AssetRef, Quote>} quotes
 * @param {string} baseCurrency
 */
export function startingCost(asset, quotes, baseCurrency) {
  const code = cashCurrency(asset);
  if (code === baseCurrency) return 1;
  const rate = quotes[pairOf(code, baseCurrency)];
  return rate ? rate.price : 0;
}

/**
 * Cash search results: currencies whose code or name contains `query`, ignoring case, in
 * table order. Nothing for a blank query.
 * @param {string} query
 * @returns {SearchResult[]}
 */
export function searchCash(query) {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return CURRENCIES
    .filter((c) => c[0].toLowerCase().indexOf(q) >= 0 || c[1].toLowerCase().indexOf(q) >= 0)
    .map((c) => ({ asset: PREFIX + c[0], symbol: c[0] + " cash", name: c[1], kind: /** @type {"cash"} */ ("cash"), exchange: "Cash" }));
}
