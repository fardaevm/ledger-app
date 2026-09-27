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
| `--paper-2` | `#F1F5F9` | `#131C31` | Recessed surfaces (banners, row hover, inline payment form) |
| `--paper-3` | `#E2E8F0` | `#1E293B` | Reserved for a third surface level |
| `--raised` | `#FFFFFF` | `#131C31` | Elevated surface — currently only the Profit hero card |
| `--ink` | `#0F172A` | `#E2E8F0` | Strong UI fill (active toggle, desktop Add button), header rule |
| `--ink-2` | `#1E293B` | `#CBD5E1` | Hover for `--ink` fills |
| `--text` | `#0F172A` | `#F1F5F9` | Body text |
| `--text-dim` | `#64748B` | `#94A3B8` | Secondary text, labels, metadata |
| `--line` | `#E2E8F0` | `#263244` | Borders, dividers, empty bar tracks |
| `--brass` | `#4F46E5` | `#6366F1` | Accent: primary buttons, focus rings, links-in-state, expense category bars |
| `--green` | `#059669` | `#059669` | Income, positive profit, debt paid-off progress |
| `--green-bg` | `#ECFDF5` | `#0B2A21` | Tint behind active "Income" toggle |
| `--rust` | `#DC2626` | `#DC2626` | Expenses, negative profit, errors, delete hover, a debt's "needs attention" dot (never debt by default) |
| `--rust-bg` | `#FEF2F2` | `#34181A` | Tint behind active "Expense" toggle, warning banner |
| `--activity-green` | `#9BE821` | same | Activity graphics: Profit-goal ring, Income daily bars (Apple Exercise green) |
| `--activity-red` | `#FA114F` | same | Activity graphics: Expenses ring, Expenses daily bars (Apple Move red-pink) |
| `--activity-cyan` | `#00E5FF` | same | Activity graphics: Period ring (Apple Stand cyan) |

Dark mode follows `prefers-color-scheme` only; there is no manual theme switch.

**Money colour rule:** income is always `--green`, expenses always `--rust`, and profit
takes whichever applies to its sign. Don't use these two for anything decorative.

**Red means "needs attention", never "debt exists".** A debt is money being paid down, not a
problem in itself. So on debts, progress made (paid-off amounts, bars, milestones) is
`--green`, what's left is plain `--text` / `--text-dim`, and informational notes (like the
interest note) use a neutral `--line` rule. `--rust` appears on a debt **only** as the
attention flag: a small red dot with dark text, for a debt with a balance and no payment
logged in over 45 days (`ATTENTION_DAYS`, counted from when it was added if it never had
one). There's no due date in the data yet, so "missed minimum payment" can't be flagged. If a
due date is added, that's the other case that earns red. A payment still shows as a red
expense in Transactions: that's the money rule (money going out), not the debt.

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

- **Content width: one cap for the whole app, `--content-max` = 820px.** `.wrap` (header plus
  every view) is at most 820px of content, centred, with empty space either side on wide
  screens. It matches the Profit hero (760px content cap plus its padding). **New views get it
  automatically: don't add per-view or per-card `max-width`s to stop things stretching.**
  Below 820px it has no effect: views fill the width exactly as before. Side gutter 24px
  desktop, **16px mobile**.
- **Tables inside the cap stay one line per row** (desktop). Category and note split the
  leftover width and truncate with "…", with the full text in a tooltip (`title`).
- **Breakpoint:** the mobile breakpoint is `max-width: 720px`. Separately, the Dashboard's
  two-column layout (ledger 2fr / category aside 1fr, 32px gap) is used only when the content
  column gets its full 820px (viewport ≥ 1088px). Narrower, By Category stacks below the
  ledger, because the table would otherwise truncate every cell.
- **Radius:** `6px` for controls (buttons, inputs, selects, toggles); `8px` for
  containers (banners, empty states, summary cards, cards); `50%` for dots;
  bars use half their height.
- **Control sizing:** buttons `10px 18px` padding; toggle segments `8px 12px`. Inside the
  sheet form every control is a fixed 40px tall (see "Sheet form layout").
- **Borders:** 1px `--line` everywhere, except the 2px `--ink` rule under the header.

### Mobile conventions (≤ 720px)

- Header is sticky; the tagline is hidden; the period dropdowns get their own row so
  switching Monthly/Annual never reflows the header.
