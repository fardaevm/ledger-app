import "./style.css";
import { supabase } from "./supabaseClient.js";

const EXPENSE_CATS = ["Rent & Housing","Groceries","Transport","Utilities","Subscriptions","Dining & Entertainment","Shopping","Health & Fitness","Travel","Software & Tools","Other"];
const INCOME_CATS = ["Salary","Freelance","Business","Investment","Gifts","Other"];

const $ = (id) => document.getElementById(id);
const view = {
  auth: $("view-auth"),
  reset: $("view-reset"),
  household: $("view-household"),
  status: $("view-status"),
  app: $("view-app")
};

function showView(name) {
  Object.keys(view).forEach((k) => (view[k].style.display = k === name ? "" : "none"));
}

// ---------------------------------------------------------------------------
// what the URL says we're here for — read before supabase-js consumes the hash
// ---------------------------------------------------------------------------
const INVITE_PATH = /^\/invite\/([0-9a-fA-F]{64})\/?$/;
const inviteFromUrl = location.pathname.match(INVITE_PATH)?.[1].toLowerCase() ?? null;
const badInviteUrl = !inviteFromUrl && location.pathname.startsWith("/invite/");
const hashParams = new URLSearchParams(location.hash.slice(1));
// Email links land with "#...&type=recovery" (reset password) or an error when expired/used.
const arrivedFromRecoveryLink = hashParams.get("type") === "recovery";
const emailLinkError = hashParams.get("error_description");

// Take secrets out of the address bar and history once we've read them.
function cleanUrl() {
  if (location.pathname !== "/" || location.hash) history.replaceState(null, "", "/");
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  session: null,
  routedUserId: null,     // which signed-in user the screens were last set up for
  recovering: arrivedFromRecoveryLink, // true until the new password is saved
  pendingInvite: inviteFromUrl,        // raw invite token, redeemed once signed in
  household: null,
  names: {},              // user id -> display name, from profiles
  inviteLink: null,
  tx: [],
  periodMode: "monthly",           // "monthly" | "annual"
  selectedMonth: currentMonthKey(), // "YYYY-MM"
  selectedYear: currentYear(),
  formType: "expense",
  breakdownType: "expense",
  realtimeChannel: null
};

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function monthLabel(y, m) {
  return new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
function currentYear() {
  return new Date().getFullYear();
}
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// auth
// Passwords are read from their input only inside the submit handler that sends
// them to Supabase Auth (HTTPS, hashed server-side), then the input is cleared.
// They are never stored in state, logged, put in a URL, or shown in a message.
// ---------------------------------------------------------------------------
const MIN_PASSWORD = 8;

function setHint(id, message, isError = false) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function setBusy(buttonId, busy) {
  $(buttonId).disabled = busy;
}

// Where Supabase should send people back to from email links. Keeps a pending
// invite in the path so it survives the confirm-your-email round trip.
function returnUrl() {
  return location.origin + (state.pendingInvite ? `/invite/${state.pendingInvite}` : "/");
}

// Maps Supabase Auth errors to our own wording. We never echo error.message, so
// nothing a server or proxy puts in there can reach the screen.
function authErrorMessage(error, fallback) {
  if (!error) return fallback;
  if (error.status === 429 || /rate_limit/.test(error.code || "")) return "Too many attempts. Wait a minute, then try again.";
  if (error.name === "AuthRetryableFetchError" || error.status === 0) return "Couldn't reach the server. Check your connection and try again.";
  switch (error.code) {
    case "invalid_credentials":
      return "Email or password is incorrect. If you used to sign in with an email link, use “Reset your password to set one” below.";
    case "email_not_confirmed":
      return "Confirm your email first. We sent you a link when you created your account.";
    case "weak_password":
      return "That password is too easy to guess. Try a longer one, or a few unrelated words.";
    case "same_password":
      return "Choose a password you haven't used here before.";
    case "signup_disabled":
      return "New accounts are turned off for this app.";
    default:
      return fallback;
  }
}

function showAuthTab(tab) {
  const signIn = tab === "signIn";
  $("authTabs").hidden = tab === "forgot";
  $("signInForm").hidden = !signIn;
  $("signUpForm").hidden = tab !== "signUp";
  $("forgotForm").hidden = tab !== "forgot";
  [["tabSignIn", signIn], ["tabSignUp", tab === "signUp"]].forEach(([id, on]) => {
    $(id).classList.toggle("active", on);
    $(id).setAttribute("aria-selected", String(on));
  });
}

function showAuthView() {
  $("authInviteNote").hidden = !state.pendingInvite;
  showAuthTab(state.pendingInvite ? "signUp" : "signIn");
  showView("auth");
}

$("tabSignIn").addEventListener("click", () => showAuthTab("signIn"));
$("tabSignUp").addEventListener("click", () => showAuthTab("signUp"));
$("backToSignIn").addEventListener("click", () => showAuthTab("signIn"));
function openForgot() {
  $("forgotEmail").value = $("signInEmail").value.trim();
  setHint("forgotHint", "");
  showAuthTab("forgot");
  $("forgotEmail").focus();
}
$("showForgot").addEventListener("click", openForgot);
$("setPasswordLink").addEventListener("click", openForgot);

$("signInForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("signInEmail").value.trim();
  const passwordInput = $("signInPassword");
  $("resendConfirm").hidden = true;
  setHint("signInHint", "");
  setBusy("signInSubmit", true);
  const { error } = await supabase.auth.signInWithPassword({ email, password: passwordInput.value });
  passwordInput.value = "";
  setBusy("signInSubmit", false);
  if (error) {
    setHint("signInHint", authErrorMessage(error, "Couldn't sign you in. Try again."), true);
    $("resendConfirm").hidden = error.code !== "email_not_confirmed";
  }
  // On success, onAuthStateChange takes it from here.
});

