// Shared type definitions (JSDoc only) plus the one runtime export, ProviderError.
// Other modules reference these with:
//   /** @typedef {import("./types.mjs").Quote} Quote */

/** Provider-qualified asset identifier, e.g. "VOO" or "crypto:bitcoin". @typedef {string} AssetRef */

/** `cash` is money in a currency, priced from exchange rates (lib/cash.mjs). @typedef {"stock"|"etf"|"fund"|"fx"|"crypto"|"cash"} Kind */

/** Chart history range. @typedef {"1D"|"1W"|"1M"|"3M"|"6M"|"1Y"} Range */

/** How trustworthy a displayed price is. @typedef {"live"|"closed"|"stale"|"missing"} PriceState */

/**
 * A trading session. `start` and `end` are epoch milliseconds; `timezone` is an IANA name;
 * `utcOffsetSeconds` is the exchange's offset from UTC at the time of the quote (e.g.
 * -14400 for New York in summer), absent when the provider gave none.
 * @typedef {{start: number, end: number, timezone: string, utcOffsetSeconds?: number}} Session
 */

/**
 * @typedef {object} Quote
 * @property {AssetRef} asset
 * @property {string} symbol
 * @property {string} name
 * @property {number} price
 * @property {number} previousClose
 * @property {string} currency ISO 4217 code.
 * @property {Kind} kind
 * @property {number} asOf Epoch milliseconds of the price.
 * @property {Session|null} session
 * @property {"yahoo"|"coingecko"} provider
 * @property {{low: number, high: number}} [dayRange] Lowest and highest price of the latest
 *   session (Yahoo) or the last 24 hours (crypto), in `currency`; absent when the provider
 *   gives none (mutual funds).
 * @property {number} [receivedAt] Epoch milliseconds when a provider response last carried this
 *   quote (market.mergeQuotes sets it); never written to the quote cache.
 * @property {boolean} [fromCache]
 */

/**
 * Price history. Each point is `[epochMilliseconds, price]`.
 * @typedef {{asset: AssetRef, currency: string, points: Array<[number, number]>}} Series
 */

/** @typedef {{asset: AssetRef, symbol: string, name: string, kind: Kind, exchange: string}} SearchResult */

/**
 * A position the user holds. `cost` is the average cost per unit in `costCurrency`
 * (the quote currency when omitted).
 * @typedef {{asset: AssetRef, quantity: number, cost: number, costCurrency?: string}} Holding
 */

/**
 * A network request a provider wants made; the caller performs it.
 * @typedef {object} Request
 * @property {string} provider
 * @property {"quotes"|"history"|"search"} type
 * @property {string} url
 * @property {AssetRef[]} assets
 * @property {Range} [range]
 */

/**
 * Provider health. Times are epoch milliseconds. `failures` counts consecutive failures,
 * `failingSince` is the first of them and `lastFailure` the latest (both null while healthy).
 * @typedef {{failures: number, failingSince: number|null, lastSuccess: number|null, lastFailure: number|null}} Health
 */

/** Raised when a provider response is unusable (bad status, malformed payload). */
export class ProviderError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProviderError";
  }
}
