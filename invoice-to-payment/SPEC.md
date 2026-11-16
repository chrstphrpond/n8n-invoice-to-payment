# CRIT invoicing: spec

## Problem

A small studio (CRIT, the sender on every invoice) bills its clients and wants invoicing to run without a spreadsheet: an invoice is asked for, numbered, totalled, sent as a PDF, matched to the payment when it arrives, chased when it is late, and voided or refunded only when that is allowed. A retry or a second delivery of any event must never produce a second invoice number, a second PDF or a second email; two events for the same invoice arriving together must never both be decided against the same "before" state; and anything the workflow cannot decide on its own goes to a person, including a send whose outcome is unknown after the providers' 24-hour Idempotency-Key window.

## Workflows

| Workflow | Id | Trigger | Sender and secret |
| --- | --- | --- | --- |
| CRIT · Issue invoices | `critInvoiceIssue` | `POST /webhook/crit/invoices/billing-events` | the studio's own system, `BILLING_WEBHOOK_SECRET` |
| CRIT · Match payments | `critPaymentMatch` | `POST /webhook/crit/invoices/payment-events` | the payment processor, `PAYMENTS_WEBHOOK_SECRET` |
| CRIT · Chase overdue invoices | `critInvoiceChase` | schedule (reminders daily 09:00, watchdog hourly at :20) and `POST /webhook/crit/invoices/sweeps` | an operator or a test, `BILLING_WEBHOOK_SECRET` |
| CRIT · Alert on errors | `critAlertErrors1` | the error workflow of all three (shared kit) | |

One endpoint per sender, each with its own secret: the payment processor cannot ask for an invoice, and the studio's system cannot report a payment.

## Signed events

