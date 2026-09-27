# Ledger

A shared income & expense tracker for two (or more) people, with realtime
sync. Built with Vite + vanilla JS + Supabase, installable as a PWA.

People sign in with **email + password** (confirmed by email), and join a
partner's household through a **single-use invite link**.

## 1. Create a Supabase project

1. Go to https://supabase.com and create a free project.
2. Open **SQL Editor > New query**, paste the entire contents of
   `supabase/schema.sql`, and run it. On a brand-new project, also run the
   two commented-out lines at the very end (the "PHASE 2" block) — there are
   no old invite codes to keep.
3. Open **Project Settings > API** and copy the **Project URL** and the
   **anon public key**.

### Authentication settings (dashboard only — these can't be set from code)

Open **Authentication** in the Supabase dashboard:

- **Sign In / Providers > Email**
  - Email provider: **enabled**.
  - **Confirm email: ON.** New accounts can't sign in until they click the
    link in their confirmation email. (If this is off, the app logs a
    warning in the browser console at sign-up.)
  - **Secure password change: ON** (asks for a recent sign-in before a
    password change).
  - **Minimum password length: 8** or more. The app checks 8 characters
    in the browser, but the server-side setting is what actually enforces it.
- **Attack Protection**
  - **Leaked password protection** (rejects passwords found in known breaches
    via HaveIBeenPwned) — turn on if your plan includes it.
  - CAPTCHA (Turnstile or hCaptcha) is also available here; the app doesn't
    send a CAPTCHA token yet, so enabling it would require a code change.
- **Rate Limits** — this is where sign-in / sign-up throttling lives. The
  defaults are reasonable; tighten **"sign-ups and sign-ins"** (per IP),
  **"token verifications"**, and **"emails sent"** if you want. Supabase
  enforces these per IP on its side; there is no client-side equivalent
  worth trusting.
- **URL Configuration**
  - **Site URL:** your deployed URL (e.g. `https://ledger.example.com`).
  - **Redirect URLs:** add `https://ledger.example.com/**` and
    `http://localhost:5173/**`. The `/**` wildcard matters: confirmation and
    reset emails send people back to `/invite/<token>` when they signed up
    from an invite link.
- **Emails > SMTP Settings** — Supabase's built-in email sender is only for
  testing and allows very few emails per hour. For real use, connect your own
  SMTP provider, or confirmation and reset emails will stop arriving.

## 2. Configure the app

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the values
from step 1. (The anon key is designed to be public; row-level security is
what protects the data.)

## 3. Run it locally

```bash
npm install
npm run dev
```

Open the printed localhost URL, choose **Create account**, and enter your
name, email and a password. Confirm your email, sign in, and name your
household. Then open the account icon (top right) and choose **Invite partner** to get a link to send
them — it works once and expires after 7 days.

## Upgrading an existing project from magic-link sign-in

If you already use Ledger with the old email-link sign-in, your accounts,
household and entries carry over unchanged:

1. In the SQL editor, run only the block headed
   **`MIGRATION 2026-09-26b`** at the end of `supabase/schema.sql`. It adds
   tables and tightens access rules; it doesn't change any existing
   household, membership, transaction or user row.
2. Apply the **Authentication settings** above (especially the redirect URLs).
3. Each existing person opens the app and clicks **"Reset your password to
   set one"** on the sign-in screen. The email link lets them choose a
   password, and they land straight in their existing household.
4. Once **everyone** has signed in with a password and sees their data, run
   the two **PHASE 2** lines at the end of `schema.sql` to remove the old
   typed invite codes. Don't leave this long: until then, the old 8-character
   codes still work as a (weak) way to join.

Existing accounts get a display name taken from their email address (the
part before the @). To change it:
`update profiles set display_name = 'Ali' where id = '<user id>';`

## 4. Deploy

Any static host works (Vercel, Netlify, Cloudflare Pages):

```bash
npm run build
```

This outputs a static `dist/` folder. Set the build command to
`npm run build`, output directory `dist`, and add the two `VITE_SUPABASE_*`
environment variables in the host's dashboard.

**Invite links need a single-page-app rewrite** so `/invite/<token>` serves
`index.html`:

- Netlify: add `public/_redirects` containing `/*  /index.html  200`
- Vercel: add `vercel.json` with
  `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`
- Cloudflare Pages: works out of the box.

Then add the deployed URL to Supabase's **URL Configuration** (step 1).

## 5. Install it on your phones

Once deployed, open the URL in Safari (iOS) or Chrome (Android) and use
"Add to Home Screen" — it installs as a standalone app icon thanks to the
PWA manifest already wired up in `vite.config.js`.

## How the data model works

- `households` — one row per family/couple.
- `household_members` — who belongs to which household. Rows are only ever
  created by `create_household()` or `redeem_invite()`, never directly.
- `profiles` — each person's display name, filled in from the sign-up form and editable
  from the account menu (each person can change only their own).
- `household_roster()` — the Members page's list: name, email and join date for the members
  of your own household only (emails live in `auth.users`, which the app can't read directly).
- `category_usage()` — how often each category has been used, per type, over the household's
  whole history; it drives the "Most used" chips in the add-transaction form. It runs as the
  caller, so the transactions read policy limits it to your own household.
- `invites` — pending/used invite links. Only a SHA-256 hash of each link's
  token is stored; the link itself is shown once, when it's created.
- `transactions` — the actual entries: `type` (income/expense), `amount`,
  `date`, `category`, `note`, `author_id`/`author_email`. Entries created by a recurring
  rule or a debt payment also carry `recurring_rule_id` / `debt_id` (set only by the
  database functions below, never by the app directly).
- `recurring_rules` — monthly income/expense rules. `materialize_recurring()` turns due
  rules into transactions when someone opens the app (at most one per rule per date).
  Recurring entries are only created when the app is opened. For fully automatic daily runs,
  schedule `materialize_recurring` with Supabase's **pg_cron** (Database → Cron).
- `debts` — credit cards, loans, mortgages. `log_debt_payment()` lowers the balance and
  records the matching expense in one step; deleting that expense restores the balance.

Row-level security means each person only ever sees their own household's
data and their housemates' names, and can only delete transactions they
added themselves — enforced in Postgres, not just in the UI. Passwords are
handled entirely by Supabase Auth (stored as bcrypt hashes); the app never
stores or logs them.

## Icons

Replace `public/icon-192.png` and `public/icon-512.png` with your own
app icon before deploying (placeholders aren't included in this
scaffold — add your own square PNGs at those two sizes).
