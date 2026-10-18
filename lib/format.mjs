// Display formatting for prices, money and changes. Pure ECMAScript: it also runs
// inside QML's JS engine, so numbers are formatted by hand rather than via Intl.

/** @typedef {import("./types.mjs").Quote} Quote */

/** @type {Record<string, string>} */
const DOLLAR_PREFIX = { USD: "US$", AUD: "A$", CAD: "C$", NZD: "NZ$", SGD: "S$", HKD: "HK$" };
/** @type {Record<string, string>} */
const SYMBOL_PREFIX = { EUR: "€", GBP: "£", JPY: "¥", CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr", INR: "₹" };
const DASH = "—";

/** @param {string} digits Non-negative integer digits. */
function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a non-negative number with the price precision rules (see formatPrice).
 * @param {number} abs
 * @param {string} ccy
 */
function formatMagnitude(abs, ccy) {
  let decimals;
  if (abs >= 1000) decimals = 0;
  else if (abs >= 1) decimals = ccy === "JPY" ? 0 : 2;
  else decimals = abs === 0 ? 2 : 3 - Math.floor(Math.log10(abs));
  const [whole, frac] = abs.toFixed(Math.min(decimals, 20)).split(".");
  return groupThousands(whole) + (frac ? "." + frac : "");
}

/**
 * Currency prefix for amounts in `ccy`, shown on a display whose base currency is `base`.
 * Dollar currencies are a bare "$" when they are the base and qualified ("US$", "A$") otherwise.
 * An unknown currency yields its code followed by a space.
 * @param {string} ccy
 * @param {string} base
 */
export function currencyPrefix(ccy, base) {
  if (ccy in DOLLAR_PREFIX) return ccy === base ? "$" : DOLLAR_PREFIX[ccy];
  if (ccy in SYMBOL_PREFIX) return SYMBOL_PREFIX[ccy];
  return ccy + " ";
}

/**
 * Rounds to whole units; `negative` is false when the result rounds to zero.
 * @param {number} amount
 */
function wholeUnits(amount) {
  const abs = Math.round(Math.abs(amount));
  return { abs, negative: amount < 0 && abs > 0 };
}

/**
 * A money amount in whole currency units with thousands separators, e.g. "-A$1,234".
 * Amounts that round to zero have no minus sign. Non-finite amounts render as a dash.
 * @param {number} amount
 * @param {string} ccy
 * @param {string} base
 */
export function formatMoney(amount, ccy, base) {
  if (!Number.isFinite(amount)) return DASH;
  const { abs, negative } = wholeUnits(amount);
  return (negative ? "-" : "") + currencyPrefix(ccy, base) + groupThousands(String(abs));
}

/**
 * A unit price: no decimals from 1000 up, 2 decimals from 1 up (0 for JPY),
 * and 4 significant digits below 1. Non-finite or negative prices render as a dash.
 * @param {number} price
 * @param {string} ccy
 * @param {string} base
 */
export function formatPrice(price, ccy, base) {
  if (!Number.isFinite(price) || price < 0) return DASH;
  return currencyPrefix(ccy, base) + formatMagnitude(price, ccy);
}

/**
 * Compact number for the bar, no currency. Shown in full (with "," separators)
 * when that is at most 7 characters, otherwise as k/M/B/T with up to 4 significant
 * digits and trailing zeros trimmed (412300 → "412,300", 1234567 → "1.235M",
 * 2450000 → "2.45M"). Non-finite input renders as a dash.
 * @param {number} n
 */
export function formatBarValue(n) {
  if (!Number.isFinite(n)) return DASH;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const full = sign + formatMagnitude(abs, "");
  // Below 1000 the full form is always kept: sub-1 prices need their small digits.
  if (abs < 1000 || full.length <= 7) return full;
  return sign + compactMagnitude(abs);
}

/**
 * A price for the bar: formatBarValue's number, preceded by currencyPrefix when `ccy` is not
 * the base currency ("US$82,699" with base AUD) and plain when it is ("82,699"). The prefix is
 * not counted in the 7-character rule. Non-finite input renders as a bare dash.
 * @param {number} amount
 * @param {string} ccy
 * @param {string} base
 */
export function formatBarPrice(amount, ccy, base) {
  if (!Number.isFinite(amount)) return DASH;
  return (ccy === base ? "" : currencyPrefix(ccy, base)) + formatBarValue(amount);
}

/**
 * A number of at least 1000 as k/M/B/T with up to 4 significant digits, trailing zeros
 * trimmed ("117.7k", "2.45M").
 * @param {number} abs
 */
function compactMagnitude(abs) {
  const units = ["k", "M", "B", "T"];
  let unit = 0;
  let scaled = abs / 1e3;
  // Rounding to 4 significant digits can reach 1000, which belongs in the next unit.
  while (unit < units.length - 1 && Number(scaled.toPrecision(4)) >= 1000) {
    scaled /= 1e3;
    unit++;
  }
  return Number(scaled.toPrecision(4)) + units[unit];
}

/**
 * Percentage change as an arrow, a space and one decimal, e.g. "▲ 1.4%".
 * A change that rounds to 0.0 is flat ("— 0.0%"); null or non-finite input is a bare dash.
 * @param {number|null|undefined} pct
 */
export function formatChange(pct) {
  if (pct == null || !Number.isFinite(pct)) return DASH;
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  if (rounded === 0) return DASH + " 0.0%";
  return (pct > 0 ? "▲" : "▼") + " " + rounded.toFixed(1) + "%";
}

/**
 * Like formatMoney but with an explicit "+" for gains, e.g. "+$16,630".
 * Amounts that round to zero are unsigned ("$0").
 * @param {number} amount
 * @param {string} ccy
 * @param {string} base
 */
export function formatSigned(amount, ccy, base) {
  const text = formatMoney(amount, ccy, base);
  return Number.isFinite(amount) && amount > 0 && wholeUnits(amount).abs > 0 ? "+" + text : text;
}

/**
 * Short label for the bar: "₿" for bitcoin, the ticker symbol otherwise.
 * @param {Pick<Quote, "asset"|"symbol">} quote
 */
export function assetLabel(quote) {
  return quote.asset === "crypto:bitcoin" ? "₿" : quote.symbol;
}

/**
 * Which way a formatChange text points: "up" for "▲", "down" for "▼", "flat" otherwise
 * (a flat move or a bare dash).
 * @param {string} change
 * @returns {"up"|"down"|"flat"}
 */
export function changeDirection(change) {
  return change.startsWith("▲") ? "up" : change.startsWith("▼") ? "down" : "flat";
}

/**
 * Which way a percentage change reads once displayed: "flat" when it rounds to 0.0 at one
 * decimal (or is null), so colours never disagree with the "— 0.0%" text.
 * @param {number|null|undefined} pct
 * @returns {"up"|"down"|"flat"}
 */
export function pctDirection(pct) {
  return changeDirection(formatChange(pct));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {number} n */
const pad2 = (n) => (n < 10 ? "0" : "") + n;

/**
 * Short weekday ("Fri") of an epoch-ms time, in local time.
 * @param {number} ms
 */
export function formatWeekday(ms) {
  return DAYS[new Date(ms).getDay()];
}

/**
 * Short weekday ("Fri") of an epoch-ms time as seen at a place `utcOffsetSeconds` from
 * UTC (an exchange's own calendar day), or in local time when the offset is unknown.
 * @param {number} ms
 * @param {number|undefined} utcOffsetSeconds
 */
export function formatWeekdayAt(ms, utcOffsetSeconds) {
  if (typeof utcOffsetSeconds !== "number" || !Number.isFinite(utcOffsetSeconds)) return formatWeekday(ms);
  return DAYS[new Date(ms + utcOffsetSeconds * 1000).getUTCDay()];
}

/**
 * 24-hour local time of an epoch-ms time, e.g. "14:02".
 * @param {number} ms
 */
export function formatClock(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/**
 * Weekday and local time, e.g. "Fri 16:00".
 * @param {number} ms
 */
export function formatDayClock(ms) {
  return formatWeekday(ms) + " " + formatClock(ms);
}

/**
 * Local calendar date of an epoch-ms time as day and short month, e.g. "12 Oct", followed by
 * the year when `withYear` ("12 Oct 2025").
 * @param {number} ms
 * @param {boolean} withYear
 */
export function formatDate(ms, withYear) {
  const d = new Date(ms);
  const date = d.getDate() + " " + MONTHS[d.getMonth()];
  return withYear ? date + " " + d.getFullYear() : date;
}

/**
 * A past time as briefly as is unambiguous: "16:00" when it falls on the same
 * local calendar day as `now`, "Fri 16:00" otherwise.
 * @param {number} ms
 * @param {number} now
 */
export function formatWhen(ms, now) {
  return new Date(ms).toDateString() === new Date(now).toDateString() ? formatClock(ms) : formatDayClock(ms);
}

/**
 * A holding quantity: up to 8 decimals with trailing zeros dropped and thousands
 * separators, e.g. "12", "30.512", "0.05", "1,250.5". Non-finite input renders as a dash.
 * @param {number} quantity
 */
export function formatQuantity(quantity) {
  if (!Number.isFinite(quantity)) return DASH;
  const sign = quantity < 0 ? "-" : "";
  const [whole, frac] = Math.abs(quantity).toFixed(8).split(".");
  const trimmed = frac.replace(/0+$/, "");
  const text = groupThousands(whole) + (trimmed ? "." + trimmed : "");
  return text === "0" ? "0" : sign + text;
}

/** Longest day range shown in full: what a third of the panel holds. */
const DAY_RANGE_MAX = 13;

/**
 * A low–high price range in `ccy` without a currency prefix, e.g. "712.54–716.43",
 * each end with formatPrice's precision. When that is longer than 13 characters, ends
 * from 1000 up are compact instead ("117.7k–119.4k"). A dash when either end is not a
 * valid price.
 * @param {number} low
 * @param {number} high
 * @param {string} ccy
 */
export function formatDayRange(low, high, ccy) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < 0) return DASH;
  const full = formatMagnitude(low, ccy) + "–" + formatMagnitude(high, ccy);
  if (full.length <= DAY_RANGE_MAX) return full;
  const end = (/** @type {number} */ n) => (n >= 1000 ? compactMagnitude(n) : formatMagnitude(n, ccy));
  return end(low) + "–" + end(high);
}