- "+ Add transaction" becomes a full-width fixed bar at the bottom; its form opens as a
  bottom sheet (see "Sheets"). `.wrap` bottom padding reserves room for the bar.
- The transaction table becomes stacked two-line rows: note + amount, then
  date · category · who. **Who added an entry must stay visible** — it's a two-person app.
  Rows are compact (10px vertical padding, about 59px each at 375px).
- **Lists are dense rows, not tall cards.** A list item shows what you scan for (name, amount,
  status) in one or two lines. Anything else goes behind a disclosure (see Debts). At 375px,
  aim for at least 4 items visible between the header and the add bar.
- Nothing may cause horizontal scrolling at 375px.

## App shell and views

- **Four views:** Dashboard, Transactions, Recurring and Debts. Switching is a state variable
  plus show/hide (`showAppView()` in `src/main.js`), the same pattern as the auth screens. There's
  no router and no URL per view: the URL hash is reserved for Supabase's email-link tokens.
- **One `<nav>`, two layouts.** Desktop: a 220px sticky left sidebar (`--paper-2`), with the
  selected item in the ink fill like the other toggles. **At ≤ 720px the same element becomes a
  fixed 4-tab bar** (`--tabbar-h` = 60px). The selected tab gets an indigo icon and a short
  indigo bar on top. All four views stay one tap away; no hamburger menu.
- **The header is global.** The household name and the account icon are on every view. The
  Monthly/Annual dropdowns show **only on Dashboard and Transactions** (the period-filtered
  views) and are hidden on Recurring, Debts and Members. There is **no sync status** anywhere;
  realtime updates simply arrive, and a failed load shows the error banner.