Every request carries `X-CRIT-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. The HMAC is over the raw bytes as received (the Webhook node's `rawBody` option keeps them) and is compared in constant time; the JSON the workflow uses is parsed from those verified bytes, not from n8n's own parse. Then the timestamp must be within 300 seconds of the clock, in either direction (an authentic but old request is a replay). Several `v1` values are accepted, for a secret rotation. Failures answer 401 with `missing_signature`, `malformed_signature`, `bad_signature`, `stale_timestamp`, `raw_body_missing` or `secret_not_configured`, and nothing else runs.

Envelope: `{ id, type, created_at, data }`. `id` is the sender's event id (1 to 100 of `A-Za-z0-9_.:-`) and the dedupe key.

| Type | data |
| --- | --- |
| `invoice.requested` | `client_id`, `currency` (ISO 4217), `due_date` (YYYY-MM-DD), `issue_date`? (default: the date of `created_at` in the business time zone), `po_number`?, `line_items[1..50]` of `{ description, quantity (up to 3 decimals), unit_price_minor (integer), tax_code }` |
| `invoice.void_requested` | `invoice_number`, `reason`? |
| `refund.requested` | `invoice_number`, `amount_minor` (integer > 0), `currency`, `reason`? |
| `payment.received` | `payment_id` (processor's), `reference` (the invoice number), `amount_minor` (integer > 0), `currency`, `received_at` |
| `sweep.reminders`, `sweep.watchdog` | `as_of`? (ISO time; used only when `INVOICE_CLOCK_OVERRIDE=allow`) |

A broken envelope or data gets 400 with every reason and a `dead_letters` row (unique per payload hash, so the same broken payload twice is stored once). If the dead letter cannot be stored (after 3 retries), the sender still gets the 400, then "Check dead letter stored" fails the run into the error workflow, whose alert carries the payload hash, the event id and the number of reasons (no payload); the payload stays in the failed execution. A well-formed event of another type gets 200 `ignored`. A valid event is claimed in the ledger (scope `billing_event` or `payment_event`, key = event id): `in_flight` answers 409 with `Retry-After: 30`, `done` answers 200 `duplicate` with the first run's outcome.

## Flow by section

### Issue invoices

1. **Intake and trust**: as above.
2. **Check and number.** Config, the client, and any invoice already made for this event (a replay). Business checks before a number is taken: the client exists and is active, the currency is configured and is the client's, the due date is not before the issue date, every tax code is configured, the total is above 0 and below the service limit. A refusal answers **422** `{ status: rejected, reasons }`, takes no number and is recorded in the ledger. Otherwise **202** at once, then a number from the data service sequence `invoice-<year>`: one value per event id, `max + 1`, so the same event always gets the same number and a refused request leaves no gap. The number is `CRIT-<year>-<0000>`. The invoice row is built from the event, the config and the number only.
3. **Render, store and send.** From the stored invoice: `render` (no PDF yet), `email` (PDF stored, not sent) or `finish` (already sent, or voided meanwhile). The CRIT HTML template (`workflow/lib/documents.js`) goes to the rendering service; the PDF bytes are checked (`%PDF-`, size limit) and hashed, PUT to object storage at `invoices/<year>/<number>.pdf`, storage must confirm the same SHA-256, and the invoice records `pdf_key`, `pdf_sha256`, `pdf_bytes` (only while none is recorded). The stored object is read back and checked against the recorded hash before it is attached, so the email carries exactly what storage holds. Right before the send, "Record email start" stamps `email_started_at` with the data service's clock (only while empty, so it keeps the first attempt). The email (Resend's `POST /emails` shape, PDF as a base64 attachment) has `Idempotency-Key: billing-event:<id>:Send invoice email`. A replay that finds `email_started_at` but no `email_id` resends with the same key only if the stamp is less than 23 hours old; otherwise "Check delivery progress" stops the run with the invoice id (error workflow alert) and nothing is sent. The invoice moves `issued -> sent` with the email id (only from `issued`).
4. **Void and refund**, answered at once: void only for `issued` or `sent` invoices with nothing paid (409 `invalid_transition` otherwise, with `from` and `to`); refund only up to paid minus already refunded, in the invoice currency, not on a void invoice (422 `refund_refused` with `refund_exceeds_paid` or `currency_mismatch`, 409 for an unpaid or void invoice, 404 for an unknown number). The invoice is read first, then its payments and refunds. The void and the refund row are guarded writes (see "Money guard"): if `money_seq` moved since the read, the answer is `outcome: conflict`, the run goes back to "Find invoice to change" and decides again (at most 5 passes). A refund row is stored (`approved`) and only then sent to the processor with `Idempotency-Key: billing-event:<id>:Send refund to processor`, and marked `submitted` with the processor's id. The same event again: a void already applied is answered `voided` with nothing written (`void_replay`); a refund row with the processor's id is answered from the row (`refund_replay`); a refund row without it is sent again with the same key (`refund_resume`) only if the row is less than 23 hours old, otherwise the run stops with the refund id.
5. **Finish.** Ledger done with the outcome (non-critical), a summary item with ids only.

### Match payments

1. **Intake and trust**, then **202** at once.
2. **Match and record.** The invoice whose number is the reference, the payments already recorded with that reference, the invoice's refunds. The decision, from the rows before this payment:

   | Match | Counted | Receipt | Review |
   | --- | --- | --- | --- |
   | `exact` (first payment, equals the total) | yes | yes | |
   | `partial` (still short) | yes | | |
   | `completes` (a later payment reaching the total) | yes | yes | |
   | `overpaid` (passes the total) | yes | yes | yes, with the excess |
   | `already_paid` (invoice was already paid in full) | yes | | yes |
   | `wrong_currency` | no | | yes |
   | `unknown_reference` | no | | yes |
   | `invoice_void` | no | | yes |
   | `after_refund` (the invoice has a refund) | no | | yes |

   The payment row stores the decision and is a guarded write (see "Money guard"): if `money_seq` moved since the invoice was read, the run goes back to "Find invoice by reference" and decides again against the rows as they are now (at most 5 passes). So two full payments arriving together are `exact` and `already_paid`, and a partial plus the rest are `partial` and `completes`. A payment with an unknown reference has no invoice to guard and is stored unguarded. A replay finds its own row (by event id) and goes on from it without writing it again, even if other payments arrived since. The same processor `payment_id` under a new event id is `duplicate_payment`: nothing stored, no receipt.
3. **Receipt** when this payment brings the invoice to paid in full, keyed per event, recorded on the invoice (`receipt_email_id`, `paid_at`). The receipt is sent only if the payment row is less than 23 hours old (a replay later than that stops with the payment id instead).
4. **Review**: a `review_items` row and a message to `REVIEW_SLACK_CHANNEL` with ids and amounts only. The message is non-critical; the item is already stored.
5. **Finish** as above.

The money state is never kept as a running total: paid = sum of counted payments, refunded = sum of refunds, both read from rows when needed (`invoiceMoney` in `workflow/lib/payments.js`).

### Money guard

Every write that changes an invoice's money state carries the invoice's `money_seq` as read before the decision: a payment row, a refund row, a void. The data service applies the write only while `money_seq` still has that value, moves it on by one in the same statement, and records the new value on the payment or refund row. Otherwise nothing is written and the answer is 200 `{ outcome: conflict }`, not an HTTP error, so n8n does not retry the stale request; the run reads again and decides again. Two rules make this sound: the invoice is read before its payment and refund rows (a row written after that read always shows up as a moved counter), and the Idempotency-Key of a guarded write names the counter it was decided against (`<event key>:seq<n>:<node name>`), so a new decision is a new request, never the old key with another body. Each conflict means another write on the invoice succeeded, so the loop ends; 5 passes in a row stop the run into the error workflow. A missing `money_seq` is never read as 0: the write cannot be built.

The email API and the payment processor keep an Idempotency-Key for about 24 hours (Resend documents 24 hours; Stripe-style processors drop keys after at least 24 hours). The stand-ins never expire a key, so the tests reach the window by seeding old timestamps. A send whose answer was lost is resent with the same key only within 23 hours of a time that is never later than the send: the `email_started_at` stamp for invoice emails, the payment row's `created_at` for receipts, the refund row's `created_at` for refunds.

### Chase overdue invoices

1. **Start and clock.** The schedules start a sweep with the real clock (`INVOICE_SCHEDULES=off` stops them in the first node). A signed sweep request answers 202 and may fix the clock with `as_of` when `INVOICE_CLOCK_OVERRIDE=allow`. The run reads the time once and works in the business time zone's date.
2. **Reminders.** Invoices with status `sent` and a due date before today; none is an early exit before anything else is read. Then payments, refunds, reminders already sent and clients. Per invoice, the highest step reached in `reminder_steps_days` (3, 10, 21) is sent only if neither it nor a later step was sent; missed earlier steps are not sent late; paid, over-paid and refunded invoices get nothing (void and undelivered ones are not `sent`). None due is a second early exit. Each reminder is claimed in the ledger (scope `invoice_reminder`, key `<invoice id>:d<step>`), so two overlapping sweeps send it once. A claim taken over from a run that died (`reclaimed`) is not resent: whether its email went out is unknown, so it becomes a review item and an alert. The email is keyed `reminder:<invoice id>:d<step>:Send reminder emails`, the `reminders` row is unique per invoice and step, and the claim is marked done.
3. **Watchdog.** Invoices still `issued` (numbered, not delivered) and numbers taken from the sequence without an invoice row, both older than `stuck_after_minutes` (30). Each is claimed once (scope `stuck_report`) and the new ones go out in one message to `REVIEW_SLACK_CHANNEL`. That post is critical: if it fails, the run fails, the error workflow releases the claims and the next run reports again.

## Data service

The kit's data service (`_shared/lib/data-service.mjs`) plus two calls in `standins/billing-data.mjs`, which share its tables:

| Call | Body | Answer |
| --- | --- | --- |
| `POST /v1/sequences/:name/next` | `{ key }` | `{ value, outcome: allocated \| existing, row }`. Same key, same value. |
| `PATCH /v1/rows/:table/:id` | `{ expect?, set?, stamp?, guard? }` | 200 `{ outcome: changed \| unchanged, row, changed }`; `unchanged` when every `set` field already has its value and every `stamp` column is filled; `stamp` fills the listed columns with the service's clock only while empty; `guard: { column, expect }` applies the update only while that counter equals `expect` and moves it on by one, else 200 `{ outcome: conflict, guard, row }`; 409 `conflict` when an `expect` field differs (a list means one of); 404; 400 for an unknown column. Honors Idempotency-Key. Keeps `updated_at`, `updated_by_run` and a `history` of what was set. |
| `POST /v1/rows/:table/guarded` | `{ row, guard? }` | 201 `{ outcome: stored, row }` with the guard's new value in `row.money_seq`; `guard: { table, id, column, expect }` inserts only while that row's counter equals `expect` and moves it on in the same step, else 200 `{ outcome: conflict, guard }` and nothing is written; `guard: null` is a plain insert; 409 `unique_violation`; 400 if the row sets the counter itself. Honors Idempotency-Key. |

Postgres shapes (the stand-in enforces the same columns and unique keys):

```sql
create table clients (id text primary key, client_id text unique not null, name text not null, email text not null,
  currency char(3) not null, status text not null check (status in ('active','inactive')), created_at timestamptz not null default now());
