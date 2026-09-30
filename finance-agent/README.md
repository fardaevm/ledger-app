# Finance Agent

An agentic assistant for [ledger-app](..) (it lives in the same repo) — a tool-using
Claude agent that answers questions about a household's shared finances
("how much did we spend on groceries last month?", "are we saving more
than last quarter?") and can eventually give grounded savings advice.

This is Phase 3 of the larger project (see the roadmap Claude gave you in
chat). It runs against the **same Supabase project** as ledger-app — no new
database — and deploys **with** it: on Vercel it's a Python function in the same
project, served on the same origin at `/api/chat` and `/api/health`.

## Why hand-rolled, not LangGraph/CrewAI

For a first version, the agent loop (`app/agent.py`) is about 40 lines of
plain Python: call Claude with tools, execute whatever it asks for, feed
the result back, repeat. No framework.

That's deliberate. In an interview, "I built the loop myself and can
explain every part of it" is a stronger answer than "I used LangGraph"
on its own — and once this works, re-implementing the same agent with a
framework is a natural next step that lets you speak to *both* in an
interview: the primitives, and how a framework's abstractions map onto
them. Don't skip straight to the framework.

## Architecture

```
Browser (ledger-app, same origin)
   │  POST /api/chat { access_token, message, history }
   ▼
Vercel function api/index.py → FastAPI (app/main.py)
   │  checks the caller's email against ASSISTANT_ALLOWED_EMAILS
   │  builds a Supabase client scoped to the caller's own JWT
   │  (RLS enforces they only ever see their own household's data)
   ▼
agent.run_agent()  (app/agent.py)
   │  loop: Claude decides to call a tool → we execute it → feed result back
   ▼
tools.py — 10 deterministic functions the model can call:
   transactions: get_transactions, spending_summary, spending_by_category,
                 compare_periods, detect_recurring_charges
   debts:        get_debts, debt_payoff_projection, debt_payoff_comparison
   recurring:    get_recurring_rules
   goal:         profit_goal_status
   │
   ▼
Supabase (the same tables ledger-app writes to: transactions, debts,
recurring_rules, households)
```

The debt, recurring and goal tools **mirror ledger-app's own calculations line for
line** (the docstring of each names the app function it copies), so the assistant
and the UI never disagree:

- `get_debts`: paid off = original − current; per-debt percent rounded down; household
  totals from the sums (never an average of percentages), one decimal, rounded down.
- `debt_payoff_projection`: `rough_estimate` is the Debts page's "Rough estimate" exactly
  (months = ceil(balance ÷ minimum), interest ignored) plus the page's interest-per-month
  and "minimum doesn't cover interest" check. The page doesn't show a *total* interest
  cost, so that lives in a separate, clearly labelled `with_interest` block
  (month-by-month at APR/12).
- `get_recurring_rules`: next date = this month if the day hasn't come, else next month.
- `profit_goal_status`: the Dashboard goal ring: custom goal, else the average profit of
  earlier periods if positive, else $3,000/month. It uses the same newest 1,000
  transactions the app loads, and JavaScript rounding for the percent.

The system prompt carries the Debts page's tone rules: lead with progress, never a bare
"you owe $X", no alarming language about debt being paid down on schedule. It's built per
request, so "today" is always today on a long-running server.

The core design rule: **the model never does financial arithmetic
itself.** Every number it states came from a tool call. This is checked
by unit tests in `tests/test_tools.py`, not by hoping the model behaves.
`tests/test_api.py` covers the HTTP layer: the `/api` routes, the allowlist, the size
caps, and no CORS by default.

**Who can use it:** ledger-app's sign-up is open, so `/api/chat` only answers accounts
whose email is in `ASSISTANT_ALLOWED_EMAILS`, **closed by default** (unset = nobody).
Otherwise anyone could sign up and spend your Anthropic credits. Messages are capped at
4,000 characters and history at 40 messages for the same reason.

## Setup (local)

From this folder:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # ../requirements.txt (runtime) + uvicorn + pytest
cp .env.example .env                  # ANTHROPIC_API_KEY, ASSISTANT_ALLOWED_EMAILS, SUPABASE_*
```

Run the tests (no network, no real Supabase project; a fake in-memory client):

```bash
pytest tests/ -v
```

Run the API, then the app in another terminal from the repo root (`npm run dev`). Vite
proxies `/api` to port 8000, so the app talks to the assistant on its own origin, just like
in production:

```bash
uvicorn app.main:app --reload --port 8000
```

Try it without any frontend, from the terminal:

```bash
python scripts/chat_cli.py
```

It'll ask for a Supabase access token — grab one from your signed-in
ledger-app browser session (instructions are in the script's docstring).

## Deploy (Vercel, with ledger-app)

Nothing separate to deploy: pushing the repo deploys the app **and** the assistant.

- `api/index.py` (repo root) is the Vercel Python function. It imports the FastAPI app
  from here; `vercel.json` bundles `finance-agent/app/**` with it (`includeFiles`), gives
  it up to 60 s per request (`maxDuration`), and rewrites every `/api/*` path to it. Every
  other path still goes to the app.
- `requirements.txt` at the repo root holds the runtime dependencies Vercel installs.
  **Vercel ignores `.python-version`** and runs the newest Python it supports (3.14 as of
  2026-09), and it can't compile packages from source. So every pin needs prebuilt Linux
  wheels for that Python: pydantic 2.9.2 didn't, and failed the first deploy. The check
  command is in the file's header. The tests pass on 3.12 (local) and 3.14.
- The PWA service worker leaves `/api/` alone (`navigateFallbackDenylist` in
  `vite.config.js`).

In **Vercel → Project → Settings → Environment Variables**, add:

- `ANTHROPIC_API_KEY`: server-side only. **No `VITE_` prefix**, or Vite would build it into
  the page for every visitor.
- `ASSISTANT_ALLOWED_EMAILS`: comma-separated emails that may use the assistant.
- For bank connections: `PLAID_ENV` (`sandbox`), `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX`
  and `PLAID_TOKEN_ENCRYPTION_KEY`. `/api/health` reports `plaid_ready`.

`SUPABASE_URL` / `SUPABASE_ANON_KEY` aren't needed: the function falls back to the app's
existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. `ALLOWED_ORIGINS` isn't needed
either: the app and the assistant share an origin.

After deploying, `https://<your-app>/api/health` returns `{"status":"ok","assistant_ready":…}`.
`assistant_ready` turns `true` once both variables above are set (it never shows their
values). Environment variable changes apply on the next deploy.

## Bank connections (Plaid, Sandbox)

The same FastAPI app also serves three Plaid endpoints (`app/plaid_routes.py`), with the same
auth as `/api/chat`: the Supabase JWT in the body, verified by Supabase Auth, and every query
through a client scoped to that user, so RLS does the household scoping.

- `POST /api/plaid/link-token` `{access_token}` → `{link_token, expiration}` for Plaid Link.
- `POST /api/plaid/exchange` `{access_token, public_token}` → `{item_id, institution_name}`.
  Exchanges Link's public token, **encrypts** the Plaid access token (Fernet,
  `app/token_crypto.py`) and stores it in `plaid_items`. The plaintext token is never logged
  or returned. If saving fails, the item is removed at Plaid so nothing is left dangling.
- `POST /api/plaid/sync` `{access_token, item_id?}` → per item: `queued`, `removed`,
  `skipped_pending`, or an `error_code` (say `ITEM_LOGIN_REQUIRED`) without stopping the
  other items. Pages through `/transactions/sync` from the stored cursor, upserts into
  `plaid_review_queue` (**never** `transactions`), deletes unreviewed rows Plaid withdrew,
  and saves the cursor last, so a failed run just repeats next time. Pending transactions
  are skipped: Plaid replaces each with a posted one under a new id. Categories are mapped
  by `app/plaid_categories.py`; a test checks each one exists in `src/main.js`.

Plaid calls go through a thin httpx client (`app/plaid_client.py`), not the plaid-python
SDK, to keep the function's cold start small. It refuses any `PLAID_ENV` but `sandbox`.

Tables: migration 2026-09-29 in `supabase/schema.sql`. Household members read `plaid_items`
and may only advance its `cursor` (a column grant); the linker unlinks.

**Before Production:** sign-up is open, and every linked Item costs money in Production, so
these endpoints need an allowlist like `ASSISTANT_ALLOWED_EMAILS` first. Webhooks, a review
screen that moves queue rows into `transactions`, and relinking (`ITEM_LOGIN_REQUIRED`) are
not built yet.

Manual testing: a temporary page, `scripts/plaid-test.html`, is gitignored, so it isn't in
the repo. It runs Link → exchange → sync against a deployment. Start the dev server with
`API_TARGET=https://<deployment> npm run dev` (Vite then forwards `/api` there), open
`/scripts/plaid-test.html`, paste a Supabase access token, and log in with `user_good` /
`pass_good`.

## Wiring it into ledger-app

Not done yet by design — you picked "build the agent" as the first
piece. When you're ready to add a chat UI to ledger-app:

1. Add a `view-assistant` section to `index.html` (same pattern as the
   existing views) with a message list and an input box.
2. On submit, `POST` to `/api/chat` (same origin) with
   `supabase.auth.getSession()`'s `access_token`, the message, and the
   running history.
3. Render `reply`; optionally show `tool_calls` in a collapsed
   "how I got this" section — useful for building trust, and it's
   basically free observability you already have.

## What's next (per the roadmap)

- **Eval harness** (roadmap step 4): write a small set of test
  conversations with expected tool calls / expected facts in the answer,
  and score the agent against them — this is what turns "I built an
  agent" into "I built and evaluated an agent."
- **Receipts** (roadmap steps 2–3): once `receipts` exists in the schema,
  add a `log_receipt_expense` tool so the assistant can act on an
  extracted receipt directly, not just answer questions about existing
  data.
- **Observability** (roadmap step 7): the `tool_calls` trace already
  returned by `/chat` is the seed of this — persist it somewhere
  (a table, or Langfuse/LangSmith) instead of just returning it.