- **Account icon + dropdown: the one home for identity and account actions.** Never add
  header links (no "Sign out" or "Invite" text links). A 40px round person icon sits at the end
  of the header row on desktop and beside the household name on mobile (negative block margins
  keep the tap target without making the title row taller). It opens a dropdown anchored below
  it, right-aligned, 272px wide, in this order:
  1. Identity (not interactive): display name (`profiles`) and email (the session's).
  2. — **Members** (opens the Members page) · **Invite partner** (opens the invite panel
     directly)
  3. — **Edit display name** (inline field inside the dropdown: Cancel / Save as an equal
     pair; Escape closes just the field) · **Change password** (sends Supabase's reset email to
     your own address; the result shows as a hint inside the dropdown)
  4. — **Sign out**, de-emphasised (13px, muted) in its own group.
  It's a disclosure (`aria-expanded` / `aria-controls`), not `role="menu"`, because it holds a
  non-interactive block and a form. Opening it focuses the first item. Escape closes it and
  returns focus to the icon, and a click or focus outside closes it. Items are 40px tall, 44px
  on mobile. New account-level actions go into this dropdown, in the matching group.
- **Members page** (`#viewMembers`): a full view reached **only** from the dropdown, not the
  nav (so no tab is highlighted). A "‹ Back" button returns to the view you came from. Opening
  it pushes a history entry, so the browser's or phone's Back works too; the URL doesn't
  change. Leaving by Back or by a nav tab pops that entry, so the two Backs agree. It shows one
  bordered list (initial avatar, name with a "You" tag on your row, email, "Member for N
  months" with the exact date in the tooltip), then **Invite partner**. Other members' emails
  come from the `household_roster()` function (auth.users isn't readable from the app). Before
  its migration is run, the page shows names and join dates, only your own email, and a hint.
- **Mobile action bar** (`.add-toggle` at ≤ 720px): each view's primary action becomes one bar
  fixed **directly above the tab bar**, and it must be **pixel-identical on every view**. Only
  the label and the action change. Height is `--actionbar-h` (44px, next to `--tabbar-h`:
  60px), padding `0 16px`, 14px / 500 text, square corners, full width, `border-box`. All of
  it is set in that one mobile rule. **Never style `.add-toggle` per view on mobile**: any
  view-specific tweak (like the Transactions toolbar's 40px inline size) goes inside
  `@media (min-width: 721px)`. That toolbar rule once leaked into mobile and made
  Transactions' bar 4px shorter, so the bottom of the screen jumped between tabs. Anything
  positioned against the bar (the page's bottom padding, the payment toast) uses the tokens,
  never a literal 44. Its form opens in a sheet over everything. This is the app's one add affordance: don't
  add a separate floating "+" button. **The bar is the view's primary action, which can depend
  on state.** On Debts it's "+ Add debt" until there's a debt with a balance, then "Log a
  payment" (see Debts view). Derive the label, action and any secondary "+" from state at
  render time, never as two hard-coded layouts. The "+ Add transaction" button isn't
  duplicated: `#entryArea` (just the button now; the form lives in `#txSheet`) moves into
  whichever of Dashboard/Transactions is showing (`.entry-slot`).
- Inside the grid, `.wrap` needs `width: 100%`: auto margins on a grid item would otherwise
  shrink it to its content.

### Transactions view

- The full list for the selected period, 15 per page (same row renderer and inline delete
  confirmation as the Dashboard list, which stays as the 5-most-recent preview).
- **All / Expenses / Income** is a segmented toggle (symmetry rule; `aria-pressed`, ink fill)
  plus a search box matching category or note, over the already-loaded transactions. The
  footer says "(filtered from N)" when a filter is active.
- **Sticky toolbar (`.tx-toolbar`).** The add button, filter and search share one bar that
  sticks while the list scrolls. Desktop: one row, stuck at `top: 0`. Mobile: the add button
  is the shared fixed add bar (no separate floating "+" button), so the toolbar holds only the
  filter (fixed 204px, three equal segments) and search (the rest) on **one 59px row**. It sticks
  at `top: var(--header-h)`, which a ResizeObserver on `header.top` keeps current, because the
  header's height changes by view and width. The add form opens in a sheet, so the toolbar
  never has to make room for it.
- Dashboard keeps its own By Category panel and Expenses/Income toggle: Transactions is for
  finding an entry, Dashboard for the overview.
- Entries created by a recurring rule carry a small neutral **"Recurring"** badge. They are
  otherwise ordinary entries (same permissions, deletable by their author).

### Recurring view

- **One bordered list, one row per rule** (`.rule-list` / `.rule-row`, dividers between rows,
  about 63px each at 375px). Line 1: name (or category) and the amount in the money colour.
  Line 2: "Category · Next Oct 1" ("Category · Paused · 5th" when paused, plus "· Sara" when
  the rule is someone else's). The **Active switch** (`role="switch"`) spans both lines on the
  right, in a 44px-tall hit area, with no text label; its state is in the accessible name and
  tooltip. No expand/collapse. Paused rows dim the name and amount. The switch's "on" colour is
  `--brass`, not green (green/red are money-only). Only the rule's creator can flip it; others
  see it disabled with the reason in its tooltip.
- **Add rule** opens in a sheet (`#ruleSheet`) with the same form layout, type toggle and grouped category list. Days go up
  to 28 so every month has one. If the chosen day has **already passed** this month, a checkbox
  asks whether to add this month's entry now. It's **off by default**, since it was probably
  already entered by hand; off means the rule starts next month.
- Resuming a paused rule after its day has passed also starts it next month (no backdated entry).
- **How entries get created:** on app load (and when the app returns to the foreground,
  at most every 30 s) the app calls `materialize_recurring()`. It runs server-side in one
  transaction with row locks, and a unique `(recurring_rule_id, date)` constraint guarantees at
  most one auto-entry per rule per date, so both phones opening at once can't double-insert.
  Each rule records the last month it handled, so a **deleted auto-entry is never re-created**.
- **Known limitation:** this only happens when someone opens the app. If nobody does for a
  month, that month's entries are created late, and only for the current month (missed months
  aren't back-filled). The robust version is a Supabase **pg_cron** job calling the same
  function daily for every household; the function is already written so it could.

### Debts view

- **Lead with progress, not what's owed.** Every total is framed as "$X paid off". What's left
  is carried by the bar and spelled out only under "More info".
- **Debt-free journey** (`#debtJourney`, top of the view, the page's headline): all debts
  combined as one path from Start to $0. The math is the honest aggregate, `sum(original) −
  sum(current)` over `sum(original)`, **never an average of per-debt percentages** (that would
  understate progress on the biggest debt). The percentage is **exact to one decimal and
  rounded down** ("30.8%"; 49.96% shows 49.9%, never an early 50.0%; 100% is "100%"), so a
  milestone never shows before it's truly reached. Exactly three things:
  - **"$X paid off"** in large `--green`, alone on its row. No eyebrow label (the page is
    already titled "Debts"), no "to go of" subtitle, no "of the way to debt-free" caption.
  - A 10px track with a green fill (it animates from the last value via the registered
    property `--p`), milestone **dots** at 25 / 50 / 75% (filled green once reached, with the
    percentage only as a hover tooltip), and a **green flag at $0**: outlined in `--green`
    until you get there, filled green once you do. It's never grey (a finish line isn't
    "inactive") and never a ring colour (those belong to the Profit rings only).
  - **One caption row under the bar:** **Start** · the **percentage** · **$0**. No floating
    tooltip, no printed 25/50/75%, no "next milestone" sentence.
    - The percentage is **plain `--green` text (13px / 800)**, under the end of the fill:
      at `p%` of the row, shifted back by `p%` of its own width (left-aligned at 0%,
      right-aligned at 100%, always covering the fill point). Near either end it stops
      beside "Start" or "$0" instead of overlapping them. It's positioned in pixels by
      `placeJourneyPct()`, re-run on resize and when "Start" changes width, and it slides with
      the fill. (Green at 13px is ~3.8:1, the same as income amounts in the ledger.)
    - **"Start" is a toggle** (a real `<button>`, `aria-pressed`): tapping shows the total
      starting debt across all debts ("$29,200.00 total"), tapping again goes back to "Start".
      See "Tappable labels" under Components.
  Screen readers still get the full picture from the bar's `aria-valuetext` ("30.8% paid off,
  $20,200.00 to go of $29,200.00"). Total debt isn't shown on the Dashboard; the journey
  lives only here.
- **Compact card, about 106px at 375px.** Row 1: the **name only** (the type is secondary
  detail: it heads "More info"), and **"$X paid off"** on the right. Row 2: a 6px **green progress bar** (`role="progressbar"`). Then the
  attention flag when it applies ("● No payment in 60 days": the red dot already says "needs
  attention", which is visually hidden text for screen readers only), then actions. **No
  "$Y left · N% paid off" line**: that restated the top of the same card.
- **Actions are a primary plus secondaries, not a pair** (a deliberate exception to the symmetry
  rule), each sized to its content, never stretched. **The action row mirrors the top row's
  two columns:**
  - **Left:** **Log a payment** (primary fill), starting on the name's left edge. A paid-off
    debt shows "Paid off" instead.
  - **Right:** the "More info ▾" text disclosure and **Edit as a 36px pencil icon**
    (`.icon-btn`, `aria-label="Edit <name>"`), grouped in `.debt-secondary` and ending
    exactly where "$X paid off" ends.
  On a debt you can't edit there's no reserved icon slot: "More info" sits flush right (its
  text pulled 8px outward so the chevron lines up with the figure above). Same at every
  width.
- **More info** (`aria-expanded` / `aria-controls`, collapsed by default, expands inline under a
  divider; open state is per debt and survives re-renders) is where the secondary detail lives:
  a small uppercase **type** label ("CREDIT CARD"), then "$Y left of $Z · N% paid off · APR ·
  minimum", then the payoff estimate, the interest note,
  and the "Added by …" note. Each appears once: the estimate and interest note don't repeat
  the APR or minimum from the line above.
- **Payoff estimate** is plain arithmetic, `ceil(current_balance ÷ minimum_payment)` months:
  "Rough estimate: paid off around February 2028 (17 months), paying the minimum and ignoring
  interest." When an APR is set, an interest note (dark text, **neutral** `--line` rule) gives
  the monthly interest. If that interest is at least the minimum payment, it says the balance
  won't go down.
- **Primary action follows state** (`renderDebts()`, `#debtPrimary`). With no debt to pay
  (none yet, or all paid off) it's **"+ Add debt"**. Once any debt has a balance it's **"Log a
  payment"**, and adding moves to a 32px round **"+"** right beside the "Debts" title
  (`#debtTitleAdd`). It updates on every render, so it flips the moment the first debt is
  saved, with no reload. On mobile it's the fixed action bar in both states. **On desktop it
  appears only as "+ Add debt"**: in its "Log a payment" state it's hidden
  (`#debtPrimary[data-action="pay"]`), because each card has its own Log a payment and a lone
  button between the journey and the cards was redundant. (The payment sheet is therefore a
  mobile entry point.)
- **Add / edit debt** opens in a sheet (`#debtSheet`, title "Add a debt" or "Edit <name>"), from
  "+ Add debt", the title "+", or a card's Edit icon. After an edit, focus lands on that debt's
  re-rendered Edit button.
- **Log-a-payment sheet** (`#paySheet`, the shared sheet component, see "Sheets"). It holds:
  - a **Debt** dropdown listing every debt, with paid-off ones shown but disabled. A single
    payable debt is preselected; with several, it starts on "Choose a debt" and must be picked.
  - an **Amount** field, prefilled with that debt's minimum (capped at its balance).
  - one full-width **Log payment** button.
  The date is today. Focus returns to the primary button.
- **One payment action, two entry points.** A card's own **Log a payment** opens an inline
  form on that card (tapping it again closes it), prefilled with the minimum and today's date.
  Both it and the sheet call the same `logDebtPayment()`, so the save, the instant balance
  update and the celebration are literally the same code; the sheet just closes first. Never
  build a second payment path. `log_debt_payment()` lowers the balance **and** records a matching
  expense ("Loan & card payments", "Payment: <debt name>", linked by `debt_id`) in one database
  transaction. **Deleting that expense puts the amount back on the debt** (trigger), so the two
  never drift. Any household member can log a payment; only the creator can edit a debt.
- **A logged payment is celebrated, briefly.** The function returns the new balance, so the
  card and the journey update the moment it succeeds. Nothing waits on the animation. Then:
  - A toast (`#celebrate`, `role="status"`) with the concrete result: "$400.00 closer to
    debt-free" plus "You've now paid off 57% of Chase Prime". Special cases: "You've passed 50%
    of the way to debt-free" when a milestone is crossed, "<Debt> is paid off!" when one hits
    $0, and "You're debt-free!" when it was the last one.
  - A confetti burst (28 bits in green / indigo / cyan / lime, never red) from the tip of
    that debt's bar, or from the toast if the bar is off screen. The "Logged a $X payment"
    banner is inserted **before** measuring, because it pushes the page down.
  - Toast gone after 1.5 s, confetti after 1.3 s. Both are `pointer-events: none`, need no
    dismissing, and never block the page. Reduced motion skips the confetti and fill animation;
    the toast stays.
  - The calm "Logged a $X payment … also in Transactions" banner stays as the lasting record.

## Components and standing rules

### State each fact once

> Don't show the same fact twice on one screen in different phrasings. State it once, in
> the form that says it most directly: a number, a bar or a short label. Let visual elements
> (bars, dots, colour) carry meaning instead of adding a sentence that explains what they
> already show.

- Before adding a caption, check whether a number, bar or colour on the same screen already
  says it. If so, don't add the caption.
- Secondary detail (amount left, APR, minimums, estimates) goes behind a disclosure such as
  "More info", not on the default view. The same rule applies inside the disclosure.
- Words that only explain a visual (e.g. "Needs attention" next to a red dot) become
  visually hidden text for screen readers. They aren't deleted: screen readers can't see the
  visual.
- Reference: the Debts view went from 14 rows of text (80 words) to 7 rows (34 words) at
  375px with no fact lost.

### Tappable labels

> A piece of text that's also a control (e.g. "Start" under the debt journey, which toggles
> to "$29,200.00 total") must look interactive by more than colour: **`--brass` text AND an
> underline** (1px, offset 3px; 2px on hover), like a link.

- It's a real `<button>` (with `aria-pressed` when it toggles), not a clickable `<span>`.
- Enlarge the tap target with padding and cancel it with an equal negative margin, so the text
  stays exactly where a plain label would be.
- Plain labels never get an underline or `--brass`, so the two can't be confused.

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

### Sheets: the one pattern for add/edit forms

> Every add or edit form (transaction, recurring rule, debt, debt payment, and any future
> one) opens in a **sheet**: a `<dialog class="sheet">` containing a `<form class="sheet-form">`.
> Never expand a form inline on the page, and never build a second modal style.

- **One component.** Markup: `.sheet-grip`, a `.sheet-head` (a `.form-title` `h2` that the dialog
  is `aria-labelledby`, plus a `.goal-close` × with `data-sheet-close`), the fields, then the
  actions. JS: `openSheet(sheet, { opener, fallback, focus })` and `closeSheet(sheet)` in
  `main.js`. Every `dialog.sheet` is wired once, at load: Escape (the `cancel` event), a tap on
  the backdrop, and any `[data-sheet-close]` button (× and Cancel) all run the animated close.
  A sheet resets its own form in its `close` event, so Cancel, ×, Escape, backdrop and a
  successful save all leave it clean.
- **Native `<dialog>` + `showModal()`** gives the focus trap, the inert page behind and Escape
  for free. Focus goes into the first field on open and back to the `opener` on close,
  explicitly (Safari doesn't focus a tapped button, so `<dialog>`'s own restore would have
  nothing). If the opener was re-rendered away, `fallback` (an element, or a function
  returning one) is used.
- **Presentation depends on width (CSS only; same element, same JS):**
  - **≤ 720px (phones): a bottom sheet.** Full width, pinned to the bottom edge, 16px top
    corners, grip bar, slides up in 0.24 s and down in 0.18 s over a dimmed backdrop. It sits
    above the on-screen keyboard: `--kb`, set from `visualViewport`, lifts it. (That part
    needs checking on a real iPhone.)
  - **≥ 721px: a centred dialog**, 560px wide, 12px corners, no grip, fading/scaling in. A
    panel rising from the bottom of a large screen reads as a phone pattern, and expanding
    inline would push the list around. To make desktop a bottom sheet too, delete the
    `@media (min-width: 721px)` block under `dialog.sheet`.
  - Reduced motion: no slide or fade; it simply appears and disappears.
- `closeSheet()` resolves once the sheet is gone (with a 400ms fallback in case the animation
  never runs), so anything drawn afterwards, like the payment confetti, isn't under it.
- What stays inline, on purpose: the **delete confirmation** on a transaction row (a two-button
  confirm in place, not a form), a debt card's own **Log a payment** form, and **Edit display
  name** in the account menu (one field).

### Sheet form layout

- One CSS grid (`.sheet-form`): two equal columns on desktop (Amount | Date, Category | Note), one
  column at ≤ 720px. The `.field-row` wrappers are `display: contents`, so every field
  sits on the same grid lines.
- **Every control in the form is 40px tall** (the Cancel / Save pair is 44px, both halves
  alike): the Expense/Income toggle, inputs, the date input and the Category select. Set heights explicitly; native date and
  select controls otherwise size themselves differently from text inputs.
- Anything that isn't a field (grip, header, Expense/Income toggle, recent-category chips,
  checkbox rows, help text, errors, the Cancel / Save pair, a lone submit) spans the full
  width, so pairs line up with the two field columns.
- Selects use the same CSS chevron as the header dropdowns (`.select-wrap`), not the
  native arrow.
- On mobile, inputs and selects are 16px (iOS zooms the page on focus below that).
- **iOS Safari date inputs:** iOS draws `input[type=date]` as a native control with its own
  minimum width, so it ignores `width: 100%` and sticks out wider than the other fields.
  The fix is `appearance: none` on date inputs, scoped with
  `@supports (-webkit-touch-callout: none)` (iOS only), plus `min-width: 0` on every field.
  Desktop and Android Chromium never had the problem, so check this on a real iPhone.
- The error line takes its own full-width row and is hidden while empty.
- The default date is the **local** date (`dayKey(new Date())`), never `toISOString()`,
  which is UTC and already "tomorrow" on US evenings.

### Categories

- **Grouped, Plaid-style:** `CATEGORIES` in `src/main.js` has 12 expense groups (48
  categories) and 3 income groups (10). The recurring-rule form still uses a native grouped
  `<select>` (`fillCategorySelect`).
- **Add transaction: chips for the common case, a searchable picker for the rest.** The
  native select was replaced (it gave iPhone its wheel picker, but no search).
- **"Most used" chips** (up to 5, for the selected Expense/Income type) sit on a full-width row
  above Category. They're the household's **most frequently used** categories, by entry count
  over its **whole history**, ties alphabetical, not the most recent. Counts come from
  `category_usage()` (one GROUP BY in the database; the app only loads the newest 1,000 entries).
  Until that migration is run they're counted from the loaded entries. Fewer than 5 used
  means fewer chips, never placeholders. Old category names never appear. One tap sets the
  category; the chosen chip uses the toggles' ink/paper fill (`aria-pressed`). Counts refresh at
  start-up, on returning to the app and after each save, **never while the form is open**, so
  chips can't reorder under a finger.
- **Searchable picker** (`categoryPicker()`, an ARIA 1.2 combobox): a text `input role="combobox"`
  controlling a `role="listbox"` of `role="group"`s. The chosen name is in the hidden
  `#fCategory`; the text input shows it.
  - Tap/focus opens the **full grouped list**, with the current choice highlighted and its text
    selected, so typing starts a search. Typing filters by **category name, case-insensitive,
    across every group**; matching groups keep their headers. No results says so. A
    visually hidden `role="status"` announces the match count.
  - Keys: ↓/↑ move (`aria-activedescendant`), Enter picks (and never submits the form),
    Escape closes **only the list** (not the sheet around it), Tab moves on. Clicking an option
    picks it; the list keeps focus in the input while you choose.
  - Leaving the field with unfinished search text puts back the real choice. An empty choice
    fails native validation (`required` + `setCustomValidity`), so a search is never saved as
    a category.
  - The list opens **in the flow** under the input (max 264px, 232px on phones, scrolling only
    itself), not as a floating popover, which would be clipped by the sheet's scroll area. So
    Category and Note each take a full row. Options are 40px, 44px on phones. The keyboard
    position is a tinted row with an indigo edge; the current choice is bold with a ✓.
  - **In sync with the chips:** a chip sets the picker's value; any pick re-syncs the chips.
    Switching Expense/Income clears the choice and any search text, and reloads that type's
    chips.
- **No preselected category:** nothing is chosen until you tap a chip or pick from the list,
  so nothing gets filed under whatever happened to be first.
- Transactions store the category **name** as text. Renaming or regrouping means adding a
  dated `update transactions …` block to `supabase/schema.sql` (see MIGRATION
  2026-09-27), so old entries move with it.
- Category names come from the database when rendered, so always pass them through
  `escapeHtml()`. The same goes for any database text (names, notes, ids). It also escapes `"`
  and `'`, so its output is safe inside a quoted attribute (`aria-label="…"`, `title="…"`).

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
- The in-app **Invite partner** panel is an inline card, not a modal: a read-only link
  field, then **Share… / Copy link** as an equal pair (just Copy link where the browser has
  no share sheet). There is one panel, moved next to whatever opened it: under the header
  from the account menu, under the button on the Members page. Closing it returns focus there.

### Entries list length

- By default the list shows the **5 most recent** entries of the selected month/year, with
  "Showing 1–5 of N" and a **Show all N entries** button. The footer is hidden when there
  are 5 or fewer.
- **Show all** lists every entry, **15 per page**. Page numbers (`‹ 1 2 3 ›`, with "…" gaps
  past 7 pages) appear only when there are more than 15. **Show fewer** returns to 5.
- Changing the month, year or Monthly/Annual mode resets to the 5-entry default. Deleting
  the last entry on a page moves you to the new last page.
- Only the **list** is shortened. Totals, rings, the day-by-day charts and By Category always
  use every entry in the period.
- Page controls are equal 36px squares (symmetry rule); the current page uses the toggles'
  ink/paper fill and `aria-current="page"`. Changing page scrolls back to the top of the list
  (clearing the sticky header on mobile) and keeps keyboard focus on the page control.

### Deleting an entry

- **Who can delete:** a row shows "Delete" only when `author_id` equals the signed-in user's
  id. Your partner's entries never show it, and the database enforces the same rule
  ("authors delete their own transactions"). If no row shows Delete, check *which account*
  you're signed in as before touching this logic.
- **Inline confirmation, no modal, no `confirm()`:** clicking Delete swaps that row's action
  for **Cancel** (`.btn-secondary`) and **Confirm delete** (`.btn-danger`, the `--rust` fill).
  They're an equal pair (both as wide as the wider, 32px tall via `.btn-sm`). Cancel gets
  focus, so a reflexive Enter never deletes.
- **No layout shift:** the pair is absolutely positioned over the row's right edge (the action
  cell on desktop, the whole stacked row on mobile), and an invisible Delete button keeps the
  cell's width. A `<button>`, not a `<span>`, because buttons don't inherit the page font and
  the widths would differ.
- **One row at a time;** clicking anywhere else, or Esc, reverts it. Cancel and Esc return
  focus to that row's Delete. If the delete fails, the row stays in confirming mode with a
  message (dark text with a red rule, per the error style).
- **The row is removed as soon as the database confirms.** Supabase Realtime doesn't deliver
  DELETE events on a filtered channel, so the app doesn't wait for one. Your partner's deletes
  arrive when the app returns to the foreground (transactions are re-fetched then).
- There is exactly one delete path in the app (`deleteTransaction()` in `src/main.js`); any
  new one must go through the same confirmation.

### Period selector

Two native `<select>` elements, not a custom popup, so keyboard and screen-reader
support come for free. They're styled with `appearance: none` and a CSS-drawn chevron,
which follows the theme through `--text-dim`. The second list is generated from the actual
range of transaction dates and always includes the current month/year.
