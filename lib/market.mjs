// Market logic: which assets to fetch, whether a displayed price is trustworthy, when to poll
// next, and how quotes and provider health evolve. Pure: time is always a parameter (ms).

import { providerFor } from "./providers/index.mjs";
import { cashCurrency, isCash } from "./cash.mjs";

/** @typedef {import("./types.mjs").AssetRef} AssetRef */
/** @typedef {import("./types.mjs").Quote} Quote */
/** @typedef {import("./types.mjs").Health} Health */
/** @typedef {import("./types.mjs").Holding} Holding */
/** @typedef {import("./types.mjs").PriceState} PriceState */

/** A provider failing for longer than this makes its prices stale. */
export const STALE_AFTER_MS = 180000;
/** Poll interval for a Yahoo provider whose markets are all closed. */
export const CLOSED_POLL_MS = 900000;
/** Upper bound on failure backoff. */
export const MAX_BACKOFF_MS = 900000;
const BACKOFF_BASE_MS = 60000;

/**
 * Every asset worth fetching: holdings, then watch, then bar items, first occurrence wins.
 * The synthetic "portfolio" bar item is not an asset.
 * @param {{bar: AssetRef[], watch: AssetRef[]}} settings
 * @param {Holding[]} holdings
 * @returns {AssetRef[]}
 */
export function assetsToFetch(settings, holdings) {
  const all = [...holdings.map((h) => h.asset), ...settings.watch, ...settings.bar];
  return [...new Set(all)].filter((a) => a !== "portfolio");
}

/**
 * Yahoo FX symbols (`<CCY><BASE>=X`) needed to convert into `baseCurrency`: one per foreign
 * currency among quote currencies (crypto included, FX and cash quotes excluded), holding cost
 * currencies, and the currencies of the cash among `followed` (cash is priced by its rate).
 * @param {Record<AssetRef, Quote>} quotes
 * @param {Holding[]} holdings
 * @param {string} baseCurrency
 * @param {AssetRef[]} [followed] Every asset followed, cash included.
 * @returns {AssetRef[]} De-duplicated, alphabetical.
 */
export function fxPairs(quotes, holdings, baseCurrency, followed = []) {
  const currencies = new Set();
  for (const quote of Object.values(quotes)) {
    if (quote.kind !== "fx" && quote.kind !== "cash") currencies.add(quote.currency);
  }
  for (const h of holdings) if (h.costCurrency) currencies.add(h.costCurrency);
  for (const asset of followed) if (isCash(asset)) currencies.add(cashCurrency(asset));
  currencies.delete(baseCurrency);
  return [...currencies].sort().map((c) => `${c}${baseCurrency}=X`);
}

/** Open when there is no session (crypto) or `start <= now < end`. */
function isOpen(/** @type {Quote} */ quote, /** @type {number} */ now) {
  const s = quote.session;
  return s === null || s === undefined || (s.start <= now && now < s.end);
}

/**
 * How a quote should be presented. Precedence: missing, left out, closed, stale, live.
 * - A quote its provider has kept answering without for more than STALE_AFTER_MS (its latest
 *   success is that much newer than the quote's `receivedAt`) is stale whatever its session
 *   says: the session is the one it last arrived with, which never moves on. Closed markets
 *   are still polled (CLOSED_POLL_MS), so a quote that keeps arriving is never caught by this.
 * - Otherwise a closed market wins over failure or cache, since the price is expected not to
 *   move.
 * - An open price is stale when it came from the cache or its provider has been failing for
 *   more than STALE_AFTER_MS.
 * @param {Quote|undefined} quote
 * @param {Health|undefined} health Health of the quote's provider; undefined counts as healthy.
 * @param {number} now
 * @returns {PriceState}
 */
export function priceState(quote, health, now) {
  if (!quote) return "missing";
  if (health && health.lastSuccess !== null && quote.receivedAt !== undefined
    && health.lastSuccess - quote.receivedAt > STALE_AFTER_MS) return "stale";
  if (!isOpen(quote, now)) return "closed";
  if (health && health.failingSince !== null && now - health.failingSince > STALE_AFTER_MS) return "stale";
  if (quote.fromCache) return "stale";
  return "live";
}

