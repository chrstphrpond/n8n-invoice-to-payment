// The CRIT invoice template (HTML for the rendering service) and the three emails, in the Resend request shape
// ({ from, to, subject, html, text, attachments, tags }). Every value from the data is escaped.

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const INVOICE_CSS = [
  '@page { size: A4; margin: 16mm; }',
  ':root { --ink: #18181b; --muted: #5f5f66; --rule: #d9d6cf; --paper: #fbfaf7; --accent: #b4441f; }',
  '* { box-sizing: border-box; }',
  'body { margin: 0; background: var(--paper); color: var(--ink); font: 10.5pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; }',
  '.sheet { padding: 4mm 2mm; }',
  'header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2pt solid var(--ink); padding-bottom: 6mm; }',
  '.mark { font-size: 30pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1; }',
  '.mark small { display: block; margin-top: 2mm; font-size: 8.5pt; font-weight: 400; letter-spacing: 0; color: var(--muted); }',
  '.doc { text-align: right; }',
  '.doc h1 { margin: 0; font-size: 16pt; font-weight: 600; }',
  '.doc .number { font-size: 11pt; font-variant-numeric: tabular-nums; }',
  '.meta { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 4mm; margin: 7mm 0; }',
  '.meta dt { font-size: 8pt; color: var(--muted); margin-bottom: 1mm; }',
  '.meta dd { margin: 0; font-weight: 600; }',
  'table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }',
  'th { text-align: left; font-size: 8pt; font-weight: 600; color: var(--muted); border-bottom: 1pt solid var(--ink); padding: 2mm 0; }',
  'td { padding: 2.4mm 0; border-bottom: 0.5pt solid var(--rule); vertical-align: top; }',
  '.num { text-align: right; white-space: nowrap; }',
  '.totals { width: 46%; margin: 5mm 0 0 auto; }',
  '.totals td { border: 0; padding: 1.2mm 0; }',
  '.totals .due td { border-top: 1.5pt solid var(--ink); padding-top: 3mm; font-size: 13pt; font-weight: 700; }',
  '.totals .due .num { color: var(--accent); }',
  '.pay { margin-top: 9mm; padding-top: 4mm; border-top: 0.5pt solid var(--rule); max-width: 120mm; }',
  '.pay h2 { margin: 0 0 1.5mm; font-size: 9pt; }',
  'footer { margin-top: 12mm; font-size: 8pt; color: var(--muted); }',
].join('\n');

// invoice: the stored row; client: { name }; seller: config.seller.
function renderInvoiceHtml(invoice, client, config) {
  const seller = config.seller;
  const units = minorUnitsOf(config, invoice.currency);
  const money = minor => escapeHtml(formatMoney(minor, invoice.currency, units));
  const lines = invoice.line_items.map(line => '<tr><td>' + escapeHtml(line.description) + '</td><td class="num">' + escapeHtml(formatQuantity(line.quantity_milli))
    + '</td><td class="num">' + money(line.unit_price_minor) + '</td><td class="num">' + escapeHtml(line.tax_code) + '</td><td class="num">' + money(line.net_minor) + '</td></tr>').join('\n');
  const taxes = invoice.tax_lines.map(tax => '<tr><td>' + escapeHtml(tax.label) + ' on ' + money(tax.net_minor) + '</td><td class="num">' + money(tax.tax_minor) + '</td></tr>').join('\n');
  const parts = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Invoice ' + escapeHtml(invoice.number) + '</title><style>' + INVOICE_CSS + '</style></head>',
    '<body><div class="sheet">',
    '<header><div class="mark">' + escapeHtml(seller.name) + '<small>' + escapeHtml(seller.website) + ' &middot; ' + escapeHtml(seller.email) + '</small></div>',
    '<div class="doc"><h1>Invoice</h1><div class="number">' + escapeHtml(invoice.number) + '</div></div></header>',
    '<dl class="meta"><div><dt>Billed to</dt><dd>' + escapeHtml(client.name) + '</dd></div>',
    '<div><dt>Issued</dt><dd>' + escapeHtml(displayDate(invoice.issue_date)) + '</dd></div>',
    '<div><dt>Due</dt><dd>' + escapeHtml(displayDate(invoice.due_date)) + '</dd></div>',
    '<div><dt>PO number</dt><dd>' + escapeHtml(invoice.po_number || 'None') + '</dd></div></dl>',
    '<table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead>',
    '<tbody>' + lines + '</tbody></table>',
    '<table class="totals"><tbody><tr><td>Subtotal</td><td class="num">' + money(invoice.subtotal_minor) + '</td></tr>',
    taxes,
    '<tr class="due"><td>Amount due</td><td class="num">' + money(invoice.total_minor) + '</td></tr></tbody></table>',
    '<section class="pay"><h2>How to pay</h2><p>' + escapeHtml(config.payment_terms) + ' Reference: <strong>' + escapeHtml(invoice.number) + '</strong>.</p></section>',
    '<footer>' + escapeHtml(seller.legal_name) + ' &middot; ' + seller.address_lines.map(escapeHtml).join(' &middot; ') + ' &middot; ' + escapeHtml(seller.tax_id) + '</footer>',
    '</div></body></html>',
  ];
  return parts.join('\n');
}

