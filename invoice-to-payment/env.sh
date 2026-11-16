# Local editor settings for the CRIT invoicing workflows. Source this file; start.sh, import.sh and export.sh do it
# for you. One n8n per project, with its own data folder, on 127.0.0.1. The kit adds the fixed settings
# (telemetry, version checks, templates and personalisation off, execution history pruned) and starts n8n with an
# allowlisted environment, never your whole shell: see ../_shared/bin/n8n-local.mjs.
#
# Every value below points at the LOCAL STAND-INS (standins/serve.mjs) and is a placeholder made for them.
# None is a real secret. A deployment takes endpoints and secrets from the secret manager (Doppler), never from
# this file, and never writes them into the workflow JSON.

export N8N_USER_FOLDER="${N8N_USER_FOLDER:-$HOME/.n8n-crit-invoice-to-payment}"
export N8N_PORT="${N8N_PORT:-5699}"
export N8N_RUNNERS_BROKER_PORT="${N8N_RUNNERS_BROKER_PORT:-5700}"
export N8N_EDITOR_BASE_URL="http://127.0.0.1:$N8N_PORT"
export GENERIC_TIMEZONE=Asia/Manila

# Local stand-ins (data service, PDF renderer, object storage, email API, payment processor, Slack):
#   ( . ./env.sh && node standins/serve.mjs )
export STANDIN_PORT="${STANDIN_PORT:-5794}"
STANDIN_URL="http://127.0.0.1:$STANDIN_PORT"
export DATA_SERVICE_BASE_URL="$STANDIN_URL/data"         DATA_SERVICE_TOKEN=local-standin-data-token
export ALERTS_SLACK_BASE_URL="$STANDIN_URL/slack"        ALERTS_SLACK_TOKEN=local-standin-slack-token ALERTS_SLACK_CHANNEL='#crit-alerts'
export REVIEW_SLACK_CHANNEL='#crit-billing'
export BILLING_WEBHOOK_SECRET=local-standin-billing-webhook-secret
export PAYMENTS_WEBHOOK_SECRET=local-standin-payments-webhook-secret
export PDF_BASE_URL="$STANDIN_URL/pdf"                   PDF_API_TOKEN=local-standin-pdf-token
export STORAGE_BASE_URL="$STANDIN_URL/storage"           STORAGE_TOKEN=local-standin-storage-token STORAGE_BUCKET=crit-invoices
export EMAIL_BASE_URL="$STANDIN_URL/email"               EMAIL_API_KEY=local-standin-email-key
export EMAIL_FROM='CRIT Billing <billing@critdept.com>'  EMAIL_TIMEOUT_MS=15000
export PAYMENTS_BASE_URL="$STANDIN_URL/payments"         PAYMENTS_API_KEY=local-standin-payments-key
# The editor keeps the real clock and no scheduled runs against the stand-ins.
export INVOICE_CLOCK_OVERRIDE=deny INVOICE_SCHEDULES=off
