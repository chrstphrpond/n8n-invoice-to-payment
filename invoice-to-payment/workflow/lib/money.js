// Money in integer minor units (centavos, cents, yen). No float ever touches an amount: quantities are parsed
// from their decimal text into thousandths, products and divisions use BigInt, rounding is half up, once.

const MAX_MINOR_AMOUNT = 1000000000000;
const MAX_QUANTITY_MILLI = 1000000000;

// "1.5" or 1.5 -> 1500. Up to 3 decimals, more than 0, at most 1,000,000. Anything else -> null.
function quantityMilli(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return null;
  const match = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!match) return null;
  const milli = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
  return milli > 0 && milli <= MAX_QUANTITY_MILLI ? milli : null;
}

function isMinorAmount(value, min) {
  return Number.isSafeInteger(value) && value >= (min === undefined ? 0 : min) && value <= MAX_MINOR_AMOUNT;
}

// numerator / denominator rounded half up, for numerator >= 0, denominator > 0 (BigInt in, BigInt out).
function divRoundHalfUp(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function toSafeNumber(big, what) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(what + ' is too large');
  return Number(big);
}

// lines: [{ description, quantity, unit_price_minor, tax_code }], taxRates: { CODE: { rate_bp, label } }.
// Line net = unit price x quantity, rounded half up to the minor unit. Tax is computed once per tax code on the
// summed net of its lines (rate in basis points), rounded half up. Returns { ok, errors, totals }.
function computeTotals(lines, taxRates) {
  const errors = [];
  const out = [];
  const groups = {};
  (lines || []).forEach((line, index) => {
    const at = 'line_items[' + index + ']';
    const milli = quantityMilli(line.quantity);
    if (milli === null) errors.push(at + '.quantity must be a number above 0 with at most 3 decimals');
    if (!isMinorAmount(line.unit_price_minor)) errors.push(at + '.unit_price_minor must be a whole number of minor units');
    const rate = taxRates && Object.prototype.hasOwnProperty.call(taxRates, line.tax_code) ? taxRates[line.tax_code] : null;
    if (!rate || !Number.isSafeInteger(rate.rate_bp) || rate.rate_bp < 0 || rate.rate_bp > 10000) errors.push(at + '.tax_code ' + JSON.stringify(line.tax_code) + ' is not a configured tax rate');
    if (milli === null || !isMinorAmount(line.unit_price_minor) || !rate) return;
    const net = toSafeNumber(divRoundHalfUp(BigInt(line.unit_price_minor) * BigInt(milli), 1000n), at + ' net');
    out.push({ description: line.description, quantity_milli: milli, unit_price_minor: line.unit_price_minor, net_minor: net, tax_code: line.tax_code });
    groups[line.tax_code] = (groups[line.tax_code] || 0n) + BigInt(net);
  });
  if (errors.length) return { ok: false, errors, totals: null };
  const taxLines = Object.keys(groups).sort().map(code => {
    const rate = taxRates[code];
    const tax = divRoundHalfUp(groups[code] * BigInt(rate.rate_bp), 10000n);
    return { tax_code: code, label: rate.label || code, rate_bp: rate.rate_bp, net_minor: toSafeNumber(groups[code], 'net'), tax_minor: toSafeNumber(tax, 'tax') };
  });
  const subtotal = out.reduce((sum, line) => sum + line.net_minor, 0);
  const tax = taxLines.reduce((sum, line) => sum + line.tax_minor, 0);
  const total = subtotal + tax;
  if (total > MAX_MINOR_AMOUNT) return { ok: false, errors: ['the invoice total is larger than the service accepts'], totals: null };
  if (total <= 0) return { ok: false, errors: ['the invoice total must be above 0'], totals: null };
  return { ok: true, errors: [], totals: { lines: out, tax_lines: taxLines, subtotal_minor: subtotal, tax_minor: tax, total_minor: total } };
}

// 1234567, 'PHP', 2 -> "PHP 12,345.67";  5000, 'JPY', 0 -> "JPY 5,000". Integer arithmetic only.
function formatMoney(minor, currency, minorUnits) {
  const units = minorUnits === undefined ? 2 : minorUnits;
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(units + 1, '0');
  const whole = units ? digits.slice(0, -units) : digits;
  const fraction = units ? '.' + digits.slice(-units) : '';
  return (negative ? '-' : '') + currency + ' ' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction;
}

// 1500 -> "1.5", 2000 -> "2".
function formatQuantity(milli) {
  const whole = Math.floor(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : String(whole);
}

function minorUnitsOf(config, currency) {
  const entry = config && config.currencies && config.currencies[currency];
  return entry && Number.isInteger(entry.minor_units) ? entry.minor_units : null;
}

function moneyIn(config, minor, currency) {
  return formatMoney(minor, currency, minorUnitsOf(config, currency) === null ? 2 : minorUnitsOf(config, currency));
}