$("signUpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("signUpName").value.trim();
  const email = $("signUpEmail").value.trim();
  const passwordInput = $("signUpPassword");
  $("resendSignup").hidden = true;
  if (!name) return setHint("signUpHint", "Enter your name, so your partner knows who added what.", true);
  if (passwordInput.value.length < MIN_PASSWORD) {
    return setHint("signUpHint", `Use at least ${MIN_PASSWORD} characters for your password.`, true);
  }
  setHint("signUpHint", "");
  setBusy("signUpSubmit", true);
  const { data, error } = await supabase.auth.signUp({
    email,
    password: passwordInput.value,
    options: { data: { display_name: name }, emailRedirectTo: returnUrl() }
  });
  passwordInput.value = "";
  setBusy("signUpSubmit", false);
  if (error) return setHint("signUpHint", authErrorMessage(error, "Couldn't create your account. Try again."), true);

  if (data.session) {
    // A session straight from sign-up means "Confirm email" is OFF in the Supabase
    // dashboard. The app still works, but say so loudly rather than skip it silently.
    console.warn(
      "[Ledger] Supabase created a session without email confirmation. " +
        "Turn on Authentication > Sign In / Providers > Email > “Confirm email”."
    );
    return;
  }
  // Same message whether or not the address already has an account, so the form
  // can't be used to find out who is registered.
  setHint("signUpHint", `Almost done: we sent a confirmation link to ${email}. Open it to finish creating your account.`);
  $("resendSignup").hidden = false;
});

async function resendConfirmation(email, hintId) {
  if (!email) return setHint(hintId, "Enter your email above first.", true);
  const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: returnUrl() } });
  setHint(
    hintId,
    error
      ? authErrorMessage(error, "Couldn't resend the email. Try again in a minute.")
      : "If that account is waiting to be confirmed, a new link is on its way.",
    Boolean(error)
  );
}
$("resendConfirm").addEventListener("click", () => resendConfirmation($("signInEmail").value.trim(), "signInHint"));
$("resendSignup").addEventListener("click", () => resendConfirmation($("signUpEmail").value.trim(), "signUpHint"));

$("forgotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  setBusy("forgotSubmit", true);
  const { error } = await supabase.auth.resetPasswordForEmail($("forgotEmail").value.trim(), { redirectTo: returnUrl() });
  setBusy("forgotSubmit", false);
  // Only rate-limit / network problems are reported; "no such account" never is.
  if (error && (error.status === 429 || error.name === "AuthRetryableFetchError")) {
    return setHint("forgotHint", authErrorMessage(error, ""), true);
  }
  setHint("forgotHint", "If there's an account for that email, we've sent a link to set a new password. Check your inbox (and spam).");
});

function showResetView(session) {
  $("resetUsername").value = session?.user?.email ?? "";
  setHint("resetHint", "");
  showView("reset");
  $("resetPassword").focus();
}

