// Validation of user settings. Never throws: every bad value is replaced by a
// default and, where the user would want to know, explained in `notes`.

/** @typedef {import("./types.mjs").Range} Range */

/**
 * @typedef {object} Settings
 * @property {string} baseCurrency One of CURRENCIES.
 * @property {number} refreshSeconds Price refresh interval, at least 60.
 * @property {number} rotateSeconds Bar rotation interval, at least 2.
 * @property {Range} range Default chart range.
 * @property {string[]} bar Assets shown in the bar (never empty).
 * @property {string[]} watch Extra assets in the watchlist.
 * @property {boolean} nativePrices Whether asset prices (the bar's asset items, the watchlist) show in
 *   each asset's own currency rather than converted to baseCurrency. Totals, values and gains are
 *   always in baseCurrency.
 */

export const CURRENCIES = Object.freeze(["USD", "AUD", "EUR", "GBP", "CAD", "NZD", "JPY", "CHF", "SGD", "HKD", "SEK", "NOK", "DKK", "INR"]);

/** Chart ranges the panel can open on, shortest first. */
export const RANGES = Object.freeze(["1D", "1W", "1M", "3M", "6M", "1Y"]);
export const MIN_REFRESH_SECONDS = 60;
export const MIN_ROTATE_SECONDS = 2;
/** Why refreshSeconds cannot go below MIN_REFRESH_SECONDS, as the user reads it. */
export const REFRESH_MIN_NOTE = "60s minimum keeps you within the free price feeds' limits.";

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  baseCurrency: "USD",
  refreshSeconds: MIN_REFRESH_SECONDS,
  rotateSeconds: 5,
  range: /** @type {Range} */ ("1M"),
  bar: ["crypto:bitcoin"],
  watch: [],
  nativePrices: true,
});

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} fallback
 * @param {string} name
 * @param {string} minNote Note added when the value is raised to `min`.
 * @param {string[]} notes
 */
function normalizeSeconds(value, min, fallback, name, minNote, notes) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    notes.push(`${name} must be a number; using ${fallback}.`);
    return fallback;
  }
  if (value < min) {
    notes.push(minNote);
    return min;
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {string[]} notes
 * @returns {string[]} The non-empty string entries; notes any that were dropped.
 */
function stringList(value, name, notes) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    notes.push(`${name} must be a list; ignoring it.`);
    return [];
  }
  const kept = value.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  if (kept.length < value.length) notes.push(`${name}: ignored ${value.length - kept.length} invalid entries.`);
  return kept;
}

/**
 * Turns untrusted raw settings (any JSON value) into valid settings.
 * Currency and range are case-insensitive. refreshSeconds below 60 and rotateSeconds
 * below 2 are raised to the minimum. An empty `bar` falls back to bitcoin so the bar
 * is never blank. A nativePrices that is not a boolean is true. `notes` holds user-facing
 * explanations of every substitution.
 * @param {unknown} raw
 * @returns {{settings: Settings, notes: string[]}}
 */
export function normalizeSettings(raw) {
  /** @type {Record<string, unknown>} */
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  /** @type {string[]} */
  const notes = [];

  let baseCurrency = DEFAULTS.baseCurrency;
  if (input.baseCurrency !== undefined) {
    const code = typeof input.baseCurrency === "string" ? input.baseCurrency.trim().toUpperCase() : "";
    if (CURRENCIES.includes(code)) baseCurrency = code;
    else notes.push(`Unknown currency ${JSON.stringify(input.baseCurrency)}; using ${DEFAULTS.baseCurrency}.`);
  }

  /** @type {Range} */
  let range = DEFAULTS.range;
  if (input.range !== undefined) {
    const code = typeof input.range === "string" ? input.range.trim().toUpperCase() : "";
    if (RANGES.includes(code)) range = /** @type {Range} */ (code);
    else notes.push(`Unknown range ${JSON.stringify(input.range)}; using ${DEFAULTS.range}.`);
  }

  const refreshSeconds = normalizeSeconds(input.refreshSeconds, MIN_REFRESH_SECONDS, DEFAULTS.refreshSeconds, "refreshSeconds",
    REFRESH_MIN_NOTE, notes);
  const rotateSeconds = normalizeSeconds(input.rotateSeconds, MIN_ROTATE_SECONDS, DEFAULTS.rotateSeconds, "rotateSeconds",
    "rotateSeconds below 2 is too fast to read; using 2.", notes);

  let bar = stringList(input.bar, "bar", notes);
  if (bar.length === 0) bar = [...DEFAULTS.bar];
  const watch = stringList(input.watch, "watch", notes);

  let nativePrices = DEFAULTS.nativePrices;
  if (input.nativePrices !== undefined) {
    if (typeof input.nativePrices === "boolean") nativePrices = input.nativePrices;
    else notes.push(`nativePrices must be true or false; using ${DEFAULTS.nativePrices}.`);
  }

  return { settings: { baseCurrency, refreshSeconds, rotateSeconds, range, bar, watch, nativePrices }, notes };
}