/**
 * Delay before a provider's next fetch. Failures back off from 60 s, doubling, capped at
 * MAX_BACKOFF_MS, whatever the market state. Otherwise Yahoo polls every CLOSED_POLL_MS when it
 * has quotes and none is open, and everything else polls every `refreshSeconds`.
 * @param {"yahoo"|"coingecko"|string} providerId
 * @param {Record<AssetRef, Quote>} quotes
 * @param {Health|undefined} health
 * @param {number} refreshSeconds
 * @param {number} now
 * @returns {number} Milliseconds.
 */
export function nextDelayMs(providerId, quotes, health, refreshSeconds, now) {
  const failures = health ? health.failures : 0;
  if (failures >= 1) return backoffMs(failures);
  if (providerId === "yahoo") {
    const own = Object.values(quotes).filter((quote) => providerFor(quote.asset).id === "yahoo");
    if (own.length > 0 && !own.some((quote) => isOpen(quote, now))) return CLOSED_POLL_MS;
  }
  return refreshSeconds * 1000;
}

/** Wait after the `failures`-th consecutive failure (failures >= 1). */
function backoffMs(/** @type {number} */ failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/**
 * Whether a provider is resting after a failure: its latest failure was less than the backoff
 * delay nextDelayMs gives for it ago. Nothing optional (such as history) should be requested
 * from it until then. A healthy or unknown provider is never in backoff.
 * @param {Health|undefined} health
 * @param {number} now
 */
export function inBackoff(health, now) {
  if (!health || health.failures < 1 || health.lastFailure === null) return false;
  return now - health.lastFailure < backoffMs(health.failures);
}

/**
 * Overlays fresh quotes onto previous ones, so a quote missing from a response survives
 * (and goes stale, see priceState). Fresh quotes are stored without `fromCache` and with
 * `receivedAt` set to `now`. Does not mutate `previous`.
 * @param {Record<AssetRef, Quote>} previous
 * @param {Quote[]} fresh
 * @param {number} now
 * @returns {Record<AssetRef, Quote>}
 */
export function mergeQuotes(previous, fresh, now) {
  const merged = Object.assign({}, previous);
  for (const quote of fresh) {
    const rest = Object.assign({}, quote, { receivedAt: now });
    delete rest.fromCache;
    merged[quote.asset] = rest;
  }
  return merged;
}

/**
 * Requested assets that have never had a price: no quote in `quotes`, fresh or cached. An asset
 * a response leaves out keeps its last quote, which goes stale (priceState).
 * @param {AssetRef[]} requested
 * @param {Record<AssetRef, Quote>} quotes Every quote held, after merging the response.
 * @returns {AssetRef[]}
 */
export function notFound(requested, quotes) {
  return requested.filter((a) => !Object.prototype.hasOwnProperty.call(quotes, a));
}

/**
 * The series to keep for one asset after a history answer: the answer's series for it, else
 * `previous`. A failed request (`answer` null) or one that left the asset out never erases a
 * series already held.
 * @param {import("./types.mjs").Series|null} previous
 * @param {import("./types.mjs").Series[]|null} answer
 * @param {AssetRef} asset
 * @returns {import("./types.mjs").Series|null}
 */
export function keptSeries(previous, answer, asset) {
  const found = answer ? answer.find((s) => s.asset === asset) : undefined;
  return found || previous;
}

/** @type {Health} */
const NO_HEALTH = { failures: 0, failingSince: null, lastSuccess: null, lastFailure: null };

/**
 * @param {Health|undefined} health
 * @param {number} now
 * @returns {Health}
 */
export function recordSuccess(health, now) {
  return { failures: 0, failingSince: null, lastSuccess: now, lastFailure: null };
}

/**
 * Counts a failure at `now`; `failingSince` keeps its first value. Does not mutate `health`.
 * @param {Health|undefined} health
 * @param {number} now
 * @returns {Health}
 */
export function recordFailure(health, now) {
  const h = health || NO_HEALTH;
  const failingSince = h.failingSince === null ? now : h.failingSince;
  return { failures: h.failures + 1, failingSince, lastSuccess: h.lastSuccess, lastFailure: now };
}

/**
 * Whether a fetch is allowed: at least `refreshSeconds` since the last attempt (or none yet).
 * @param {number|null} lastAttemptAt
 * @param {number} refreshSeconds
 * @param {number} now
 */
export function canFetchNow(lastAttemptAt, refreshSeconds, now) {
  return lastAttemptAt === null || now - lastAttemptAt >= refreshSeconds * 1000;
}
