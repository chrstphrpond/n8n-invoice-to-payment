// The invoicing stand-ins for tests and the local editor: the data service (kit, plus the sequence and update
// calls in billing-data.mjs) with this workflow set's tables, config and seeded client list, the PDF renderer,
// object storage, the Resend-shaped email API and the payment processor's refund call. The kit adds the Slack
// stand-in (alerts and the billing review channel).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billingDataService } from './billing-data.mjs';
import { emailApi, objectStorage, paymentsApi, pdfRenderer } from './vendors.mjs';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const CONFIG = JSON.parse(readFileSync(join(fixturesDir, 'config.json'), 'utf8'));
export const CLIENTS = JSON.parse(readFileSync(join(fixturesDir, 'clients.json'), 'utf8')).clients;
export const CONFIG_NAME = 'invoice-to-payment';
export const BUCKET = 'crit-invoices';

// Table shapes; the Postgres version is in SPEC.md. Unique keys are enforced like a database would. money_seq on an
// invoice is the counter every money write is guarded by; on a payment or refund row it is the value after that write.
export const TABLES = {
  clients: { columns: ['client_id', 'name', 'email', 'currency', 'status'], unique: [['client_id']] },
  invoice_numbers: { columns: ['sequence', 'value', 'key'], unique: [['sequence', 'value'], ['sequence', 'key']] },
  invoices: {
    columns: ['request_event_id', 'number', 'sequence', 'sequence_value', 'client_id', 'currency', 'issue_date', 'due_date', 'po_number',
      'line_items', 'tax_lines', 'subtotal_minor', 'tax_minor', 'total_minor', 'status', 'pdf_key', 'pdf_sha256', 'pdf_bytes', 'email_id',
      'void_event_id', 'void_reason', 'receipt_email_id', 'paid_at', 'money_seq', 'email_started_at'],
    unique: [['request_event_id'], ['number']],
  },
  payments: {
    columns: ['event_id', 'processor_payment_id', 'reference', 'invoice_id', 'invoice_number', 'amount_minor', 'currency', 'received_at', 'match', 'counted', 'excess_minor', 'paid_after_minor', 'money_seq'],
    unique: [['event_id'], ['processor_payment_id']],
  },
  refunds: {
    columns: ['event_id', 'invoice_id', 'invoice_number', 'amount_minor', 'currency', 'reason', 'status', 'processor_refund_id', 'money_seq'],
    unique: [['event_id']],
  },
  reminders: {
    columns: ['invoice_id', 'invoice_number', 'step_days', 'as_of', 'days_overdue', 'balance_minor', 'currency', 'email_id', 'status'],
    unique: [['invoice_id', 'step_days']],
  },
  review_items: {
    columns: ['source_event_id', 'kind', 'invoice_id', 'invoice_number', 'payment_id', 'amount_minor', 'currency', 'detail'],
    unique: [['source_event_id', 'kind']],
  },
};

// secrets: { data, pdf, storage, email, payments } tokens for the stand-ins.
export function invoiceModules({ secrets, clock }) {
  return [
    billingDataService({ token: secrets.data, tables: TABLES, config: { [CONFIG_NAME]: CONFIG }, seed: { clients: CLIENTS }, clock }),
    pdfRenderer({ token: secrets.pdf }),
    objectStorage({ token: secrets.storage }),
    emailApi({ key: secrets.email }),
    paymentsApi({ key: secrets.payments }),
  ];
}
