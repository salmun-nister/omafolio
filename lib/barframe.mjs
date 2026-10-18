// What one frame of the bar ticker shows. Pure: the widget supplies the data and
// the time and draws the result.

import { assetLabel, changeDirection, formatBarPrice, formatBarValue, formatChange, formatClock, formatDayClock } from "./format.mjs";
import { fxRate } from "./portfolio.mjs";
import { providerFor } from "./providers/index.mjs";
import { cashCurrency, isCash } from "./cash.mjs";

/** @typedef {import("./types.mjs").AssetRef} AssetRef */

const DASH = "—";
/** @type {Record<string, string>} */
const PROVIDER_NAMES = { yahoo: "Yahoo", coingecko: "CoinGecko" };
/** Label of the portfolio total. */
export const PORTFOLIO_GLYPH = "󰄨";

/**
 * @typedef {object} BarFrame
 * @property {string} label "₿", a ticker, or the portfolio glyph.
 * @property {string} value Compact number, or "—" when there is no price; "…" before the first
 *   successful fetch. An asset's price carries its currency prefix when it is not in the base
 *   currency; the portfolio total never does.
 * @property {string} change "▲ 1.4%"-style day move; empty when there is none to show.
 * @property {"up"|"down"|"flat"} direction Which way `change` points; "flat" also when there is no change.
 * @property {"live"|"closed"|"stale"|"missing"} state How to draw it: "closed" is dimmed
 *   with a sleep glyph, "stale" adds a warning glyph.
 * @property {boolean} warn Whether the frame carries a warning glyph (stale or excluded assets).
 * @property {string} tooltip Explanation of what is stale or missing; empty when nothing is.
 */

/**
 * The amount and currency to show for a price of an asset quoted in `currency`. With
 * `nativePrices` that is the price as quoted. Without it the price is converted into `base`
 * at the current rate (portfolio.fxRate); when no rate is known yet it stays as quoted, so
 * the caller labels it with its own currency rather than showing nothing. `via` is the
 * exchange-rate quote the amount was converted with (null when it is as quoted), so the
 * caller can tell whether that rate is stale. Totals, values and gains never come through
 * here: they are always in `base`.
 * @param {number} price
 * @param {string} currency
 * @param {string} base
 * @param {Record<string, import("./types.mjs").Quote>} quotes Where the exchange rates are.
 * @param {boolean} nativePrices
 * @returns {{amount: number, currency: string, via: AssetRef|null}}
 */
export function displayPrice(price, currency, base, quotes, nativePrices) {
  const rate = nativePrices ? null : fxRate(currency, base, quotes);
  if (rate === null) return { amount: price, currency, via: null };
  return { amount: price * rate, currency: base, via: currency === base ? null : currency + base + "=X" };
}

/**
 * The stale prices a displayed price of `asset` rests on: the asset's own, and the exchange
 * rate it was converted with (`via`, from displayPrice). Empty when both are trustworthy.
 * @param {AssetRef} asset
 * @param {AssetRef|null} via
 * @param {Record<AssetRef, string>} states
 * @returns {AssetRef[]}
 */
export function staleBehind(asset, via, states) {
  return [asset].concat(via === null ? [] : [via]).filter((a) => states[a] === "stale");
}

/**
 * Whether the provider answering for `asset` has finished at least one fetch attempt.
 * @param {AssetRef} asset
 * @param {Record<string, import("./types.mjs").Health>} health
 */
export function attempted(asset, health) {
  const h = health[providerFor(asset).id];
  return !!h && (h.lastSuccess !== null || h.failures > 0);
}

/**
 * Whether a provider is in an outage (has failed since its last success).
 * @param {import("./types.mjs").Health|undefined} h
 * @returns {h is import("./types.mjs").Health & {failingSince: number}}
 */
export function isFailing(h) {
  return !!h && h.failingSince !== null && h.failingSince !== undefined;
}

/**
 * Display name of a provider id ("Yahoo", "CoinGecko").
 * @param {string} id
 */
export function providerName(id) {
  return PROVIDER_NAMES[id] || id;
}

/**
 * An asset reference without its provider prefix ("crypto:bitcoin" -> "bitcoin"), and cash
 * by its currency ("cash:EUR" -> "EUR cash").
 * @param {AssetRef} asset
 */
export function shortName(asset) {
  if (isCash(asset)) return cashCurrency(asset) + " cash";
  return asset.startsWith("crypto:") ? asset.slice("crypto:".length) : asset;
}

/**
 * "VOO as of Fri 16:00 (Yahoo unavailable since 14:02)"; the parenthesis only when the
 * quote's provider is currently failing.
 * @param {AssetRef} asset
 * @param {Record<string, import("./types.mjs").Quote>} quotes
 * @param {Record<string, import("./types.mjs").Health>} health
 */
function staleEntry(asset, quotes, health) {
  const quote = quotes[asset];
  if (!quote) return shortName(asset);
  let text = quote.symbol + " as of " + formatDayClock(quote.asOf);
  const h = health[quote.provider];
  if (isFailing(h)) {
    text += " (" + providerName(quote.provider) + " unavailable since " + formatClock(h.failingSince) + ")";
  }
  return text;
}

