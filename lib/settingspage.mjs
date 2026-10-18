// What the settings page decides: list edits for `bar` and `watch`, reading
// typed numbers, the settings entry it writes, and how it names assets. Pure:
// the page passes values in and only draws and saves the result.

import { PORTFOLIO_GLYPH } from "./barframe.mjs";
import { rowLabel } from "./panel.mjs";

/** @typedef {import("./types.mjs").AssetRef} AssetRef */
/** @typedef {import("./types.mjs").Kind} Kind */
/** @typedef {import("./types.mjs").Quote} Quote */

/** The `bar` item that stands for the portfolio total. */
export const PORTFOLIO_ITEM = "portfolio";

/**
 * Returns a copy of `list` with the entry at `from` moved to `to`, both clamped
 * into the list, so a drag past either end lands on that end.
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} to
 * @returns {T[]}
 */
export function moveItem(list, from, to) {
  const out = list.slice();
  if (out.length === 0) return out;
  const last = out.length - 1;
  const src = Math.max(0, Math.min(last, Math.round(from)));
  const dst = Math.max(0, Math.min(last, Math.round(to)));
  const moved = out.splice(src, 1)[0];
  out.splice(dst, 0, moved);
  return out;
}

/**
 * Returns a copy of `list` with `item` appended, or the copy unchanged when it is
 * already there.
 * @param {string[]} list
 * @param {string} item
 * @returns {string[]}
 */
export function withItem(list, item) {
  return list.indexOf(item) >= 0 ? list.slice() : list.concat([item]);
}

/**
 * Returns a copy of `list` without `item` (every occurrence).
 * @param {string[]} list
 * @param {string} item
 * @returns {string[]}
 */
export function withoutItem(list, item) {
  return list.filter((x) => x !== item);
}

/**
 * Returns a copy of `list` with `item` removed when present, appended when not:
 * what a row's bar button does.
 * @param {string[]} list
 * @param {string} item
 * @returns {string[]}
 */
export function toggleItem(list, item) {
  return list.indexOf(item) >= 0 ? withoutItem(list, item) : withItem(list, item);
}

// Whole digits, either plain or in proper groups of three ("61,000", as
// formatQuantity writes them). A comma anywhere else is refused rather than
// dropped, so a decimal comma ("1,5") never reads as a number ten times larger.
const WHOLE = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const AMOUNT = new RegExp(`^(?:${WHOLE}(?:\\.\\d*)?|\\.\\d+)$`);
const SECONDS = new RegExp(`^${WHOLE}$`);

/**
 * A quantity or cost as typed: a plain non-negative decimal, with optional
 * surrounding space and "," thousands separators in groups of three
 * ("1,250.5"). Null for anything else (empty, negative, exponent, letters, a
 * decimal comma such as "1,5"), which the page answers by putting the stored
 * value back.
 * @param {string} text
 * @returns {number|null}
 */
export function parseAmount(text) {
  const trimmed = String(text).trim();
  if (!AMOUNT.test(trimmed)) return null;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * A whole number of seconds as typed into an interval field (thousands
 * separators only in groups of three), raised to `min` when below it and
 * lowered to `max` when above. Null when the text is not such a number (the
 * field then shows the stored value again). `snapped` says whether the value
 * was raised, so the page can say why; lowering is not reported. The cap keeps
 * a long typed number from overflowing a Qt Timer interval (a 32-bit count of
 * milliseconds).
 * @param {string} text
 * @param {number} min
 * @param {number} [max] no ceiling when left out
 * @returns {{seconds: number, snapped: boolean}|null}
 */
export function snapSeconds(text, min, max = Infinity) {
  const trimmed = String(text).trim();
  if (!SECONDS.test(trimmed)) return null;
  const n = Number(trimmed.replace(/,/g, ""));
  if (!Number.isSafeInteger(n)) return null;
  return n < min ? { seconds: min, snapped: true } : { seconds: Math.min(n, max), snapped: false };
}

/**
 * The widget's settings entry with `patch` applied: `id` first, then the
 * current keys (any other id dropped), then the patched ones. Values go through
 * JSON, so lists handed over by the host as Qt sequences come out as real
 * arrays and nothing but JSON is ever written.
 * @param {string} id
 * @param {unknown} current The entry as it stands (may be null).
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
export function settingsEntry(id, current, patch) {
  /** @type {Record<string, unknown>} */
  const out = { id };
  const plain = current !== null && typeof current === "object" ? JSON.parse(JSON.stringify(current)) : {};
  const copy = (/** @type {Record<string, unknown>} */ from) => {
    for (const key of Object.keys(from)) if (key !== "id") out[key] = from[key];
  };
  copy(plain !== null && typeof plain === "object" && !Array.isArray(plain) ? plain : {});
  copy(JSON.parse(JSON.stringify(patch)));
  return out;
}

/** @type {Record<string, string>} */
const KIND_LABELS = { stock: "stock", etf: "ETF", fund: "fund", crypto: "crypto", fx: "FX", cash: "cash" };

/**
 * The type badge for a search result or list row ("stock", "ETF", "fund",
 * "crypto", "FX", "cash"); empty when the kind is not known.
 * @param {Kind|string|undefined|null} kind
 */
export function kindLabel(kind) {
  return kind ? KIND_LABELS[kind] || "" : "";
}

/**
 * How the bar rotation list names an item: the portfolio total with its glyph,
 * otherwise as the panel's rows do.
 * @param {AssetRef} item
 * @param {Quote|null|undefined} quote
 */
export function itemLabel(item, quote) {
  return item === PORTFOLIO_ITEM ? PORTFOLIO_GLYPH + " Portfolio total" : rowLabel(item, quote);
}

/**
 * `path` with the home directory written as "~" for display.
 * @param {string} path
 * @param {string} home
 */
export function displayPath(path, home) {
  return home !== "" && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/**
 * The directory holding `path` ("/a/b/c.json" -> "/a/b"); "/" for a file at the root.
 * @param {string} path
 */
export function parentDir(path) {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}