$("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("resetPassword");
  const confirmPw = $("resetConfirm");
  if (pw.value.length < MIN_PASSWORD) return setHint("resetHint", `Use at least ${MIN_PASSWORD} characters.`, true);
  if (pw.value !== confirmPw.value) return setHint("resetHint", "The two passwords don't match.", true);
  setBusy("resetSubmit", true);
  const { error } = await supabase.auth.updateUser({ password: pw.value });
  pw.value = "";
  confirmPw.value = "";
  setBusy("resetSubmit", false);
  if (error) return setHint("resetHint", authErrorMessage(error, "Couldn't save your password. Request a new link and try again."), true);

  // End any other sessions for this account (e.g. a device someone else had).
  await supabase.auth.signOut({ scope: "others" }).catch(() => {});
  state.recovering = false;
  // Mark this user as routed so the USER_UPDATED event doesn't route them a second time.
  state.routedUserId = state.session?.user?.id ?? null;
  cleanUrl();
  enterApp();
});

$("signOutBtn").addEventListener("click", async () => {
  await supabase.auth.signOut();
});

// ---------------------------------------------------------------------------
// routing after sign-in: invite -> household -> ledger
// ---------------------------------------------------------------------------
function showStatus(title, message, actionLabel, action) {
  $("statusTitle").textContent = title;
  $("statusMessage").textContent = message;
  const btn = $("statusAction");
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || "";
  btn.onclick = action || null;
  showView("status");
}

const INVITE_ERRORS = {
  invalid_invite: ["This invite link isn't valid", "Make sure you opened the whole link, or ask your partner to send a new one."],
  invite_used: ["This invite was already used", "Each link works once. Ask your partner to send you a new one."],
  invite_expired: ["This invite has expired", "Invite links last 7 days. Ask your partner to send you a new one."],
  already_in_household: [
    "You're already in a household",
    "Your account already has its own household with entries in it, so it can't join another one. Sign in with a different account to accept this invite."
  ]
};

async function enterApp() {
  if (badInviteUrl) {
    cleanUrl();
    return showStatus(...INVITE_ERRORS.invalid_invite, "Continue", loadHousehold);
  }
  if (state.pendingInvite) {
    const token = state.pendingInvite;
    state.pendingInvite = null;
    cleanUrl();
    showStatus("Joining household…", "");
    const { error } = await supabase.rpc("redeem_invite", { raw_token: token });
    if (error) {
      const [title, message] = INVITE_ERRORS[error.message] ?? ["Couldn't accept the invite", "Something went wrong. Try opening the link again."];
      return showStatus(title, message, "Continue", loadHousehold);
    }
    state.justJoined = true;
  }
  cleanUrl();
  loadHousehold();
}

async function loadHousehold() {
  const { data, error } = await supabase
    .from("household_members")
    // "*" rather than a column list, so a missing profit_goal_override (migration not run yet)
    // degrades to an automatic goal instead of failing the whole household load.
    .select("household:households(*)")
    .limit(1)
    .maybeSingle();

  if (error) {
    return showStatus("Couldn't load your household", "Check your connection and try again.", "Try again", loadHousehold);
  }
  if (!data) {
    setHint("householdHint", "");
    showView("household");
    return;
  }
  state.household = data.household;
  $("hhTitle").textContent = state.household.name;
  await loadNames();
  const notice = $("noticeBanner");
  notice.hidden = !state.justJoined;
  notice.textContent = state.justJoined ? `You've joined ${state.household.name}. Welcome!` : "";
  state.justJoined = false;
  showView("app");
  startLedger();
}

// Display names for "added by". Falls back to the email prefix if profiles is unavailable.
async function loadNames() {
  const { data } = await supabase.from("profiles").select("id, display_name");
  state.names = Object.fromEntries((data || []).map((p) => [p.id, p.display_name]));
}

$("createHouseholdForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  setHint("householdHint", "");
  setBusy("hhSubmit", true);
  const { error } = await supabase.rpc("create_household", { hname: $("hhName").value.trim() });
  setBusy("hhSubmit", false);
  if (error) return setHint("householdHint", "Couldn't create your household. Try again.", true);
  loadHousehold();
});

// ---------------------------------------------------------------------------
// invite panel (inside the app)
// ---------------------------------------------------------------------------
const INVITE_CREATE_ERRORS = {
  too_many_invites: "You already have 10 unused invite links. Use one, or wait for them to expire.",
  not_a_member: "You're not a member of this household anymore. Reload the app."
};