/**
 * The tooltip explaining what is wrong with a value: one line naming the stale
 * prices it includes (and since when), one per provider outage that leaves
 * assets out, then the assets left out as not found or without an exchange
 * rate. Empty when nothing is wrong, and for assets whose provider has not
 * answered yet.
 * @param {AssetRef[]} stale
 * @param {AssetRef[]} excluded Assets left out of the value.
 * @param {Record<AssetRef, string>} states
 * @param {Record<string, import("./types.mjs").Quote>} quotes
 * @param {Record<string, import("./types.mjs").Health>} health
 */
export function explain(stale, excluded, states, quotes, health) {
  const lines = [];
  if (stale.length > 0) {
    lines.push("Includes " + stale.length + " stale price" + (stale.length === 1 ? "" : "s") + ": "
      + stale.map((a) => staleEntry(a, quotes, health)).join(", "));
  }
  const missing = excluded.filter((a) => states[a] === "missing");
  // Missing because the provider is down says so, rather than claiming the asset does not exist.
  /** @type {string[]} */
  const down = [];
  for (const a of missing) {
    const id = providerFor(a).id;
    const h = health[id];
    if (isFailing(h) && !down.includes(id)) {
      down.push(id);
      lines.push(providerName(id) + " unavailable since " + formatClock(h.failingSince));
    }
  }
  const notFound = missing.filter((a) => attempted(a, health) && !isFailing(health[providerFor(a).id])).map(shortName);
  const noRate = excluded.filter((a) => states[a] !== "missing").map(shortName);
  if (notFound.length > 0) lines.push(notFound.join(", ") + " not found, not included");
  if (noRate.length > 0) lines.push(noRate.join(", ") + " has no exchange rate, not included");
  return lines.join("\n");
}

/**
 * The frame for one entry of the `bar` setting.
 * @param {string} item "portfolio" or an asset reference.
 * @param {object} data
 * @param {Record<string, import("./types.mjs").Quote>} data.quotes
 * @param {Record<string, string>} data.states
 * @param {import("./portfolio.mjs").PortfolioView} data.portfolio
 * @param {Record<string, import("./types.mjs").Health>} data.providerHealth
 * @param {string} data.baseCurrency
 * @param {boolean} data.nativePrices Asset prices in their own currency (see displayPrice).
 * Missing assets show "…" until their provider's first fetch attempt completes; after a
 * failed attempt they show "—" and the tooltip names the provider outage.
 * @returns {BarFrame}
 */
export function barFrame(item, data) {
  const { quotes, states, portfolio, providerHealth, baseCurrency } = data;

  if (item === "portfolio") {
    const valued = portfolio.positions.filter((p) => p.value !== null);
    const allClosed = valued.length > 0 && valued.every((p) => p.state === "closed");
    const warn = portfolio.stale.length > 0 || portfolio.excluded.length > 0;
    const tooltip = explain(portfolio.stale, portfolio.excluded, states, quotes, providerHealth);
    if (valued.length === 0) {
      const waiting = portfolio.positions.some((p) => !attempted(p.asset, providerHealth));
      return { label: PORTFOLIO_GLYPH, value: waiting ? "…" : DASH, change: "", direction: "flat", state: "missing", warn, tooltip };
    }
    const change = formatChange(portfolio.dayChangePct);
    return {
      label: PORTFOLIO_GLYPH,
      value: formatBarValue(portfolio.total),
      change,
      direction: changeDirection(change),
      state: /** @type {BarFrame["state"]} */ (allClosed ? "closed" : (portfolio.stale.length > 0 ? "stale" : "live")),
      warn,
      tooltip,
    };
  }

  const quote = quotes[item];
  const state = states[item] || "missing";
  if (!quote || state === "missing") {
    const waiting = !attempted(item, providerHealth);
    return {
      label: shortName(item),
      value: waiting ? "…" : DASH,
      change: "",
      direction: "flat",
      state: "missing",
      warn: false,
      tooltip: waiting ? "" : explain([], [item], { [item]: "missing" }, quotes, providerHealth),
    };
  }
  const change = quote.previousClose > 0 ? formatChange((quote.price - quote.previousClose) / quote.previousClose * 100) : DASH;
  const shown = displayPrice(quote.price, quote.currency, baseCurrency, quotes, data.nativePrices);
  // A live price converted at a stale rate is a stale number; a closed one stays closed, as
  // the portfolio frame does, and carries the warning.
  const stale = staleBehind(item, shown.via, states);
  return {
    label: assetLabel(quote),
    value: formatBarPrice(shown.amount, shown.currency, baseCurrency),
    change,
    direction: changeDirection(change),
    state: /** @type {BarFrame["state"]} */ (state === "live" && stale.length > 0 ? "stale" : state),
    warn: stale.length > 0,
    tooltip: stale.length > 0 ? explain(stale, [], states, quotes, providerHealth) : "",
  };
}
