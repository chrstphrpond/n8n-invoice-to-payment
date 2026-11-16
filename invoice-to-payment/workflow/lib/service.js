// Reading the data service's answers. An answer that is not what the call promises stops the run (it fails into
// the error workflow) instead of being guessed at.

const CONFIG_KEYS = ['timezone', 'seller', 'number_prefix', 'number_digits', 'currencies', 'tax_rates', 'max_line_items', 'max_pdf_bytes', 'payment_terms', 'reminder_steps_days', 'stuck_after_minutes'];

function checkedConfig(answer) {
  const config = answer && answer.config;
  const missing = CONFIG_KEYS.filter(key => !config || config[key] === undefined);
  if (missing.length) throw new Error('Config invoice-to-payment is missing: ' + missing.join(', '));
  if (!Array.isArray(config.reminder_steps_days) || !config.reminder_steps_days.every(step => Number.isInteger(step) && step > 0)) throw new Error('Config reminder_steps_days must be whole days above 0');
  return config;
}

function rowsOf(answer, what) {
  if (!answer || !Array.isArray(answer.rows)) throw new Error('The data service did not answer the ' + what + ' lookup with rows');
  return answer.rows;
}

function rowOf(answer, what) {
  if (!answer || !answer.row || typeof answer.row.id !== 'string') throw new Error('The data service did not return the ' + what + ' row');
  return answer.row;
}

// The invoice fields a run carries around (ids and amounts; the line items stay in the data service).
function invoiceRef(invoice) {
  return { id: invoice.id, number: invoice.number, client_id: invoice.client_id, total_minor: invoice.total_minor, currency: invoice.currency, status: invoice.status, due_date: invoice.due_date };
}

function claimOutcome(answer) {
  if (!answer || !['claimed', 'in_flight', 'done'].includes(answer.outcome)) throw new Error('The ledger answered a claim with ' + JSON.stringify(answer && answer.outcome));
  return answer.outcome;
}
