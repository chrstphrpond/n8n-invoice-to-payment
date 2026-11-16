# CRIT n8n kit

The shared kit for every CRIT workflow: a builder that enforces the house style, a stand-in server framework, a data-service stand-in, a model-answer replay, the real-n8n test harness with a machine-wide lock, the n8n-mcp validation runner, and the one error workflow every workflow attaches. Zero dependencies: Node 24 and the global n8n 2.42.6.

This guide is how the kit implements the CRIT n8n house style. The workflow folder beside `_shared/` in this repository is a worked example: copy its shape.

## Rules that are not optional

- **Original work.** Every workflow is written from its own SPEC.md.
- **No model calls, no paid usage, no real accounts.** Model answers in tests are hand-written fixtures replayed by the stand-in. Vendor APIs are stand-ins. Nothing is sent anywhere.
- **No secrets in files, no `.env` files.** `env.sh` holds only placeholder values for the local stand-ins, labelled as such. The harness generates random test secrets per run.
- **n8n passes ids, not content.** Rows, the idempotency ledger, dead letters and rules live in the data service. A workflow stores references (hashes, vendor ids), never file bytes.
- **Configure nodes from the live schema**, never from memory: `node shared/bin/get-node.mjs nodes-base.httpRequest full` (also `--tools`). The node versions the builder uses (`NODE_VERSIONS` in `lib/flow.mjs`) are what n8n-mcp 2.94.3 reports for n8n 2.42.6.

## Add a workflow

```
workflows/<slug>/
  SPEC.md  README.md  VALIDATION.md  BUILD-LOG.md
  env.sh  start.sh  import.sh  export.sh        local editor (copy from receipt-scanner, change ports and variables)
  workflow/build.mjs                            builds workflow/<slug>.json and workflow/manifest.json
  workflow/lib/*.js                             pure logic, inlined into Code nodes, unit tested
  standins/index.mjs                            the stand-in modules for this workflow (data service tables and config, vendors, model replay)
  standins/serve.mjs                            the same stand-ins on a fixed port for the local editor
  fixtures/                                     config.json, llm/<name>.json (hand-written model answers), payloads
  tests/unit.test.mjs  tests/e2e.mjs
  results/                                      written by the three commands below
```

