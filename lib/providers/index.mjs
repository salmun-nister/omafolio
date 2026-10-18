// Provider routing. Assets starting with "crypto:" go to CoinGecko; everything else is a Yahoo
// symbol, except cash ("cash:EUR"), which belongs to Yahoo (its price is a Yahoo exchange
// rate, lib/cash.mjs) but is never put in a request itself. Callers deal only in this module: it splits a mixed asset list per provider, builds
// each provider's requests and routes each response back to the provider that issued it.
// Search results from the two providers are merged by the caller, not here.

import { ProviderError } from "../types.mjs";
import { isCash } from "../cash.mjs";
import yahoo from "./yahoo.mjs";
import coingecko from "./coingecko.mjs";

/** @typedef {import("../types.mjs").AssetRef} AssetRef */
/** @typedef {import("../types.mjs").Kind} Kind */
/** @typedef {import("../types.mjs").Range} Range */
/** @typedef {import("../types.mjs").Request} Request */
/** @typedef {import("../types.mjs").Quote} Quote */
/** @typedef {import("../types.mjs").Series} Series */
/** @typedef {import("../types.mjs").SearchResult} SearchResult */

const providers = [yahoo, coingecko];

/**
 * The provider responsible for an asset: whose health and outages apply to it.
 * @param {AssetRef} asset
 */
export function providerFor(asset) {
  return asset.startsWith("crypto:") ? coingecko : yahoo;
}

/** Splits the assets a provider can be asked for by provider, keeping input order within each. */
function partition(/** @type {AssetRef[]} */ assets) {
  return {
    yahoo: assets.filter((a) => providerFor(a) === yahoo && !isCash(a)),
    coingecko: assets.filter((a) => providerFor(a) === coingecko),
  };
}

/**
 * Requests for current quotes across providers; a provider with no assets contributes none.
 * Each quote comes back in its asset's own currency (US dollars for crypto).
 * @param {AssetRef[]} assets
 * @returns {Request[]}
 */
export function quoteRequests(assets) {
  const p = partition(assets);
  return [...yahoo.quoteRequests(p.yahoo), ...coingecko.quoteRequests(p.coingecko)];
}

/**
 * Requests for price history across providers, each series in its asset's own currency.
 * @param {AssetRef[]} assets
 * @param {Range} range
 * @param {(asset: AssetRef) => Kind|undefined} kindOf Known kind of a Yahoo asset, or undefined.
 * @returns {Request[]}
 */
export function historyRequests(assets, range, kindOf) {
  const p = partition(assets);
  return [...yahoo.historyRequests(p.yahoo, range, kindOf), ...coingecko.historyRequests(p.coingecko, range)];
}

/**
 * One search request per provider.
 * @param {string} query
 * @returns {Request[]}
 */
export function searchRequests(query) {
  return providers.map((p) => p.searchRequest(query));
}

/**
 * Parses a response with the provider that issued `request`.
 * @param {Request} request
 * @param {number} status HTTP status.
 * @param {string} body
 * @returns {Quote[]|Series[]|SearchResult[]}
 * @throws {ProviderError} for an unknown `request.provider`, or whatever the provider throws.
 */
export function parse(request, status, body) {
  const p = providers.find((x) => x.id === request.provider);
  if (!p) throw new ProviderError(`Unknown provider "${request.provider}"`);
  return p.parse(request, status, body);
}
