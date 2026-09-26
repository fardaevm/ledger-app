# Ledger — design system

A shared expense ledger for a two-person household, checked daily, mostly on phones.
It should feel calm, clear and trustworthy. This file describes the system **as it
exists in `src/style.css`** — update it in the same change whenever you change a token
or one of the rules below.

## Colour tokens

All colours come from CSS custom properties on `:root`. Never hard-code a colour in a
component rule; add or reuse a token. (Exception: the primary-button hover `#4338CA`
and the `#fff` text on filled primary buttons.)

Some names are legacy from an earlier "ledger book" palette and no longer describe the
hue — `--brass` is indigo, `--rust` is red. Keep the names; they're referenced everywhere.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | `#F8FAFC` | `#0B1120` | Page background, control backgrounds |
| `--paper-2` | `#F1F5F9` | `#131C31` | Recessed surfaces (entry form, banners, row hover) |
| `--paper-3` | `#E2E8F0` | `#1E293B` | Reserved for a third surface level |
| `--raised` | `#FFFFFF` | `#131C31` | Elevated surface — currently only the Profit hero card |
| `--ink` | `#0F172A` | `#E2E8F0` | Strong UI fill (active toggle, desktop Add button), header rule |
| `--ink-2` | `#1E293B` | `#CBD5E1` | Hover for `--ink` fills |
| `--text` | `#0F172A` | `#F1F5F9` | Body text |
| `--text-dim` | `#64748B` | `#94A3B8` | Secondary text, labels, metadata |
| `--line` | `#E2E8F0` | `#263244` | Borders, dividers, empty bar tracks |
| `--brass` | `#4F46E5` | `#6366F1` | Accent: primary buttons, focus rings, links-in-state, expense category bars |
| `--green` | `#059669` | `#059669` | Income, positive profit, "live" sync dot |
| `--green-bg` | `#ECFDF5` | `#0B2A21` | Tint behind active "Income" toggle |
| `--rust` | `#DC2626` | `#DC2626` | Expenses, negative profit, errors, delete hover |
| `--rust-bg` | `#FEF2F2` | `#34181A` | Tint behind active "Expense" toggle, warning banner |
| `--activity-green` | `#9BE821` | same | Activity graphics: Profit-goal ring, Income daily bars (Apple Exercise green) |
| `--activity-red` | `#FA114F` | same | Activity graphics: Expenses ring, Expenses daily bars (Apple Move red-pink) |
| `--activity-cyan` | `#00E5FF` | same | Activity graphics: Period ring (Apple Stand cyan) |

Dark mode follows `prefers-color-scheme` only; there is no manual theme switch.

**Money colour rule:** income is always `--green`, expenses always `--rust`, and profit
takes whichever applies to its sign. Don't use these two for anything decorative.

> **Deliberate exception — the activity graphics.** The rings and the daily charts use
> hues from Apple Fitness's palette (`--activity-*` tokens), *not* `--green`/`--rust`.
> They point the same way as the money rule (green = profit goal / income, red =
> expenses), but they're brighter, Apple-derived hues. The rings are **not** in Apple's
> order: Apple's outer ring is red and its middle ring green, and this app deliberately
> swaps them. Tokens are named by colour, not role, because the same green means "profit
> goal" in the rings and "income" in the charts.
> **Don't replace `--activity-*` with `--green`/`--rust`, don't re-order the rings to match
> Apple, and use `--activity-*` only in the activity graphics (rings, ring legend, daily
> charts).**

**Text contrast:** body-size text (under 18px) must be `--text` or `--text-dim` on
`--paper`/`--paper-2`. `--green`, `--rust` and `--brass` are fine for large numbers and
graphics but fall below 4.5:1 for small text in at least one mode. Put small coloured
information in a swatch next to `--text`/`--text-dim` text instead (see the ring legend).
The expense amounts in transaction rows (14px `--rust` on the dark background, about
4:1) currently break this rule; they predate it.

## Typography

One family: **Plus Jakarta Sans** (Google Fonts, weights 400–800, loaded in
`index.html`). Hierarchy comes from size and weight, never from a second typeface.
Every element that shows money uses `font-variant-numeric: tabular-nums`.