1. **Id and name.** `CRIT · <Verb phrase>`, a fixed 16-character id (letters and digits, for example `critSalesApprov1`). Pick both once; the id never changes.
2. **`workflow/build.mjs`.** `new Flow({ id, name, timezone, notes, settings, verbs })`, then `f.add(node)`, `f.connect(from, to, output)`, `f.chain(a, b, c)`. Node factories: `webhookNode`, `codeNode`, `httpNode`, `ifNode`, `switchNode`, `respondNode`, `scheduleNode` (Schedule Trigger 1.4, one interval rule), `waitNode` (Wait 1.1, a fixed number of seconds: n8n-mcp's strict profile refuses an expression there). Code node source: `lib.codeSource(name, body, { from: ['Prepare X'] })` from `createModules([...files])`. `f.json()` throws if the lint fails, so a broken workflow is never written. Export a `MANIFEST` (`slug`, `workflows: [{ file, id, name, webhooks, readOnlyPostNodes, noRetryNodes?: [{ node, reason }] }]`, `env: [variable names]`, `verbs?: [extra verbs]`) and write both with `writeOrCheck`.
3. **Notes.** Every node needs an entry in the `notes` object (one or two sentences, shown on the canvas).
4. **Sticky notes.** `f.sticky('Read me', ...)` at the top (what it does, config, state, retries), then `f.section('1. Intake and trust', text, [col, row], [col, row])` per section: it draws the sticky behind that grid area of `at(col, row)`.
5. **Tests**, then the three commands below, then the docs.

## What the builder and lint enforce

`lib/flow.mjs` builds it in; `lib/lint.mjs` checks the files on disk (also run by `validate.mjs`):

- name prefix `CRIT · `, 16-character id, `settings.timezone`, `executionOrder: v1`, `settings.errorWorkflow: critAlertErrors1`
- node names start with a verb from `VERBS` in `lib/lint.mjs`, or from the manifest's optional `verbs` list (for example `"verbs": ["Expire", "Schedule"]`; pass the same list to `new Flow({ verbs })` so the build-time lint agrees). Do not edit `VERBS` for one workflow. A note on every node, `notesInFlow: true`
- a `Read me` sticky and at least one numbered section sticky
- every HTTP Request: `retryOnFail`, `maxTries: 4`, `waitBetweenTries: 5000` (3 retries 5 s apart), except an HTTP Request node listed in the workflow entry's `noRetryNodes` with a reason, which may have retries off; see "Paid calls" below
- every non-GET HTTP Request sends `X-Run-Id: {{ $execution.id }}`, unless it is listed in the manifest's `readOnlyPostNodes` (a POST that changes nothing, such as the model call)
- `httpNode(..., { write: true })` adds `Idempotency-Key: {{ $json.idem_base }}:<node name>`. Set `ctx.idem_base` once from the sender's event id (`tg-update:<update_id>`), so the key is the same on every n8n retry and every redelivery. Build write bodies only from stable inputs (never the clock, never the run id) so a repeat is byte-identical
- `soft: true` sets `onError: continueErrorOutput`; you must wire output 1 (`f.connect(name, target, 1)`) or the build fails
- every path from a Webhook node passes a Respond to Webhook node (`responseMode: responseNode`); no orphan nodes

Code node conventions: **`URL` and `URLSearchParams` do not exist in n8n's Code node sandbox** (the task runner): code that uses them works in Node and fails in n8n with "URLSearchParams is not defined". Parse a form body or a query string by hand (split on `&` and `=`, `decodeURIComponent` after turning `+` into a space). The kit's module loader and `runCodeNode` run the code with both undefined, so a unit test fails the same way. An HTTP node replaces the item with the response, so the Code node after it reloads the context with `{ from: ['Prepare X'] }` (`ctxFrom` in `lib/code/ctx.js`); `response` is the HTTP answer. Read every HTTP answer with `httpOutcome(response)`: it treats n8n's error-output item and `{ ok: false }` answers as failures. A Code node that must not continue on a bad answer throws (the run fails into the error workflow). Do not write `return [` followed by a string or digit anywhere in an inlined module, comments included: n8n-mcp reads it as a Code node returning bare values and fails validation.

Unit-testing a Code node: `runCodeNode(workflow, name, { input, nodes, env, binary, runIndex })` (`lib/code-node.mjs`). `input` and each `nodes[name]` are one item's json or an array of item jsons; `$()` and `$input` offer `first()`, `last()`, `all()` and `item`; `$runIndex` is `runIndex` (a node inside a loop reads its own run number with it).

## Paid calls that are not idempotent do not auto-retry

n8n's retry re-sends the call. A vendor call that costs money per call and has no idempotency (a model call, an image or video generation, a text message) is paid again on every retry, also when the first try did the work and only the answer was lost. Such a call is built with `httpNode(..., { retry: false })` and listed on its workflow entry in the manifest as a documented exception, with the reason in words:

```json
"noRetryNodes": [{ "node": "Create provider task", "reason": "createTask is paid and takes no idempotency key; a retry after a lost answer creates and charges a second task" }]
```

Set the same list on the Flow (`f.noRetryNodes = [...]`) so the build-time lint agrees with `validate.mjs`. The lint lets a listed HTTP Request node have retries off; every other HTTP node is still held to 3 retries 5 s apart; an entry without a reason, naming a node that does not exist or a node that is not an HTTP Request is a lint problem. Handle the call's failure (error output to a person or a review, never a blind second call). Keeping the house retries on such a call is an **exception that must be documented**: the workflow README says, under "Scope and limits", which node keeps the retries, why, and the worst case ("a model call that times out can be paid up to four times").

## Webhook bodies n8n refuses itself

A request whose `Content-Type` says JSON but whose body is not JSON is answered **422 by n8n itself** while it reads the body, before any workflow runs: no node runs, so no dead letter is written and nothing is logged by the workflow. Only a body that reaches the workflow (valid JSON of the wrong shape, or a non-JSON body sent as `text/plain` or form data) gets the workflow's 400 and a dead letter. Test the 422 case separately and say so in the README; do not claim a dead letter for it.

## Canvas screenshots

One real screenshot per workflow file, at `docs/<slug>-<workflow>-canvas.png` in the repository's `docs/` folder (`<workflow>` is the workflow file name without `.json`; when it equals the slug, `docs/<slug>-canvas.png`). Never an invented image. Capture them with:

```sh
node shared/bin/capture-canvas.mjs workflows/<slug>            # every workflow of the folder
node shared/bin/capture-canvas.mjs workflows/<slug> --only decide-and-send.json --size 2400x1500
```

It makes a throwaway local editor (a fresh temporary `N8N_USER_FOLDER`, free ports, the folder's `env.sh` placeholders; no stand-in is needed to draw a canvas), imports and publishes with `n8n-local.mjs`, creates a local owner on a `.example` address with a random password, drives headless Google Chrome with a fresh temporary profile over the DevTools protocol (never Microsoft Edge, never a signed-in profile), fits each workflow to the view and saves the PNG. Chrome and n8n are stopped (whole process groups) and the temporary folder deleted at the end, also on failure. A vendored kit writes to the `docs/` beside `_shared/`; `--docs <dir>` overrides.

## Commands

From the repository root. Each writes into `workflows/<slug>/results/`.

```sh
node shared/bin/run-unit.mjs workflows/<slug>      # kit tests + the workflow's unit tests -> results/unit-tests.txt
node workflows/<slug>/tests/e2e.mjs                 # real n8n end to end -> results/e2e-summary.json, results/request-logs/
node workflows/<slug>/tests/e2e.mjs --only a,b      # a subset -> results/e2e-summary.partial.json (not committed)
node shared/bin/validate.mjs workflows/<slug>       # lint + n8n-mcp runtime and strict -> results/n8n-mcp-validation.json, results/connections.txt
node workflows/<slug>/workflow/build.mjs [--check]  # (re)build, or fail if the JSON on disk is stale
node shared/bin/get-node.mjs nodes-base.<type> full # live node schema from n8n-mcp
```

Local editor (optional, for looking at the canvas): `( . ./env.sh && node standins/serve.mjs )` in one terminal, then `./import.sh` and `./start.sh` in the workflow folder. `./export.sh` exports what the editor holds to `workflow/exported/` (git-ignored) and diffs it against the generated file; fold real changes back into `build.mjs`.

## Ports

- **Tests always pick free ports** (n8n, its task-runner broker, the stand-in server). Never hard-code a port in a test.
- **Local editor ports** (in `env.sh`, n8n port and broker port +1, stand-ins port): receipt-scanner 5691/5692 and 5790. Next workflows: 5693/5694 and 5791, then 5695/5696 and 5792, and so on. Each editor has its own data folder `~/.n8n-crit-<slug>`.

## The e2e lock (parallel safety)

`createHarness().start()` takes a **machine-wide** lock before anything else: the directory `crit-n8n-e2e.lock` under `os.tmpdir()` (fixed name, `mkdir` is atomic), with `owner.json` holding the pid and a label. Runs from any repo or worker that use this kit take turns; a waiting run prints who holds it and polls every 2 s (up to 60 minutes). A lock whose pid is dead is stale and taken over. `stop()` (also wired to process exit, Ctrl-C and SIGTERM) kills n8n's whole process group, closes the stand-in, deletes the temp `N8N_USER_FOLDER` and releases the lock. The e2e script asserts no n8n process is left and the temp folder is gone, and records both in `e2e-summary.json` (`cleanup`). Record the lock with `lock_released: h.lockReleased()`: it is true only when this run removed its own lock (the owner pid was this process). Do not test `!existsSync(LOCK_DIR)`: a waiting run takes the lock the moment it is released, so the directory is often back already. Unit tests and `validate.mjs` do not take the lock; they never start n8n.

**No per-user paths in results.** `os.tmpdir()` is a per-user folder (`/var/folders/...` on macOS). Results files say `<tmp>` instead: the harness writes the CLI output through `neutralTmp(text)`, and `LOCK_LABEL` is the lock path in that form (`<tmp>/crit-n8n-e2e.lock`). Use both for anything you write into `results/`.

## Stand-ins

`lib/standin.mjs` runs one local HTTP server in the test process from modules. A module is `{ name, init(), view(state), control(state, input)?, routes }`; a route is `{ method, path, op, idempotency, auth(req), handle(req, state) }`.

- `path`: `/data/v1/rows/:table`, `/telegram/bot:token/getFile`, `/x/file/:path*` (rest of the path).
- `op`: the name used in the request log and for faults; may be a function of the request (the data service uses `data.insert.<table>`, `data.find.<table>`).
- `idempotency`: `'honor'` (writes: the key is required; same key and same body replays the first answer; same key with a different body is 422), `'ignore'` (the vendor has no such feature, like Slack and Telegram: logged, never replayed), `'none'` (state-changing but not keyed: the ledger), or absent for reads.
- **Request log** (`h.standin.log()`): `seq, op, method, path (redacted), query, body (long strings as length and hash), status, fault, idempotency_key, run_id, raw_sha256, idempotent_replay`, plus anything a handler adds (`log: { outcome }`).
- **Faults**: `h.standin.control({ faults: [{ op, status, times, delay_ms, after_commit, malformed, body, headers }] })`. With `status`: refused, nothing committed (unless `after_commit`). Without `status`: answered normally after `delay_ms` (a slow answer; use it with a short node timeout for timeout tests).
- **State**: `h.standin.state()` (every module's `view`), `h.standin.moduleState(name)` (live object), `h.standin.reset()` between scenarios.
- For the local editor the same server answers `GET /__log`, `GET /__state`, `POST /__control`, `POST /__reset`.
- **Overrides**: a route with the same method and path as an earlier one replaces it. A workflow that extends the data service (`{ ...dataService(...), routes: [...base.routes, myRoute] }`) keeps its own version of a call the kit also offers.

## Data service

`lib/data-service.mjs` is the stand-in for the CRIT data service, the one service that owns workflow state. A Postgres-backed service can replace it without changing a workflow. Every call: `Authorization: Bearer <DATA_SERVICE_TOKEN>`; writes also send `X-Run-Id`; row inserts also send `Idempotency-Key`.

| Call | Body | Answer |
| --- | --- | --- |
| `GET /v1/config/:name` | | `{ name, config }`, 404 if unknown |
| `POST /v1/ledger/claim` | `{ scope, key, payload?, ttl_seconds?, redelivers? }` | `{ outcome: claimed \| in_flight \| done, reclaimed?, entry }`. Same run again: `claimed`. A `failed` entry, or an `in_flight` one older than its `ttl_seconds`, is taken over (`reclaimed: after_failure \| stale_claim`). `ttl_seconds`: a whole number from 60 to 7200 (400 otherwise), default 600, stored with the claim (`entry.ttl_seconds`). `redelivers: false`: the sender never sends this event again (stored only when given; see the error workflow) |
| `POST /v1/ledger/complete` | `{ scope, key, outcome, result? }` | 200; 409 if another run holds the claim |
| `POST /v1/ledger/fail` | `{ run_id, error }` | `{ released: [entry] }`: every in-flight claim of that run becomes `failed` (the error workflow calls this) |
| `GET /v1/ledger?scope=&key=&state=&before=&include_payload=` | | `{ entries }`, oldest change first (`failed_at`, else `claimed_at`). `state`: one state or a comma list; `before`: an ISO time; `include_payload=true` adds the stored payload (for a replay tool; a watchdog leaves it out). Op `data.ledger_list` |
| `GET /v1/rows/:table?col=value` | | `{ rows }` (exact match; unknown column 400) |
| `POST /v1/rows/:table` | `{ row }` | 201 `{ row }` with `id`, `created_at`, `created_by_run`; 409 `unique_violation`; 400 unknown column |
| `PATCH /v1/rows/:table/:id` | `{ set, expect? }` | compare-and-set. Every `expect` column must hold its value (or one of the values in a list), else 409 `{ error: conflict, columns, row }` with the current row. Every `set` column already holding its value: 200 `{ row, changed: false }` (a replay is a no-op). Otherwise 200 `{ row, changed: true }`, with `updated_at`, `updated_by_run` and a `history` entry. 404 unknown table or row; 400 unknown column; 409 `unique_violation`. Op `data.update.<table>`, `Idempotency-Key` required |
| `POST /v1/rows/:table/next` | `{ row, column, scope?, key?, start? }` | sequence insert for counters and numbering: `row[column]` = the largest `column` among rows sharing the `scope` columns with `row`, plus one (`start`, default 1, for the first). A row already matching `row` on the `key` columns is answered as it is: 200 `{ row, value, outcome: existing }`; else 201 `{ row, value, outcome: allocated }`. 400 if `row` sets `column`. Op `data.next.<table>`, `Idempotency-Key` required |

The stand-in's `control({ data: { config, rows, ledger } })` seeds a scenario: `ledger` entries take `scope`, `key`, `state` and optionally `claimed_at`, `failed_at`, `payload`, `ttl_seconds`, `redelivers` (a claim from "two hours ago" for a watchdog test).

Declare a workflow's tables in its `standins/index.mjs`: `{ name: { columns: [...], unique: [[...]] } }`. `dead_letters` (`source, workflow, reason, payload_sha256, payload`, unique `(workflow, payload_sha256)`) exists for every workflow. Postgres shapes:

```sql
create table workflow_config (name text primary key, config jsonb not null, updated_at timestamptz not null default now());
create table ledger (scope text, key text, state text not null check (state in ('in_flight','done','failed')), run_id text not null,
  attempts int not null default 1, payload jsonb, outcome text, result jsonb, error text,
  ttl_seconds int not null default 600 check (ttl_seconds between 60 and 7200), redelivers boolean,
  claimed_at timestamptz not null, completed_at timestamptz, failed_at timestamptz, primary key (scope, key));
create table idempotency_keys (op text, key text, request_sha256 text not null, status int not null, body jsonb not null,
  created_at timestamptz not null default now(), primary key (op, key));
create table dead_letters (id text primary key, source text, workflow text, reason text, payload_sha256 text, payload jsonb,
  created_at timestamptz not null default now(), created_by_run text, unique (workflow, payload_sha256));
-- plus one table per workflow row type, with the unique constraints the stand-in declares
```

The claim is one atomic statement in Postgres:

```sql
insert into ledger (scope, key, state, run_id, payload, ttl_seconds, redelivers, claimed_at)
values ($scope, $key, 'in_flight', $run, $payload, coalesce($ttl, 600), $redelivers, now())
on conflict (scope, key) do update set state = 'in_flight', run_id = excluded.run_id, attempts = ledger.attempts + 1,
  ttl_seconds = excluded.ttl_seconds, claimed_at = now(), payload = coalesce(excluded.payload, ledger.payload),
  redelivers = coalesce(excluded.redelivers, ledger.redelivers)
where ledger.state = 'failed' or (ledger.state = 'in_flight' and ledger.claimed_at < now() - make_interval(secs => ledger.ttl_seconds))
returning *;
-- no row returned: read the entry; done -> outcome done; in_flight by the same run -> claimed; else in_flight
```

The compare-and-set update and the sequence insert:

```sql
-- PATCH /v1/rows/things/:id  { set: { state: 'sent' }, expect: { state: ['draft', 'queued'] } }
update things set state = 'sent', updated_at = now(), updated_by_run = $run
where id = $id and state = any(array['draft', 'queued'])
returning *;                                   -- no row: 404 if the id is unknown, else 409 conflict with the current row

-- POST /v1/rows/numbers/next  { row: { series, ref }, column: 'value', scope: ['series'], key: ['ref'], start: 1001 }
-- (a unique key on (series, value), and on (series, ref) for the "existing" answer; one transaction)
select pg_advisory_xact_lock(hashtext('numbers:' || $series));
select * from numbers where series = $series and ref = $ref;       -- found: outcome existing
insert into numbers (series, ref, value) select $series, $ref, coalesce(max(value), 1001 - 1) + 1
from numbers where series = $series returning *;                   -- outcome allocated
```

## Model calls

The workflow's model step is a plain HTTP Request to `{{ $env.ANTHROPIC_BASE_URL }}/v1/messages` with `x-api-key` and `anthropic-version: 2026-10-21`, in the Messages API shape, with `output_config.format` a JSON schema (current Opus and Sonnet models refuse a forced `tool_choice`; the replay refuses it too). Going live is a base URL and a key; the workflow does not change. Define the request in one `workflow/lib/*.js` function used by the workflow and the tests.

`lib/model-replay.mjs` answers from `fixtures/llm/<name>.json` = `{ "synthetic": true, "note": "...", "response": { content, stop_reason, usage } }`. You supply `resolveFixture(body)` (the receipt scanner hashes the image in the request). It refuses what the real API would refuse (missing key, wrong version header, other model, no JSON schema, sampling parameters, forced tool, last turn not user). Every fixture is hand-written: say so in its `note`. Treat the model's answer as untrusted: parse it again and check every field in code.

## Asserting in e2e

Use `createHarness({ workflowDir, modules, env, redact, timezone })`. Per scenario: `h.standin.reset()`, set faults, post with `h.post(path, body, headers)`, wait for the outcome (`h.waitFor(() => ledger state is done)`, then `h.settle()`), then assert:

- the HTTP answer (status and body)
- the calls in order: `h.standin.log().map(e => e.op)` against an exact list
- rows and ledger entries in `h.standin.state()`, and what the vendor stand-ins received (replies, alerts)
- house rules over the whole log: every write has `Idempotency-Key` ending in `:<node name>` and a numeric `X-Run-Id`; reads have no key; no secret in a logged path

Use test-range ids (`test-...` strings, update ids from 900000100). Write `results/e2e-summary.json` with runtime versions, totals, cleanup and per-scenario calls.

## The error workflow

`error-workflow/` builds `CRIT · Alert on errors` (`critAlertErrors1`). The harness imports and publishes it before the workflow under test. It calls `POST /v1/ledger/fail` with the failed execution id (hands the claim back), then posts to `ALERTS_SLACK_CHANNEL` (`#crit-alerts`, which no workflow posts to): workflow name, failed node, the error message with its description (credentials stripped), the execution link (`N8N_EDITOR_BASE_URL`), and which claims were handed back. Test it in your e2e by failing a critical node on all 4 tries.

The last line depends on the claim. By default it is `Released for redelivery: <scope>:<key>`. Many senders never send an event again once they got a 2xx (Telegram after the 202, Slack after its 200, the workflow's own internal calls after their 202, a scheduler that fires once): take those claims with `redelivers: false`, and the alert says `Handed back, but the sender does not redeliver: <scope>:<key>. Nothing runs it again by itself: replay it by hand or act on it again (the workflow README says how).` Such a workflow needs a watchdog (failed or stale claims past a deadline, ids only) and a documented replay command; `GET /v1/ledger?...&include_payload=true` gives a replay tool the stored payload.

## Documents per workflow

- `SPEC.md`: the problem, the design by section, the table shapes, the env variables, the scenario list.
- `VALIDATION.md`: exactly what was run (commands), the counts, the runtime versions (n8n, Node, n8n-mcp), the accepted validator warnings with reasons, and what is answered by local stand-ins.
- `BUILD-LOG.md`: dated, honest: what broke during the build and how it was fixed. No invented incidents.
- `README.md`: the standard below.

### README standard

Modelled on the lead-to-booking agent's READMEs (https://github.com/chrstphrpond/n8n-lead-to-booking-agent). Plain words, concrete nouns and numbers, no marketing. Under the opening paragraph of each root README goes one credit line with the verified figures from the results files.

**Root README** (short, about 50 lines), sections in this order:

1. Title, then one paragraph: what comes in, what goes out, who it is for, then the credit line.
2. Table of the workflows (name, what comes in, what goes out, node count, tests passed).
3. A real screenshot of an n8n canvas (one sticky per section), captured from the local editor.
4. "Verification and test harness": bold lead-in bullets. **Test data**, **Real n8n** (the version that ran it, what ran on it and what was not exercised), **Model step** where there is one, **Test harness** (which services it answers), then one scope sentence.
5. "What it checks": bold lead-in bullets (Duplicates, Failures, Privacy, Guardrails, ...), each with the mechanism and a result measured in a run.
6. "Run it": prerequisites and a fenced block of the real commands with a short comment each.
7. "Read more": links to each workflow README, VALIDATION.md, BUILD-LOG.md and this file.
8. "License": MIT, see LICENSE.

**Workflow README**: the same voice, deeper: what it does, run it, test data, architecture by section, design decisions, configuration table, scenarios table with observed outcomes, scope and limits, files. Every figure comes from a results file.

## Vendoring the kit into another repo

The kit resolves everything from its own location (`import.meta.url`) or from paths the caller passes; it assumes no repo name and no `workflows/` parent. To use it elsewhere, copy the folder as `_shared/` beside the workflow folders:

```
other-repo/
  _shared/            # this folder, copied unchanged (bin/, lib/, error-workflow/, tests/, KIT.md)
  invoice-to-payment/ # a workflow folder: workflow/, standins/, tests/, ...
```

Then, in the workflow folder, import from `../_shared/lib/...` (not `../../shared/lib/...`), point `start.sh`, `import.sh` and `export.sh` at `../_shared/bin/n8n-local.mjs`, and run the commands with the new paths (`node _shared/bin/run-unit.mjs invoice-to-payment`, `node _shared/bin/validate.mjs invoice-to-payment`). The e2e lock is in `os.tmpdir()`, so runs from both repos still take turns. Keep the copy in sync by copying again; do not edit a vendored copy in place.