async function openInvitePanel() {
  $("invitePanel").hidden = false;
  $("inviteBtn").setAttribute("aria-expanded", "true");
  $("inviteShare").hidden = !navigator.share;
  $("inviteActions").classList.toggle("single", !navigator.share);
  if (state.inviteLink) return;

  // The token is shown only now; the database keeps just its hash, so a link can't be
  // looked up again later. Reopening the panel reuses this session's link.
  $("inviteLink").value = "";
  setHint("inviteHint", "Creating a link…");
  const { data, error } = await supabase.rpc("create_invite", { hid: state.household.id });
  if (error) {
    console.error("[Ledger] create_invite failed:", error.code, error.message);
    const message =
      error.code === "PGRST202"
        ? "Invites aren't set up in the database yet. Run the latest migration from supabase/schema.sql."
        : INVITE_CREATE_ERRORS[error.message] ?? "Couldn't create a link. Try again.";
    return setHint("inviteHint", message, true);
  }
  state.inviteLink = `${location.origin}/invite/${data}`;
  $("inviteLink").value = state.inviteLink;
  setHint("inviteHint", "");
}

function closeInvitePanel() {
  $("invitePanel").hidden = true;
  $("inviteBtn").setAttribute("aria-expanded", "false");
  $("inviteBtn").focus();
}

$("inviteBtn").addEventListener("click", () => ($("invitePanel").hidden ? openInvitePanel() : closeInvitePanel()));
$("inviteClose").addEventListener("click", closeInvitePanel);
$("inviteLink").addEventListener("focus", (e) => e.target.select());
$("inviteCopy").addEventListener("click", async () => {
  if (!state.inviteLink) return;
  try {
    await navigator.clipboard.writeText(state.inviteLink);
    setHint("inviteHint", "Link copied. Send it to your partner.");
  } catch {
    $("inviteLink").select();
    setHint("inviteHint", "Couldn't copy automatically. The link is selected; copy it from there.", true);
  }
});
$("inviteShare").addEventListener("click", () => {
  if (state.inviteLink) navigator.share({ title: "Join our Ledger", url: state.inviteLink }).catch(() => {});
});

// ---------------------------------------------------------------------------
// ledger (main app view)
// ---------------------------------------------------------------------------
function populateCategorySelect() {
  const sel = $("fCategory");
  const cats = state.formType === "expense" ? EXPENSE_CATS : INCOME_CATS;
  sel.innerHTML = cats.map((c) => `<option value="${c}">${c}</option>`).join("");
}

// t.date is "YYYY-MM-DD", so prefix matching filters by period without timezone math.
function filteredTx() {
  const prefix = state.periodMode === "monthly" ? state.selectedMonth : String(state.selectedYear);
  return state.tx.filter((t) => t.date.startsWith(prefix + "-"));
}

// Earliest transaction month through the current month. Future-dated entries
// extend the end so they stay reachable.
function monthRange() {
  let first = currentMonthKey();
  let last = first;
  for (const t of state.tx) {
    const k = t.date.slice(0, 7);
    if (k < first) first = k;
    if (k > last) last = k;
  }
  return [first, last];
}