| Role | Size / weight | Notes |
|---|---|---|
| Brand wordmark (auth screens) | 34px / 800 | `letter-spacing: -0.02em` |
| Household name (`header h1`) | 32px / 800 · 22px on mobile | `-0.02em` |
| **Profit (hero figure)** | 52px / 800 desktop → 36px at 375px (`clamp(36px, 7vw, 52px)`) | Must stay the largest type on the page |
| Income / Expenses figures | 24px / 700 · 17–22px on mobile | |
| Section eyebrow (`ENTRIES`, `BY CATEGORY`) | 12px / 700 | uppercase, `letter-spacing: 0.06em`, `--text-dim` |
| Body, table cells, inputs | 14px / 400–500 | |
| Buttons | 14px / 600 | |
| Segmented toggles | 13px / 600 | same weight in every state |
| Field labels, metadata | 11–12px | `--text-dim` |
| Header period dropdowns | 14px / 600 · **16px on mobile** | 16px stops iOS Safari zooming on focus |

## Spacing, radius, layout

- **Content width:** `.wrap` max 1020px; side gutter 24px desktop, **16px mobile**.
- **Breakpoint:** one breakpoint at `max-width: 720px`. Below it the two-column
  layout (ledger 1.6fr / category aside 1fr, 40px gap) collapses to one column.
- **Radius:** `6px` for controls (buttons, inputs, selects, toggles); `8px` for
  containers (entry form, banners, empty states, summary cards); `50%` for dots;
  bars use half their height.
- **Control sizing:** buttons `10px 18px` padding; toggle segments `8px 12px`. Inside the
  entry form every control is a fixed 40px tall (see "Add-transaction form").
- **Borders:** 1px `--line` everywhere, except the 2px `--ink` rule under the header.

### Mobile conventions (≤ 720px)

- Header is sticky; the tagline is hidden; the period dropdowns get their own row so
  switching Monthly/Annual never reflows the header.
- "+ Add transaction" becomes a full-width fixed bar at the bottom (hidden while the
  entry form is open). `.wrap` bottom padding reserves room for it.
- The transaction table becomes stacked two-line rows: note + amount, then
  date · category · who. **Who added an entry must stay visible** — it's a two-person app.
- Nothing may cause horizontal scrolling at 375px.

## Components and standing rules

### Paired and grouped buttons must be visually symmetrical

> Any two or more buttons presented as a pair, toggle or segmented group must be
> visually symmetrical: **equal width via `flex: 1` where they're a toggle, and equal
> height, padding, border-radius, font size and font weight always.**

- Toggles (`.auth-tabs`, `.type-toggle`, `aside .toggle-set`) share one rule
  set. Segments are `flex: 1`. The active state changes **colour only** — never font
  weight, which would change width.
- Dividers between segments come from the container (`gap: 1px` on a `--line`
  background), not a border on one segment, which would make the halves unequal by 1px.
- An action pair (Cancel / Save entry) is two **equal halves** that differ only in fill.
  `.btn-primary` and `.btn-secondary` share one box model; the primary has a transparent
  1px border so its height matches the bordered secondary.
- The header's Monthly/Annual dropdowns follow the same rule: identical padding, size
  and weight.
- Equal-width grids use `repeat(n, minmax(0, 1fr))`, never plain `1fr 1fr`. Plain `1fr`
  won't shrink below its content, so a long label ("Reset to automatic") makes one half
  wider on narrow screens. When a label may wrap, use `min-height` rather than `height`,
  so the grid row grows both buttons together.

### Summary section — Profit is the hero (intentional)

> **Profit is deliberately the visual headline of the summary. Do not "rebalance"
> it back into three equal boxes.** Income and Expenses are its supporting detail.

- Structure, with a 16px gap (12px on mobile) between each: the full-width Profit hero
  card; Income and Expenses as a pair of equal boxes (`flex: 1`, same padding and
  height — the symmetry rule applies to these boxes too); the "Day by day" chart card
  (Monthly mode only); then the ENTRIES / BY CATEGORY section.