create table invoice_numbers (id text primary key, sequence text not null, value int not null, key text not null,
  created_at timestamptz not null default now(), created_by_run text, unique (sequence, value), unique (sequence, key));
create table invoices (id text primary key, request_event_id text unique not null, number text unique not null,
  sequence text not null, sequence_value int not null, client_id text not null references clients(client_id),
  currency char(3) not null, issue_date date not null, due_date date not null, po_number text,
  line_items jsonb not null, tax_lines jsonb not null, subtotal_minor bigint not null, tax_minor bigint not null, total_minor bigint not null,
  status text not null check (status in ('issued','sent','void')), pdf_key text, pdf_sha256 char(64), pdf_bytes int, email_id text,
  void_event_id text, void_reason text, receipt_email_id text, paid_at timestamptz,
  money_seq int not null default 0 check (money_seq >= 0), email_started_at timestamptz,
  created_at timestamptz not null default now(), created_by_run text, updated_at timestamptz, updated_by_run text, history jsonb);
create table payments (id text primary key, event_id text unique not null, processor_payment_id text unique not null, reference text not null,
  invoice_id text references invoices(id), invoice_number text, amount_minor bigint not null check (amount_minor > 0), currency char(3) not null,
  received_at timestamptz not null, match text not null, counted boolean not null, excess_minor bigint not null, paid_after_minor bigint,
  money_seq int, created_at timestamptz not null default now(), created_by_run text);