function periodOptions() {
  const [first, last] = monthRange();
  const out = [];
  if (state.periodMode === "annual") {
    for (let y = Number(last.slice(0, 4)); y >= Number(first.slice(0, 4)); y--) {
      out.push({ value: String(y), label: String(y) });
    }
    return out;
  }
  let [y, m] = last.split("-").map(Number);
  for (;;) {
    const key = y + "-" + String(m).padStart(2, "0");
    out.push({ value: key, label: monthLabel(y, m - 1) });
    if (key <= first) break;
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

function renderPeriodControls() {
  const monthly = state.periodMode === "monthly";
  const selected = monthly ? state.selectedMonth : String(state.selectedYear);
  const opts = periodOptions();
  if (!opts.some((o) => o.value === selected)) {
    opts.push({ value: selected, label: monthly ? monthLabel(+selected.slice(0, 4), +selected.slice(5) - 1) : selected });
    opts.sort((a, b) => b.value.localeCompare(a.value));
  }

  const sel = $("periodValue");
  // Only rebuild when the list changes, so a realtime update doesn't close a dropdown the user has open.
  const sig = state.periodMode + "|" + opts.map((o) => o.value).join(",");
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    sel.dataset.sig = sig;
  }
  sel.value = selected;
  sel.setAttribute("aria-label", monthly ? "Month" : "Year");
  $("periodMode").value = state.periodMode;
}

function setSyncStatus(mode) {
  const dot = $("syncDot");
  const label = $("syncLabel");
  dot.className = "sync-dot" + (mode === "live" ? " live" : mode === "off" ? " off" : "");
  label.textContent = mode === "live" ? "Synced" : mode === "off" ? "Not connected" : "Connecting…";
}

function render() {
  renderPeriodControls();

  const list = filteredTx();
  let income = 0, expense = 0;
  list.forEach((t) => { if (t.type === "income") income += Number(t.amount); else expense += Number(t.amount); });
  const profit = income - expense;

  $("sumIncome").textContent = fmtMoney(income);
  $("sumExpense").textContent = fmtMoney(expense);
  const profitEl = $("sumProfit");
  profitEl.textContent = fmtMoney(profit);
  profitEl.classList.toggle("negative", profit < 0);
  profitEl.classList.toggle("positive", profit >= 0);
  renderRings(income, expense, profit);

  const sorted = list.slice().sort((a, b) => b.date.localeCompare(a.date) || new Date(b.created_at) - new Date(a.created_at));
  const body = $("txBody");
  const empty = $("emptyState");
  const myId = state.session?.user?.id;

  if (sorted.length === 0) {
    body.innerHTML = "";
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
    body.innerHTML = sorted.map((t) => {
      const d = new Date(t.date + "T00:00:00");
      const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const who = state.names[t.author_id] || (t.author_email ? t.author_email.split("@")[0] : "—");
      const canDelete = myId && t.author_id === myId;
      return `
        <tr>
          <td class="tx-date">${dateStr}</td>
          <td class="tx-cat">${t.category}</td>
          <td class="tx-note">${t.note ? escapeHtml(t.note) : '<span style="color:var(--text-dim)">—</span>'}</td>
          <td class="tx-who">${escapeHtml(who)}</td>
          <td class="tx-amt ${t.type}">${t.type === "expense" ? "-" : "+"}${fmtMoney(Math.abs(Number(t.amount)))}</td>
          <td>${canDelete ? `<button class="tx-del" data-id="${t.id}">Delete</button>` : ""}</td>
        </tr>`;
    }).join("");
  }

  renderBreakdown(list);
  renderTrend();
}

// Share of the selected period that has elapsed: past periods are complete, future ones not started.
function periodElapsed() {
  const now = new Date();
  if (state.periodMode === "monthly") {
    const current = currentMonthKey();
    if (state.selectedMonth < current) return 1;
    if (state.selectedMonth > current) return 0;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() / daysInMonth;
  }
  const y = now.getFullYear();
  if (state.selectedYear < y) return 1;
  if (state.selectedYear > y) return 0;
  const DAY = 86400000;
  const dayOfYear = (Date.UTC(y, now.getMonth(), now.getDate()) - Date.UTC(y, 0, 1)) / DAY + 1;
  const daysInYear = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / DAY;
  return dayOfYear / daysInYear;
}

function setRing(id, fraction) {
  const el = $(id);
  const pct = Math.min(1, Math.max(0, fraction)) * 100;
  el.style.strokeDasharray = pct + " 100";
  // A round-capped zero-length stroke still draws a dot, so hide empty rings.
  el.style.visibility = pct > 0 ? "visible" : "hidden";
}

const DEFAULT_MONTHLY_GOAL = 3000;

function fmtWhole(n) {
  return "$" + Math.round(n).toLocaleString();
}

// The automatic goal: average profit of earlier periods of the same type that have any
// transactions, or the default when there are none (or when they averaged a loss).
function automaticGoal() {
  const monthly = state.periodMode === "monthly";
  const months = monthly ? 1 : 12;
  const keyLength = monthly ? 7 : 4;
  const selected = monthly ? state.selectedMonth : String(state.selectedYear);

  const profitByPeriod = {};
  for (const t of state.tx) {
    const key = t.date.slice(0, keyLength);
    if (key >= selected) continue;
    profitByPeriod[key] = (profitByPeriod[key] || 0) + (t.type === "income" ? 1 : -1) * Number(t.amount);
  }
  const profits = Object.values(profitByPeriod);
  const average = profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

  if (average > 0) return { amount: average, source: "average", periods: profits.length };
  return { amount: DEFAULT_MONTHLY_GOAL * months, source: "default", periods: profits.length };
}

function profitGoal() {
  const override = Number(state.household?.profit_goal_override);
  if (override > 0) {
    return { amount: override * (state.periodMode === "monthly" ? 1 : 12), source: "custom" };
  }
  return automaticGoal();
}

function renderRings(income, expense, profit) {
  const goal = profitGoal();
  const progress = profit / goal.amount;
  const spent = income > 0 ? expense / income : 0;
  const elapsed = periodElapsed();

  setRing("ringProfit", progress); // setRing floors a loss at an empty ring
  setRing("ringExpense", spent);
  setRing("ringPeriod", elapsed);

  $("ringProfitPct").textContent = Math.round(progress * 100) + "%";
  $("ringGoalText").textContent = "of " + fmtWhole(goal.amount) + " goal";
  $("ringSpentPct").textContent = income > 0 ? Math.round(spent * 100) + "%" : "—";
  $("ringPeriodPct").textContent = Math.round(elapsed * 100) + "%";
  $("ringPeriodUnit").textContent = state.periodMode === "monthly" ? "month" : "year";

  if (!$("goalEditor").hidden) renderGoalHint();
}

// ---------------------------------------------------------------------------
// profit goal editor (inline, inside the Profit card)
// ---------------------------------------------------------------------------
const goalToggles = document.querySelectorAll(".goal-toggle");
let goalOpener = null;

function renderGoalHint(message) {
  const hint = $("goalHint");
  hint.classList.toggle("error", Boolean(message));
  if (message) {
    hint.textContent = message;
    return;
  }
  const auto = automaticGoal();
  const monthlyAuto = state.periodMode === "monthly" ? auto.amount : auto.amount / 12;
  const autoText =
    auto.source === "average"
      ? `the average profit of your ${auto.periods} earlier ${state.periodMode === "monthly" ? "month" : "year"}${auto.periods === 1 ? "" : "s"} (${fmtWhole(monthlyAuto)}/month)`
      : auto.periods
        ? `the ${fmtWhole(DEFAULT_MONTHLY_GOAL)}/month default, because earlier periods averaged a loss`
        : `the ${fmtWhole(DEFAULT_MONTHLY_GOAL)}/month default until you have earlier periods`;
  const custom = Number(state.household?.profit_goal_override) > 0;
  hint.textContent =
    (custom ? "Custom goal. Automatic would be " : "Automatic: ") +
    autoText +
    "." +
    (state.periodMode === "annual" ? " Annual view uses 12× the monthly goal." : "");
}

function openGoalEditor(opener) {
  goalOpener = opener;
  const override = Number(state.household?.profit_goal_override);
  const input = $("goalInput");
  input.value = override > 0 ? override : "";
  const auto = automaticGoal();
  input.placeholder = Math.round(state.periodMode === "monthly" ? auto.amount : auto.amount / 12);
  $("goalReset").disabled = !(override > 0);
  renderGoalHint();
  $("goalEditor").hidden = false;
  goalToggles.forEach((b) => b.setAttribute("aria-expanded", "true"));
  input.focus();
}

function closeGoalEditor() {
  $("goalEditor").hidden = true;
  goalToggles.forEach((b) => b.setAttribute("aria-expanded", "false"));
  goalOpener?.focus();
}

async function saveGoal(value) {
  const buttons = [$("goalSave"), $("goalReset")];
  buttons.forEach((b) => (b.disabled = true));
  // .select() so a silently-blocked update (RLS: zero rows) is reported instead of looking saved.
  const { data, error } = await supabase
    .from("households")
    .update({ profit_goal_override: value })
    .eq("id", state.household.id)
    .select("profit_goal_override");
  buttons.forEach((b) => (b.disabled = false));
  if (error || !data?.length) {
    renderGoalHint("Couldn't save the goal. Check your connection and try again.");
    return;
  }
  state.household.profit_goal_override = data[0].profit_goal_override;
  closeGoalEditor();
  render();
}

goalToggles.forEach((btn) =>
  btn.addEventListener("click", () => ($("goalEditor").hidden ? openGoalEditor(btn) : closeGoalEditor()))
);
$("goalClose").addEventListener("click", closeGoalEditor);
$("goalEditor").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeGoalEditor();
});
$("goalEditor").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = Math.round(parseFloat($("goalInput").value) * 100) / 100;
  if (!(value > 0)) {
    renderGoalHint("Enter a monthly amount above $0.");
    $("goalInput").focus();
    return;
  }
  saveGoal(value);
});
$("goalReset").addEventListener("click", () => saveGoal(null));