- The hero is set apart by treatment, not only size: `--raised` background, a 3px
  `--brass` accent along the top edge (an inset shadow, so it follows the radius) and a
  soft drop shadow.
- The card spans the full content width, but its content (`.hero-inner`) is capped at
  **760px and centred**. On wide screens the figure and the rings/legend stay one unit,
  with quiet space inside the card's edges, instead of drifting to opposite sides
  (385px apart before the cap, 223px after, at the widest layout). Below ~820px viewport
  width the cap has no effect.
- Inside that, one wrapping flex row: the figure on the left, rings + legend on the right.
  When there isn't room (375px), the rings + legend wrap under the figure.
- Rings and legend stay side by side at desktop widths (`.hero-detail` doesn't wrap).
  Don't make that group wrap above the 720px breakpoint: a wrapping flex group is sized to
  its widest child, which pushes the legend under the rings even when there's room. On
  mobile it does wrap, so on the narrowest phones (~320px) the legend drops under the rings.

### Activity rings (inside the Profit hero)

Three concentric SVG rings styled after Apple Fitness's activity rings, drawn with
`pathLength="100"` and `stroke-dasharray`. No chart library. Colours: see the exception
under "Colour tokens".

| Position | Ring | Colour | Fill | Legend |
|---|---|---|---|---|
| Outer | **Profit** | `--activity-green` | profit ÷ goal (see below) | "52% of $3,000 goal" |
| Middle | **Expenses** | `--activity-red` | expenses ÷ income for the period | "63% spent"; "—" when income is 0 |
| Inner | **Period** | `--activity-cyan` | share of the selected period elapsed (past = 100%, future = 0%) | "83% of month" |

- Every ring is **capped at a full circle**, and a negative value draws an **empty** ring.
  The legend always shows the real number ("142% of $3,000 goal", "-14% of $2,883 goal").
- **No dark backing.** The rings sit directly on the card; there's no disc or fill
  behind them. The unfilled part of each ring is `--line`, the same neutral used for
  empty category-bar tracks, not a tint of the ring colour.
- **Known trade-off:** on the white light-mode card the green (1.5:1) and cyan (1.5:1)
  arcs are below the 3:1 guideline for graphics; red is 4.0:1. In dark mode all three
  are ≥ 4.2:1. The legend carries every value in text, so no information depends on
  seeing the arcs. If this needs fixing, give `--activity-green`/`--activity-cyan` darker
  light-mode values rather than re-adding a dark backing.
- **Legend:** 14px. Figures are `--text` bold, words `--text-dim`. The ring colour appears
  only in a 12px **hollow** swatch (a 3px coloured ring, transparent centre), matching the
  main rings. Don't colour the legend text itself: the ring colours are unreadable as
  text on white.
- Removed rings, and why (don't bring them back without a new reason): **Saved** always
  equalled 100% − Spent, so it added nothing. **Pace** (spending vs. the same share of
  last period) was dropped in favour of the Profit goal.

#### Profit goal

The goal is a **monthly** figure; Annual view uses 12× it.

1. **Custom:** if `households.profit_goal_override` is set, it's always the goal.
2. **Adaptive:** otherwise, the average profit of all *earlier* periods of the same type
   (earlier months in Monthly mode, earlier years in Annual mode). Only periods with at
   least one transaction count, so a gap month nobody logged doesn't drag it down to $0.
3. **Default:** $3,000/month ($36,000/year) when there are no earlier periods, or when
   they average a loss (a loss can't be a target).

**Setting it:** clicking the rings or the pencil next to the Profit legend line opens an
inline editor inside the hero card (not a modal). It has one amount field, **Save goal**
and **Reset to automatic** (an equal-width pair, disabled when there's no custom goal) and
a hint explaining where the automatic figure comes from. Esc or × closes it and returns
focus to the opener. Saving is a direct update to the household row. It uses `.select()`
so an update that RLS silently blocks (zero rows) is shown as an error, not a success.

**Database:** `profit_goal_override numeric null check (> 0)`, with a members-only UPDATE
policy on `households`. Column grants mean the client can change *only* this column;
name, invite code and creator stay read-only. See the dated migration at the end of
`supabase/schema.sql`.

### "Day by day" charts (Monthly mode only)

Daily bar charts styled after Apple Fitness's activity charts: one bar per day, dotted
grey gridlines at the top and middle, a dotted baseline in the series colour, the
highest day's value labelled top-left ("$2,195", like Apple's "24Cal") and four date
ticks. Plain HTML/CSS grid, no chart library.

- **Two charts, each on its own scale**: Income (`--activity-green`) and Expenses
  (`--activity-red`). A shared scale would flatten daily spending under one paycheck.
  Each chart's top label states its own scale. Side by side on desktop, stacked at
  ≤ 720px.
- **Window: the whole selected month, 1st to last day** (28–31 bars; the grid takes its
  column count from `--days`). It is *not* a rolling 30 days: the user wants "September"
  to mean Sep 1 – Sep 30. In the current month, days after today simply have no bar yet.
  Ticks mark the 1st, 10th, 20th and last day.
- Because both show the same month, each chart's total always equals the Income /
  Expenses box above it.
- Days with no activity have no bar (the dotted baseline shows through); any non-zero
  day is at least 2px tall. Each bar has a native tooltip ("Sep 3: $4,200.00"), and each
  plot has an `aria-label` summary (total, active days, highest day).
- Hidden in Annual mode.
- Same light-mode caveat as the rings: the green bars are faint on white (~1.5:1).

### Add-transaction form

- One CSS grid: two equal columns on desktop (Amount | Date, Category | Note), one
  column at ≤ 720px. The `.field-row` wrappers are `display: contents`, so every field
  sits on the same grid lines.
- **Every control in the form is 40px tall**: the Expense/Income toggle, inputs, the date
  input, the Category select and both buttons. Set heights explicitly; native date and
  select controls otherwise size themselves differently from text inputs.
- The Expense/Income toggle and the Cancel / Save pair span the full width, so their
  halves line up with the two field columns.
- Selects use the same CSS chevron as the header dropdowns (`.select-wrap`), not the
  native arrow.
- On mobile, inputs and selects are 16px (iOS zooms the page on focus below that).
- The error line takes its own full-width row and is hidden while empty.

### Auth and onboarding screens

Sign in / Create account, Set a new password, Name your household, and a generic
status screen (invite results, load errors) all use the centred `.auth-card` (max
360px) with the wordmark on top.

- **Sign in / Create account** is a segmented `.auth-tabs` toggle (symmetry rule
  applies). An invite link opens straight on **Create account**, with an indigo-edged
  note saying you've been invited.
- The sign-in form always shows the **"First time signing in with a password?"** note.
  It's how people who joined before password sign-in find the reset flow, so don't hide
  it behind a link.
- Secondary actions (Forgot password?, Resend confirmation email, Back to sign in) are
  `.text-link` buttons: indigo, underlined, 13px/600.
- **Error messages** (`.hint.error`) are `--text`, 600 weight, with a 3px `--rust` rule
  on the left, *not* red text. Small `--rust` text fails contrast in dark mode. The same
  applies to any new error line.
- Messages are our own wording, never Supabase's raw `error.message`. Account-probing
  answers are identical either way ("If there's an account for that email…"), so the
  forms can't reveal who has an account.
- Fields follow the app's field style (40px tall, 16px text on mobile). Password fields
  use `autocomplete="current-password"` / `"new-password"` so password managers work, and
  have **no `name` attribute**, so a native form submission can never put a password in
  a URL.
- The in-app **Invite partner** panel is an inline card under the sync bar, not a modal:
  a read-only link field, then **Share… / Copy link** as an equal pair (just Copy link
  where the browser has no share sheet).

### Period selector

Two native `<select>` elements, not a custom popup, so keyboard and screen-reader
support come for free. They're styled with `appearance: none` and a CSS-drawn chevron,
which follows the theme through `--text-dim`. The second list is generated from the actual
range of transaction dates and always includes the current month/year.