create table refunds (id text primary key, event_id text unique not null, invoice_id text not null references invoices(id), invoice_number text not null,
  amount_minor bigint not null check (amount_minor > 0), currency char(3) not null, reason text,
  status text not null check (status in ('approved','submitted')), processor_refund_id text, money_seq int not null,
  created_at timestamptz not null default now(), created_by_run text, updated_at timestamptz, updated_by_run text, history jsonb);
create table reminders (id text primary key, invoice_id text not null references invoices(id), invoice_number text not null, step_days int not null,
  as_of date not null, days_overdue int not null, balance_minor bigint not null, currency char(3) not null, email_id text not null, status text not null,
  created_at timestamptz not null default now(), created_by_run text, unique (invoice_id, step_days));
create table review_items (id text primary key, source_event_id text not null, kind text not null, invoice_id text, invoice_number text, payment_id text,
  amount_minor bigint, currency char(3), detail text not null, created_at timestamptz not null default now(), created_by_run text,
  unique (source_event_id, kind));
-- plus the kit's workflow_config, ledger, idempotency_keys and dead_letters (_shared/KIT.md)
```

The sequence in Postgres is one statement per call inside a transaction holding `pg_advisory_xact_lock(hashtext(:name))`: return the row for `(:name, :key)` if it exists, else `insert ... select :name, coalesce(max(value), 0) + 1, :key from invoice_numbers where sequence = :name`. The lock makes `max + 1` safe under concurrency; the unique keys make a mistake fail loudly. The update is `update ... set ... where id = :id and <expect> returning *`, with the no-op case checked first. A stamp is `set email_started_at = coalesce(email_started_at, now())`.

The guarded writes are one statement each, under the default READ COMMITTED isolation. A guarded payment (refunds the same, into `refunds`):

```sql
with guard as (
  update invoices set money_seq = money_seq + 1, updated_at = now(), updated_by_run = :run
  where id = :invoice_id and money_seq = :seen
  returning money_seq
)
insert into payments (id, event_id, processor_payment_id, reference, invoice_id, invoice_number, amount_minor, currency,
  received_at, match, counted, excess_minor, paid_after_minor, money_seq, created_by_run)
select :id, :event_id, :processor_payment_id, :reference, :invoice_id, :invoice_number, :amount_minor, :currency,
  :received_at, :match, :counted, :excess_minor, :paid_after_minor, guard.money_seq, :run