// ---------------------------------------------------------------------------
// Daily activity charts for the selected month (Monthly mode only)
// ---------------------------------------------------------------------------
const dayKey = (d) =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Every day of the selected month, 1st to last. Days after today simply have no bar.
function trendDays() {
  const [y, m] = state.selectedMonth.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  return Array.from({ length: count }, (_, i) => new Date(y, m - 1, i + 1));
}

function sparkHtml(name, type, days, totals) {
  const monthName = monthLabel(days[0].getFullYear(), days[0].getMonth());
  const values = days.map((d) => totals[type][dayKey(d)] || 0);
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(...values);
  const peak = days[values.indexOf(max)];
  const activeDays = values.filter((v) => v > 0).length;
  const summary = max
    ? `${name}, ${shortDate(days[0])} to ${shortDate(days.at(-1))}: ${fmtMoney(total)} over ${activeDays} day${activeDays === 1 ? "" : "s"}; highest ${fmtMoney(max)} on ${shortDate(peak)}.`
    : `${name}: none in ${monthName}.`;

  const bars = values
    .map((v, i) => {
      const title = `${shortDate(days[i])}: ${fmtMoney(v)}`;
      return v > 0
        ? `<span style="height: max(2px, ${(v / max) * 100}%)" title="${title}"></span>`
        : `<span class="zero" title="${title}"></span>`;
    })
    .join("");
  // 1st, 10th, 20th and last day
  const ticks = [0, 9, 19, days.length - 1]
    .map((i) => `<span style="grid-column: ${i + 1}">${shortDate(days[i])}</span>`)
    .join("");

  return `
    <figcaption><span class="spark-name">${name}</span><b>${fmtMoney(total)}</b></figcaption>
    <div class="spark-plot" role="img" aria-label="${summary}">
      ${max ? `<span class="spark-max">${fmtWhole(max)}</span>` : `<span class="spark-empty">No ${name.toLowerCase()} in ${monthName}</span>`}
      <div class="spark-bars" style="--days: ${days.length}" aria-hidden="true">${bars}</div>
    </div>
    <div class="spark-axis" style="--days: ${days.length}" aria-hidden="true">${ticks}</div>`;
}