function emailHtml(paragraphs) {
  return '<!doctype html><html><body style="margin:0;padding:24px;background:#fbfaf7;color:#18181b;font:15px/1.5 Helvetica,Arial,sans-serif">'
    + paragraphs.map(text => '<p style="margin:0 0 14px;max-width:560px">' + escapeHtml(text) + '</p>').join('')
    + '</body></html>';
}

function emailBody(from, to, subject, paragraphs, tags, attachments) {
  const body = { from, to: [to], subject, html: emailHtml(paragraphs), text: paragraphs.join('\n\n'), tags };
  if (attachments) body.attachments = attachments;
  return body;
}

function signOff(config) {
  return 'Thank you,\n' + config.seller.name + '\n' + config.seller.email + ' · ' + config.seller.website;
}

function invoiceEmailBody(invoice, client, config, from, pdfBase64) {
  const total = moneyIn(config, invoice.total_minor, invoice.currency);
  return emailBody(from, client.email, 'Invoice ' + invoice.number + ' from ' + config.seller.name + ': ' + total + ' due ' + displayDate(invoice.due_date), [
    'Hello ' + client.name + ',',
    'Invoice ' + invoice.number + ' for ' + total + ' is attached. It is due on ' + displayDate(invoice.due_date) + '.',
    config.payment_terms + ' Reference: ' + invoice.number + '.',
    signOff(config),
  ], [{ name: 'kind', value: 'invoice' }, { name: 'invoice_id', value: invoice.id }], [{ filename: invoice.number + '.pdf', content: pdfBase64, content_type: 'application/pdf' }]);
}

function receiptEmailBody(invoice, client, payment, config, from) {
  const amount = moneyIn(config, payment.amount_minor, payment.currency);
  return emailBody(from, client.email, 'Payment received for ' + invoice.number + ': ' + amount, [
    'Hello ' + client.name + ',',
    'We received ' + amount + ' on ' + displayDate(payment.received_at.slice(0, 10)) + ' with reference ' + payment.reference + '. Invoice ' + invoice.number + ' (' + moneyIn(config, invoice.total_minor, invoice.currency) + ') is paid in full.',
    signOff(config),
  ], [{ name: 'kind', value: 'receipt' }, { name: 'invoice_id', value: invoice.id }]);
}

function reminderEmailBody(invoice, client, reminder, config, from) {
  const balance = moneyIn(config, reminder.balance_minor, invoice.currency);
  return emailBody(from, client.email, 'Reminder: invoice ' + invoice.number + ' is ' + reminder.days_overdue + ' days overdue', [
    'Hello ' + client.name + ',',
    'Invoice ' + invoice.number + ' was due on ' + displayDate(invoice.due_date) + '. ' + balance + ' is still open.',
    config.payment_terms + ' Reference: ' + invoice.number + '. If you have paid in the last few days, thank you, and please ignore this reminder.',
    signOff(config),
  ], [{ name: 'kind', value: 'reminder' }, { name: 'invoice_id', value: invoice.id }, { name: 'step', value: 'd' + reminder.step_days }]);
}