from guard
returning *;
```

The void:

```sql
update invoices set status = 'void', void_event_id = :event_id, void_reason = :reason,
  money_seq = money_seq + 1, updated_at = now(), updated_by_run = :run
where id = :id and money_seq = :seen and status in ('issued', 'sent')
returning *;
```

No row back means nothing was written; the service then reads the invoice and answers `outcome: conflict` when `money_seq <> :seen` (409 `conflict` when only the status differs). Why it holds: a second writer with the same `:seen` blocks on the first writer's row lock on the invoice, and when the first commits, Postgres re-checks the `where` clause against the committed row (`money_seq` is now `:seen + 1`), so the second update matches no row and its insert never runs. A unique violation in the insert rolls back the counter update with it.

## Money

Integer minor units everywhere (`config.currencies[*].minor_units`: PHP 2, USD 2, JPY 0). A quantity is parsed from its decimal text into thousandths (`2.5` -> 2500; `0.1 + 0.2` as a float is refused). Line net = `unit_price_minor x quantity / 1000`, rounded half up, in BigInt. Tax is computed once per tax code on the summed net of its lines (`rate_bp / 10000`), rounded half up, so the tax on the invoice is not a sum of rounded line taxes. Total = subtotal + tax, at most 10^12 minor units.

## Config (data service, `GET /v1/config/invoice-to-payment`)

| Key | Value in the tests | Meaning |
| --- | --- | --- |
| `timezone` | `Asia/Manila` | business dates (the workflows' `settings.timezone` is the same; a unit test checks it) |
| `seller` | CRIT, critdept.com, billing@critdept.com, placeholder address and tax id | on the PDF and in emails |
| `number_prefix`, `number_digits` | `CRIT-`, 4 | `CRIT-2026-0001` |
| `currencies` | PHP 2, USD 2, JPY 0 | minor units |
| `tax_rates` | `VAT12` 1200 bp, `ZERO` 0, `JCT10` 1000 bp | basis points and label |
| `max_line_items`, `max_pdf_bytes` | 50, 2000000 | limits |
| `payment_terms` | one sentence | on the PDF and in emails |
| `reminder_steps_days` | `[3, 10, 21]` | days after the due date |
| `stuck_after_minutes` | 30 | watchdog threshold |

## Environment

`BILLING_WEBHOOK_SECRET`, `PAYMENTS_WEBHOOK_SECRET`, `PDF_BASE_URL`, `PDF_API_TOKEN`, `STORAGE_BASE_URL`, `STORAGE_TOKEN`, `STORAGE_BUCKET`, `EMAIL_BASE_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_TIMEOUT_MS`, `PAYMENTS_BASE_URL`, `PAYMENTS_API_KEY`, `REVIEW_SLACK_CHANNEL`, `INVOICE_CLOCK_OVERRIDE` (`allow` only in tests), `INVOICE_SCHEDULES` (`off` stops the scheduled runs), and the kit's `DATA_SERVICE_*`, `ALERTS_SLACK_*`, `N8N_EDITOR_BASE_URL`, `GENERIC_TIMEZONE`. The review channel uses the same Slack bot token as the alerts channel, on a different channel.

## Scenarios (end to end)

`happy_create_deliver`, `gap_free_numbers`, `redelivered_event`, `redelivery_while_in_flight`, `bad_signature`, `stale_timestamp`, `invalid_payload`, `pdf_5xx_retry`, `email_timeout_after_send`, `storage_failure_error_workflow`, `payment_exact`, `payment_partial_then_rest`, `payment_over`, `payment_wrong_currency`, `payment_unknown_reference`, `payment_on_void_invoice`, `payment_duplicates`, `refund_limits`, `invalid_transitions`, `reminder_steps`, `reminder_skips`, `reminder_early_exit`, `reminder_after_failed_run`, `watchdog`, `invoice_to_payment_chain`, `concurrent_refunds`, `concurrent_full_payments`, `concurrent_partial_and_rest`, `concurrent_void_and_payment`, `dead_letter_store_failure`, `late_redelivery_after_lost_answer`. Rounding and tax edge cases are unit tests, and so is the void-first order of the void-and-payment race (`race:` in `tests/unit.test.mjs`). What each one asserts is in `tests/e2e.mjs`; what was observed is in [VALIDATION.md](VALIDATION.md).