function renderTrend() {
  const section = $("trend");
  section.hidden = state.periodMode !== "monthly";
  if (section.hidden) return;

  const days = trendDays();
  const first = dayKey(days[0]);
  const last = dayKey(days.at(-1));
  const totals = { income: {}, expense: {} };
  for (const t of state.tx) {
    if (t.date < first || t.date > last) continue;
    totals[t.type][t.date] = (totals[t.type][t.date] || 0) + Number(t.amount);
  }

  $("trendRange").textContent = `${shortDate(days[0])} – ${shortDate(days.at(-1))}`;
  $("sparkIncome").innerHTML = sparkHtml("Income", "income", days, totals);
  $("sparkExpense").innerHTML = sparkHtml("Expenses", "expense", days, totals);
}

function renderBreakdown(list) {
  const type = state.breakdownType;
  const subset = list.filter((t) => t.type === type);
  const totals = {};
  subset.forEach((t) => { totals[t.category] = (totals[t.category] || 0) + Number(t.amount); });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 0;
  const el = $("breakdown");
  if (entries.length === 0) {
    el.innerHTML = `<div class="empty" style="padding:16px;">No ${type} entries yet.</div>`;
    return;
  }
  el.innerHTML = entries.map(([cat, amt]) => {
    const pct = max ? Math.round((amt / max) * 100) : 0;
    return `
      <div class="bar-row">
        <div class="bar-top"><span>${cat}</span><span class="amt">${fmtMoney(amt)}</span></div>
        <div class="bar-track"><div class="bar-fill ${type}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

$("periodMode").addEventListener("change", (e) => {
  state.periodMode = e.target.value;
  state.selectedMonth = currentMonthKey();
  state.selectedYear = currentYear();
  render();
});
$("periodValue").addEventListener("change", (e) => {
  if (state.periodMode === "monthly") state.selectedMonth = e.target.value;
  else state.selectedYear = Number(e.target.value);
  render();
});

const form = $("entryForm");
const addToggle = $("addToggle");
addToggle.addEventListener("click", () => {
  form.classList.add("open");
  $("fDate").value = new Date().toISOString().slice(0, 10);
  $("formError").textContent = "";
  $("fAmount").focus();
});
$("cancelEntry").addEventListener("click", () => {
  form.classList.remove("open");
  form.reset();
});
$("typeExpense").addEventListener("click", () => setFormType("expense"));
$("typeIncome").addEventListener("click", () => setFormType("income"));
function setFormType(t) {
  state.formType = t;
  $("typeExpense").classList.toggle("active", t === "expense");
  $("typeIncome").classList.toggle("active", t === "income");
  populateCategorySelect();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = parseFloat($("fAmount").value);
  if (!amount || amount <= 0) return;
  const errorEl = $("formError");
  const saveBtn = $("saveEntryBtn");
  errorEl.textContent = "";
  saveBtn.disabled = true;

  const payload = {
    household_id: state.household.id,
    type: state.formType,
    amount,
    date: $("fDate").value,
    category: $("fCategory").value,
    note: $("fNote").value.trim(),
    author_id: state.session.user.id,
    author_email: state.session.user.email
  };

  try {
    const { error } = await supabase.from("transactions").insert(payload);
    if (error) throw error;
    form.reset();
    form.classList.remove("open");
    state.selectedMonth = payload.date.slice(0, 7);
    state.selectedYear = Number(payload.date.slice(0, 4));
  } catch (err) {
    errorEl.textContent = "Couldn't save that entry. Try again.";
  } finally {
    saveBtn.disabled = false;
  }
});

$("txBody").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("tx-del")) return;
  const id = e.target.getAttribute("data-id");
  await supabase.from("transactions").delete().eq("id", id);
});

$("breakdownToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-t]");
  if (!btn) return;
  state.breakdownType = btn.getAttribute("data-t");
  document.querySelectorAll("#breakdownToggle button").forEach((b) => b.classList.toggle("active", b === btn));
  render();
});

async function startLedger() {
  populateCategorySelect();
  renderPeriodControls();
  setSyncStatus("connecting");

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("household_id", state.household.id)
    .order("date", { ascending: false })
    .limit(1000);

  if (error) {
    setSyncStatus("off");
    $("permBanner").style.display = "block";
    $("permBanner").textContent = "Couldn't load transactions. Reload to try again.";
    return;
  }
  state.tx = data;
  setSyncStatus("live");
  render();

  if (state.realtimeChannel) supabase.removeChannel(state.realtimeChannel);
  state.realtimeChannel = supabase
    .channel("transactions-" + state.household.id)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "transactions", filter: `household_id=eq.${state.household.id}` },
      (payload) => {
        if (payload.eventType === "INSERT") {
          if (!state.tx.some((t) => t.id === payload.new.id)) state.tx.push(payload.new);
        } else if (payload.eventType === "UPDATE") {
          state.tx = state.tx.map((t) => (t.id === payload.new.id ? payload.new : t));
        } else if (payload.eventType === "DELETE") {
          state.tx = state.tx.filter((t) => t.id !== payload.old.id);
        }
        render();
      }
    )
    .subscribe((status) => {
      setSyncStatus(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" ? "off" : "connecting");
    });
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------
function resetSignedInState() {
  if (state.realtimeChannel) supabase.removeChannel(state.realtimeChannel);
  Object.assign(state, { routedUserId: null, household: null, names: {}, inviteLink: null, tx: [], realtimeChannel: null });
  $("invitePanel").hidden = true;
  $("noticeBanner").hidden = true;
}

function handleAuthEvent(event, session) {
  if (event === "PASSWORD_RECOVERY") state.recovering = true;
  if (state.recovering && session) return showResetView(session);

  if (!session) {
    resetSignedInState();
    if (emailLinkError && !state.shownLinkError) {
      // e.g. an expired or already-used confirmation / reset link
      state.shownLinkError = true;
      $("authLinkError").textContent = "That email link has expired or was already used. Request a new one below.";
      $("authLinkError").hidden = false;
      if (!state.pendingInvite) cleanUrl();
    }
    return showAuthView();
  }
  // Token refreshes and profile updates don't change which screen we're on.
  if (state.routedUserId === session.user.id) return;
  state.routedUserId = session.user.id;
  enterApp();
}

// INITIAL_SESSION fires once on load (with or without a saved session), so this is
// the single entry point. Supabase advises against calling other Supabase methods
// inside this callback, so the work is deferred a tick.
supabase.auth.onAuthStateChange((event, session) => {
  state.session = session;
  setTimeout(() => handleAuthEvent(event, session), 0);
});
