import "./style.css";
import { supabase } from "./supabaseClient.js";

// Categories, grouped the way bank-data providers (e.g. Plaid) do. Each transaction stores
// the plain category name; renaming one needs a migration in supabase/schema.sql.
const CATEGORIES = {
  expense: [
    ["Housing", ["Rent / Mortgage", "Home maintenance", "Furniture & home goods"]],
    ["Bills & Utilities", ["Electricity & gas", "Water & trash", "Internet & phone", "Subscriptions & streaming", "Software & tools", "Home & renters insurance", "Other bills"]],
    ["Food", ["Groceries", "Restaurants & takeout", "Coffee"]],
    ["Transportation", ["Fuel", "Public transit", "Rideshare & taxi", "Parking & tolls", "Car payment", "Car insurance", "Car maintenance", "Other transportation"]],
    ["Health", ["Medical & dental", "Pharmacy", "Fitness", "Health insurance", "Other health"]],
    ["Personal Care", ["Laundry & dry cleaning", "Hair & beauty", "Clothing"]],
    ["Education", ["Tuition", "Books & supplies", "Courses"]],
    ["Family", ["Childcare", "Kids' activities", "Pets"]],
    ["Shopping & Fun", ["Shopping", "Entertainment", "Travel", "Gifts given"]],
    ["Fees & Fines", ["Tickets & citations", "Late fees", "Bank fees", "Government fees"]],
    ["Financial", ["Loan & card payments", "Taxes", "Life insurance", "Donations"]],
    ["Other", ["Other"]]
  ],
  income: [
    ["Work", ["Salary", "Freelance", "Rideshare & delivery driving", "Business"]],
    ["Other money in", ["Marketplace sales", "Investments & interest", "Refunds & reimbursements", "Gifts received", "Benefits"]],
    ["Other", ["Other"]]
  ]
};

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
  categoryUsage: null,    // [{ type, category, uses }] from category_usage(); null = not loaded
  journeyShowTotal: false, // Debts: "Start" under the journey bar shows the total starting debt
  members: [],            // Members page: [{ user_id, display_name, email, role, joined_at }]
  inviteLink: null,
  tx: [],
  periodMode: "monthly",           // "monthly" | "annual"
  selectedMonth: currentMonthKey(), // "YYYY-MM"
  selectedYear: currentYear(),
  formType: "expense",
  breakdownType: "expense",
  txExpanded: false,        // entries list: 5 most recent, or all (paged by 15)
  txPage: 1,
  view: "dashboard",        // dashboard | transactions | recurring | debts
  txFilter: "all",          // Transactions view: all | expense | income
  txQuery: "",
  txAllPage: 1,
  rules: [],
  debts: [],
  ruleType: "expense",
  editingDebtId: null,      // debt being edited in the debt form (null = adding)
  payingDebtId: null,       // debt whose "Log a payment" form is open
  expandedDebts: new Set(), // debts showing "More info"
  missing: { rules: false, debts: false }, // tables not created yet (migration not run)
  confirmingDeleteId: null, // row whose Delete is showing Cancel / Confirm delete
  deleteErrorId: null,
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
// Safe in text AND in quoted attributes: innerHTML escapes & < > but not quotes, and several
// templates put this output inside attr="…" (aria-label, title, data-*).
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

// Opened from the account menu (panel shows under the header) or from the Members page (under
// its button). One panel, moved into the slot next to whatever opened it; focus returns there.
async function openInvitePanel(slotId, opener) {
  state.inviteOpener = opener;
  $(slotId).append($("invitePanel"));
  $("membersInvite").setAttribute("aria-expanded", String(slotId === "inviteSlotMembers"));
  $("invitePanel").hidden = false;
  $("invitePanel").scrollIntoView({ block: "nearest" });
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
  $("membersInvite").setAttribute("aria-expanded", "false");
  // The menu's item is hidden once the menu closes, so focus the account button instead.
  const opener = state.inviteOpener && state.inviteOpener.checkVisibility() ? state.inviteOpener : $("accountBtn");
  state.inviteOpener = null;
  opener.focus();
}

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
// account menu (header icon): identity, Members, invite, display name, password, sign out
// ---------------------------------------------------------------------------
const myId = () => state.session?.user?.id;
const myEmail = () => state.session?.user?.email || "";
const myName = () => state.names[myId()] || myEmail().split("@")[0];

function openAccountMenu() {
  $("accountName").textContent = myName();
  $("accountEmail").textContent = myEmail();
  closeNameForm(false);
  setHint("accountHint", "");
  $("accountMenu").hidden = false;
  $("accountBtn").setAttribute("aria-expanded", "true");
  $("menuMembers").focus();
}
function closeAccountMenu(returnFocus = true) {
  if ($("accountMenu").hidden) return;
  $("accountMenu").hidden = true;
  $("accountBtn").setAttribute("aria-expanded", "false");
  if (returnFocus) $("accountBtn").focus();
}
$("accountBtn").addEventListener("click", () => ($("accountMenu").hidden ? openAccountMenu() : closeAccountMenu()));
$("account").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Escape in the name field backs out of the edit; anywhere else it closes the menu.
  if (!$("nameForm").hidden && $("nameForm").contains(e.target)) closeNameForm();
  else closeAccountMenu();
});
// A click or focus anywhere outside closes it (a disclosure, not a modal: nothing is trapped).
document.addEventListener("pointerdown", (e) => { if (!$("account").contains(e.target)) closeAccountMenu(false); });
document.addEventListener("focusin", (e) => { if (!$("account").contains(e.target)) closeAccountMenu(false); });

$("menuMembers").addEventListener("click", () => {
  closeAccountMenu(false);
  openMembers();
});
$("menuInvite").addEventListener("click", () => {
  closeAccountMenu(false);
  openInvitePanel("inviteSlotTop", $("accountBtn"));
  $("inviteCopy").focus();
});

function openNameForm() {
  setHint("accountHint", "");
  $("nameForm").hidden = false;
  $("menuEditName").setAttribute("aria-expanded", "true");
  $("nameInput").value = myName();
  $("nameInput").focus();
  $("nameInput").select();
}
function closeNameForm(returnFocus = true) {
  $("nameForm").hidden = true;
  $("menuEditName").setAttribute("aria-expanded", "false");
  if (returnFocus) $("menuEditName").focus();
}
$("menuEditName").addEventListener("click", () => ($("nameForm").hidden ? openNameForm() : closeNameForm()));
$("nameCancel").addEventListener("click", () => closeNameForm());
$("nameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    setHint("accountHint", "Enter a name.", true);
    return $("nameInput").focus();
  }
  if (name === myName()) return closeNameForm();
  setBusy("nameSave", true);
  // .select("id"): an update RLS filters out returns no rows rather than an error.
  const { data, error } = await supabase.from("profiles").update({ display_name: name }).eq("id", myId()).select("id");
  setBusy("nameSave", false);
  if (error || !data?.length) {
    if (error) console.error("[Ledger] saving the display name failed:", error);
    setHint("accountHint", error && !error.code ? "Couldn't reach the server. Check your connection and try again." : "Couldn't save your name. Try again.", true);
    return $("nameInput").focus();
  }
  state.names[myId()] = name;
  $("accountName").textContent = name;
  closeNameForm();
  setHint("accountHint", "Name saved.");
  // Names show in "Added by" everywhere.
  render();
  if (state.view === "recurring") renderRules();
  if (state.view === "debts") renderDebts();
  if (state.view === "members") renderMembers();
});

let sendingReset = false;
$("menuPassword").addEventListener("click", async () => {
  if (sendingReset) return;
  sendingReset = true;
  setHint("accountHint", "Sending…");
  const { error } = await supabase.auth.resetPasswordForEmail(myEmail(), { redirectTo: returnUrl() });
  sendingReset = false;
  if (error) return setHint("accountHint", authErrorMessage(error, "Couldn't send the email. Try again in a minute."), true);
  setHint("accountHint", `We've emailed ${myEmail()} a link to set a new password.`);
});

// ---------------------------------------------------------------------------
// Members page (from the account menu only). It pushes a history entry, so the browser's or
// phone's Back button leaves it too; the URL itself doesn't change.
// ---------------------------------------------------------------------------
function openMembers() {
  if (state.view !== "members") {
    state.membersReturn = state.view;
    showAppView("members");
    history.pushState({ ledgerView: "members" }, "");
  }
  $("membersViewTitle").focus();
  loadMembers();
}
// Leaving by our Back button or a nav tab pops that history entry, so the two Backs agree.
function leaveMembers(to) {
  if (history.state?.ledgerView === "members") {
    state.afterPop = to;
    history.back();
  } else {
    showAppView(to);
  }
}
window.addEventListener("popstate", () => {
  if (state.view === "members") showAppView(state.afterPop || state.membersReturn || "dashboard");
  state.afterPop = null;
});
$("membersBack").addEventListener("click", () => leaveMembers(state.membersReturn || "dashboard"));
$("membersInvite").addEventListener("click", () => {
  const openHere = $("invitePanel").hidden || !$("inviteSlotMembers").contains($("invitePanel"));
  if (openHere) openInvitePanel("inviteSlotMembers", $("membersInvite"));
  else closeInvitePanel();
});

async function loadMembers() {
  setHint("membersHint", "");
  const { data, error } = await supabase.rpc("household_roster", { hid: state.household.id });
  if (!error) {
    state.members = data;
  } else {
    // Until the migration adds household_roster: names and join dates, and only your own email
    // (other people's emails live in auth.users, which the app can't read directly).
    if (error.code !== "PGRST202") console.error("[Ledger] household_roster failed:", error);
    const res = await supabase.from("household_members").select("user_id, joined_at").eq("household_id", state.household.id).order("joined_at");
    if (res.error) {
      state.members = [];
      setHint("membersHint", "Couldn't load the members. Check your connection and try again.", true);
    } else {
      state.members = res.data.map((m) => ({ ...m, display_name: state.names[m.user_id] || null, email: m.user_id === myId() ? myEmail() : null }));
      if (error.code === "PGRST202") setHint("membersHint", "Other members' emails show once the latest migration from supabase/schema.sql has been run.");
    }
  }
  renderMembers();
}

function memberSince(joinedAt) {
  const days = Math.floor((Date.now() - new Date(joinedAt)) / 86400000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (days < 1) return "Joined today";
  if (days < 31) return `Member for ${plural(days, "day")}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `Member for ${plural(months, "month")}`;
  return `Member for ${plural(Math.floor(months / 12), "year")}`;
}

function renderMembers() {
  $("memberList").innerHTML = (state.members || [])
    .map((m) => {
      const me = m.user_id === myId();
      const name = (me ? myName() : m.display_name) || (m.email ? m.email.split("@")[0] : "Member");
      return `<li class="member-row">
        <span class="member-avatar" aria-hidden="true">${escapeHtml(name.charAt(0).toUpperCase())}</span>
        <p class="member-name">${escapeHtml(name)}${me ? ` <span class="you-tag">You</span>` : ""}</p>
        <p class="member-email">${m.email ? escapeHtml(m.email) : "Email not available"}</p>
        <p class="member-since" title="Joined ${escapeHtml(new Date(m.joined_at).toLocaleDateString())}">${memberSince(m.joined_at)}</p>
      </li>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// ledger (main app view)
// ---------------------------------------------------------------------------
// Grouped category <select> for a type. No preselected category: a deliberate choice
// (or a recent chip) beats a wrong default.
function fillCategorySelect(sel, type) {
  const placeholder = new Option("Choose a category", "", true, true);
  placeholder.disabled = true;
  sel.replaceChildren(placeholder);
  for (const [group, names] of CATEGORIES[type]) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group;
    names.forEach((name) => optgroup.append(new Option(name, name)));
    sel.append(optgroup);
  }
}

// ---------------------------------------------------------------------------
// Category picker: an ARIA 1.2 combobox, a text input that controls a grouped listbox.
// With no search text the list is the full grouped set; typing filters by category name,
// case-insensitive, across every group. The chosen name lives in a hidden input; the text
// input shows it, or the search while you type. Reusable: pass the elements and the groups.
// ---------------------------------------------------------------------------
function categoryPicker({ input, list, hidden, status, getGroups, onChange }) {
  let options = [];
  let active = -1;
  const isOpen = () => input.getAttribute("aria-expanded") === "true";

  function render(query) {
    const q = query.trim().toLowerCase();
    list.replaceChildren();
    options = [];
    getGroups().forEach(([group, names], gi) => {
      const matches = q ? names.filter((name) => name.toLowerCase().includes(q)) : names;
      if (!matches.length) return;
      const groupEl = document.createElement("div");
      groupEl.setAttribute("role", "group");
      const label = document.createElement("div");
      label.className = "picker-group";
      label.id = `${list.id}-g${gi}`;
      label.textContent = group;
      groupEl.setAttribute("aria-labelledby", label.id);
      groupEl.append(label);
      for (const name of matches) {
        const opt = document.createElement("div");
        opt.className = "picker-option";
        opt.id = `${list.id}-o${options.length}`;
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(name === hidden.value));
        opt.dataset.value = name;
        opt.textContent = name;
        groupEl.append(opt);
        options.push(opt);
      }
      list.append(groupEl);
    });
    if (!options.length) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = `No category matches "${query.trim()}"`;
      list.append(empty);
    }
    if (status) status.textContent = q ? `${options.length} match${options.length === 1 ? "" : "es"}` : "";
  }

  function setActive(i) {
    options[active]?.classList.remove("active");
    active = i;
    const opt = options[active];
    if (opt) {
      opt.classList.add("active");
      input.setAttribute("aria-activedescendant", opt.id);
      // Scroll only the list (scrollIntoView would also scroll the sheet and the page). A
      // group's first option brings its header along.
      const header = opt.previousElementSibling?.classList.contains("picker-group") ? opt.previousElementSibling : opt;
      const box = list.getBoundingClientRect();
      const top = header.getBoundingClientRect().top;
      const bottom = opt.getBoundingClientRect().bottom;
      if (top < box.top) list.scrollTop -= box.top - top + 4;
      else if (bottom > box.bottom) list.scrollTop += bottom - box.bottom + 4;
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function open(query = "") {
    render(query);
    list.scrollTop = 0; // a new result set starts at its top (and its first group header)
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    // Searching: the first match is ready for Enter. Browsing: start on the current choice.
    setActive(query.trim() ? (options.length ? 0 : -1) : options.findIndex((o) => o.dataset.value === hidden.value));
    input.closest(".picker").scrollIntoView({ block: "nearest" });
  }

  function close() {
    setActive(-1);
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.value = hidden.value; // an unfinished search never lingers as if it were the value
  }

  function set(name) {
    hidden.value = name || "";
    input.setCustomValidity("");
    close();
    onChange?.(hidden.value);
  }

  input.addEventListener("focus", () => {
    input.select(); // typing replaces the shown name, i.e. starts a search
    if (!isOpen()) open();
  });
  input.addEventListener("click", () => {
    if (!isOpen()) open();
  });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) return open();
      const next = active + (e.key === "ArrowDown" ? 1 : -1);
      setActive(Math.max(0, Math.min(options.length - 1, next)));
    } else if (e.key === "Enter" && isOpen()) {
      e.preventDefault(); // pick, don't submit the form
      const pick = options[active] || (options.length === 1 ? options[0] : null);
      if (pick) set(pick.dataset.value);
    } else if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      e.stopPropagation(); // closes the list only, not the sheet around it
      close();
    } else if (e.key === "Tab" && isOpen()) {
      close();
    }
  });
  input.addEventListener("blur", () => {
    if (isOpen()) close();
  });
  // Keep focus in the input while choosing, so blur doesn't close the list mid-click.
  list.addEventListener("pointerdown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const opt = e.target.closest('[role="option"]');
    if (opt) set(opt.dataset.value);
  });

  return {
    set,
    clear: () => set(""),
    value: () => hidden.value,
    // Before submit: a search left in the box isn't a choice.
    validate() {
      input.setCustomValidity(hidden.value ? "" : "Choose a category from the list.");
      return Boolean(hidden.value);
    }
  };
}

const txCategory = categoryPicker({
  input: $("fCategoryInput"),
  list: $("fCategoryList"),
  hidden: $("fCategory"),
  status: $("fCategoryStatus"),
  getGroups: () => CATEGORIES[state.formType],
  onChange: () => syncCategoryChips()
});

function populateCategorySelect() {
  txCategory.clear();
  renderCategoryChips();
}

// The household's most-used categories for this type, by number of entries over its whole
// history (category_usage()), ties alphabetical. Until that function exists, counts come
// from the loaded entries. Old category names never appear.
function topCategories(type, limit = 5) {
  const valid = new Set(CATEGORIES[type].flatMap(([, names]) => names));
  const rows = state.categoryUsage ?? state.tx.map((t) => ({ type: t.type, category: t.category, uses: 1 }));
  const counts = new Map();
  for (const r of rows) {
    if (r.type === type && valid.has(r.category)) counts.set(r.category, (counts.get(r.category) || 0) + Number(r.uses));
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name]) => name);
}

// Refreshed at start-up, on returning to the app and after each save, never while the form
// is open, so chips can't reorder under a finger.
async function loadCategoryUsage() {
  const { data, error } = await supabase.rpc("category_usage", { hid: state.household.id });
  if (error) {
    if (error.code !== "PGRST202") console.warn("[Ledger] category_usage failed:", error.code, error.message);
    return;
  }
  state.categoryUsage = data;
}

function renderCategoryChips() {
  const top = topCategories(state.formType);
  $("catRecent").hidden = top.length === 0;
  $("catChips").replaceChildren(
    ...top.map((name) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cat-chip";
      chip.dataset.cat = name;
      chip.textContent = name;
      return chip;
    })
  );
  syncCategoryChips();
}

function syncCategoryChips() {
  const value = $("fCategory").value;
  $("catChips").querySelectorAll(".cat-chip").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.cat === value)));
}

// A chip sets the picker's value (which re-syncs the chips), so the two never disagree.
$("catChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".cat-chip");
  if (chip) txCategory.set(chip.dataset.cat);
});

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

  // Only the list is shortened; totals, rings and charts above use every entry.
  const pages = Math.max(1, Math.ceil(sorted.length / TX_PAGE_SIZE));
  state.txPage = Math.min(state.txPage, pages);
  const start = state.txExpanded ? (state.txPage - 1) * TX_PAGE_SIZE : 0;
  const visible = sorted.slice(start, start + (state.txExpanded ? TX_PAGE_SIZE : TX_PREVIEW));
  renderTxFooter(sorted.length, start, visible.length, pages);

  if (sorted.length === 0) {
    body.innerHTML = "";
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
    body.innerHTML = visible.map((t) => txRowHtml(t, myId)).join("");
  }

  renderBreakdown(list);
  renderTrend();
  renderTransactionsView(sorted);
}

// One table row, shared by the Dashboard list and the Transactions view. Delete appears only
// on the signed-in user's own entries (the database enforces the same rule).
function txRowHtml(t, myId) {
  const dateStr = new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const who = state.names[t.author_id] || (t.author_email ? t.author_email.split("@")[0] : "—");
  const canDelete = myId && t.author_id === myId;
  const auto = t.recurring_rule_id ? ' <span class="tx-badge" title="Added automatically by a recurring rule">Recurring</span>' : "";
  return `
    <tr>
      <td class="tx-date">${dateStr}</td>
      <td class="tx-cat" title="${escapeHtml(t.category)}">${escapeHtml(t.category)}</td>
      <td class="tx-note"${t.note ? ` title="${escapeHtml(t.note)}"` : ""}>${t.note ? escapeHtml(t.note) : '<span style="color:var(--text-dim)">—</span>'}${auto}</td>
      <td class="tx-who">${escapeHtml(who)}</td>
      <td class="tx-amt ${t.type}">${t.type === "expense" ? "-" : "+"}${fmtMoney(Math.abs(Number(t.amount)))}</td>
      <td class="tx-actions"${canDelete ? ` data-actions-for="${escapeHtml(String(t.id))}"` : ""}>${canDelete ? actionsHtml(t, dateStr) : ""}</td>
    </tr>`;
}

// Transactions view: the full list for the period, filtered by type and a text search,
// 15 per page. Works on the already-loaded transactions; no extra query.
function renderTransactionsView(sorted) {
  const q = state.txQuery.trim().toLowerCase();
  const matches = sorted.filter(
    (t) =>
      (state.txFilter === "all" || t.type === state.txFilter) &&
      (!q || t.category.toLowerCase().includes(q) || (t.note || "").toLowerCase().includes(q))
  );
  const pages = Math.max(1, Math.ceil(matches.length / TX_PAGE_SIZE));
  state.txAllPage = Math.min(state.txAllPage, pages);
  const start = (state.txAllPage - 1) * TX_PAGE_SIZE;
  const shown = matches.slice(start, start + TX_PAGE_SIZE);
  const myId = state.session?.user?.id;

  $("txBodyAll").innerHTML = shown.map((t) => txRowHtml(t, myId)).join("");
  $("txTableAll").hidden = matches.length === 0;
  const empty = $("emptyAll");
  empty.style.display = matches.length ? "none" : "block";
  empty.textContent = sorted.length === 0
    ? "No entries for this period yet."
    : q
      ? `No entries match “${state.txQuery.trim()}”${state.txFilter === "all" ? "" : ` in ${state.txFilter === "expense" ? "expenses" : "income"}`}.`
      : `No ${state.txFilter === "expense" ? "expenses" : "income"} this period.`;

  const footer = $("txFooterAll");
  footer.hidden = matches.length === 0;
  if (footer.hidden) return;
  const filtered = matches.length !== sorted.length ? ` (filtered from ${sorted.length})` : "";
  const range = shown.length === matches.length ? `Showing all ${matches.length}` : `Showing ${start + 1}–${start + shown.length} of ${matches.length}`;
  let pager = "";
  if (pages > 1) {
    const cur = state.txAllPage;
    pager = `<nav class="tx-pager" aria-label="Transaction pages">
      <button type="button" class="pager-btn" data-page="${cur - 1}" aria-label="Previous page" ${cur === 1 ? "disabled" : ""}>‹</button>
      ${pageList(cur, pages).map((p) => (p === "…" ? `<span class="pager-gap" aria-hidden="true">…</span>` : `<button type="button" class="pager-btn" data-page="${p}" aria-label="Page ${p}"${p === cur ? ' aria-current="page"' : ""}>${p}</button>`)).join("")}
      <button type="button" class="pager-btn" data-page="${cur + 1}" aria-label="Next page" ${cur === pages ? "disabled" : ""}>›</button>
    </nav>`;
  }
  footer.innerHTML = `<p class="tx-range" aria-live="polite">${range}${filtered}</p>${pager}`;
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
        <div class="bar-top"><span>${escapeHtml(cat)}</span><span class="amt">${fmtMoney(amt)}</span></div>
        <div class="bar-track"><div class="bar-fill ${type}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// entries list: 5 most recent by default; "Show all" pages them 15 at a time
// ---------------------------------------------------------------------------
const TX_PREVIEW = 5;
const TX_PAGE_SIZE = 15;

// Page numbers to show, with "…" gaps once there are more than 7 pages:
// 1 … 4 [5] 6 … 12
function pageList(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => keep.add(p));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => keep.add(p));
  const pages = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  return pages.flatMap((p, i) => (i && p - pages[i - 1] > 1 ? ["…", p] : [p]));
}

function renderTxFooter(total, start, shown, pages) {
  const footer = $("txFooter");
  footer.hidden = total <= TX_PREVIEW;
  if (footer.hidden) return (footer.innerHTML = "");

  const range = `Showing ${shown === total ? "all " + total : `${start + 1}–${start + shown} of ${total}`}`;
  let pager = "";
  if (state.txExpanded && pages > 1) {
    const cur = state.txPage;
    pager = `<nav class="tx-pager" aria-label="Entry pages">
      <button type="button" class="pager-btn" data-page="${cur - 1}" aria-label="Previous page" ${cur === 1 ? "disabled" : ""}>‹</button>
      ${pageList(cur, pages)
        .map((p) =>
          p === "…"
            ? `<span class="pager-gap" aria-hidden="true">…</span>`
            : `<button type="button" class="pager-btn" data-page="${p}" aria-label="Page ${p}"${p === cur ? ' aria-current="page"' : ""}>${p}</button>`
        )
        .join("")}
      <button type="button" class="pager-btn" data-page="${cur + 1}" aria-label="Next page" ${cur === pages ? "disabled" : ""}>›</button>
    </nav>`;
  }
  const toggle = state.txExpanded
    ? `<button type="button" class="btn-secondary tx-more" data-action="collapse" aria-expanded="true" aria-controls="txTable">Show fewer</button>`
    : `<button type="button" class="btn-secondary tx-more" data-action="expand" aria-expanded="false" aria-controls="txTable">Show all ${total} entries</button>`;
  footer.innerHTML = `<p class="tx-range" aria-live="polite">${range}</p>${pager}${toggle}`;
}

// Bring the top of the list back into view (below the sticky header on mobile).
function scrollToEntries() {
  const heading = document.querySelector("section.ledger h2");
  if (heading.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: "start" });
}

$("txFooter").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  if (btn.dataset.action === "expand") {
    state.txExpanded = true;
    state.txPage = 1;
    render();
    $("txFooter").querySelector('[data-action="collapse"]')?.focus();
    return;
  }
  if (btn.dataset.action === "collapse") {
    state.txExpanded = false;
    state.txPage = 1;
    render();
    scrollToEntries();
    $("txFooter").querySelector('[data-action="expand"]')?.focus({ preventScroll: true });
    return;
  }
  if (btn.dataset.page) {
    state.txPage = Number(btn.dataset.page);
    render();
    scrollToEntries();
    $("txFooter").querySelector(`[aria-current="page"]`)?.focus({ preventScroll: true });
  }
});

// A different month/year starts again from the 5 most recent.
function resetEntriesList() {
  state.txExpanded = false;
  state.txPage = 1;
}

$("periodMode").addEventListener("change", (e) => {
  state.periodMode = e.target.value;
  state.selectedMonth = currentMonthKey();
  state.selectedYear = currentYear();
  resetEntriesList();
  render();
});
$("periodValue").addEventListener("change", (e) => {
  if (state.periodMode === "monthly") state.selectedMonth = e.target.value;
  else state.selectedYear = Number(e.target.value);
  resetEntriesList();
  render();
});

// ---------------------------------------------------------------------------
// Sheets: every add/edit form is a <dialog class="sheet"> (DESIGN.md "Sheets"). These two
// functions plus the wiring below are the whole component: Escape, a tap on the backdrop and
// any [data-sheet-close] button close it; each sheet resets its own form on "close".
// A bottom sheet on phones and a centred dialog on wider screens (CSS only).
// ---------------------------------------------------------------------------
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// opener: where focus goes back to. fallback: an element, or a function returning one, used
// if the opener is gone by then (e.g. a debt card re-rendered after its Edit).
function openSheet(sheet, { opener, fallback, focus } = {}) {
  sheet.sheetReturn = { opener, fallback };
  sheet.classList.remove("closing");
  sheet.showModal();
  (focus || sheet.querySelector("input:not([type=hidden]), select, textarea"))?.focus();
}

// Slides away, then closes. Resolves once it's gone, so anything drawn next (confetti) isn't
// under it. Focus is returned explicitly: <dialog> restores the previous focus itself, but
// Safari doesn't focus a button when it's tapped, so there'd be nothing to restore.
function closeSheet(sheet) {
  if (!sheet.open) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      sheet.classList.remove("closing");
      sheet.close();
      const { opener, fallback } = sheet.sheetReturn || {};
      const target = [opener, typeof fallback === "function" ? fallback() : fallback]
        .find((el) => el?.isConnected && el.checkVisibility());
      target?.focus({ preventScroll: true });
      resolve();
    };
    if (reducedMotion()) return finish();
    sheet.classList.add("closing");
    sheet.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 400); // in case the animation never runs (e.g. animations disabled)
  });
}

document.querySelectorAll("dialog.sheet").forEach((sheet) => {
  sheet.addEventListener("cancel", (e) => {
    e.preventDefault(); // animate instead of vanishing
    closeSheet(sheet);
  });
  // The form fills the dialog, so a click whose target is the dialog itself is the backdrop.
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-sheet-close]")) closeSheet(sheet);
  });
});

// On phones the on-screen keyboard overlays the page without resizing it, which would hide
// a bottom sheet's fields; --kb lifts sheets above it.
if (window.visualViewport) {
  const syncKeyboard = () => {
    const kb = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop);
    document.documentElement.style.setProperty("--kb", `${Math.round(kb)}px`);
  };
  visualViewport.addEventListener("resize", syncKeyboard);
  visualViewport.addEventListener("scroll", syncKeyboard);
}

// ---- Add transaction (sheet) ----
const form = $("entryForm");
const addToggle = $("addToggle");
addToggle.addEventListener("click", () => {
  // Local date, not toISOString() (UTC), which is already "tomorrow" on US evenings.
  $("fDate").value = dayKey(new Date());
  $("formError").textContent = "";
  renderCategoryChips();
  openSheet($("txSheet"), { opener: addToggle, focus: $("fAmount") });
});
$("txSheet").addEventListener("close", () => {
  form.reset();
  txCategory.clear(); // the hidden value isn't touched by reset()
  $("formError").textContent = "";
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
  if (!txCategory.validate()) return $("fCategoryInput").reportValidity();
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
    closeSheet($("txSheet")); // the form resets on close
    loadCategoryUsage(); // this entry now counts towards the chips
    state.selectedMonth = payload.date.slice(0, 7);
    state.selectedYear = Number(payload.date.slice(0, 4));
  } catch (err) {
    errorEl.textContent = "Couldn't save that entry. Try again.";
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// inline delete confirmation — the only way a transaction gets deleted
// ---------------------------------------------------------------------------
const txById = (id) => state.tx.find((t) => String(t.id) === String(id));
// A row can appear in both lists (Dashboard and Transactions), so work on every copy, and
// put focus in the one on the view that's showing.
const actionsCells = (id) => [...document.querySelectorAll(`[data-actions-for="${CSS.escape(String(id))}"]`)];
const visibleActionsCell = (id) => actionsCells(id).find((cell) => !cell.closest("[hidden]"));

// A row's action cell: "Delete", or Cancel / Confirm delete while it's being confirmed.
// The confirm buttons float over the row's right edge, and an invisible "Delete" keeps the
// cell's width, so no column resizes and nothing else on the page moves.
function actionsHtml(t, dateStr) {
  const label = escapeHtml(`${t.note || t.category}, ${dateStr}`);
  const id = escapeHtml(String(t.id));
  if (state.confirmingDeleteId !== String(t.id)) {
    return `<button class="tx-del" data-id="${id}" aria-label="Delete ${label}">Delete</button>`;
  }
  const failed = state.deleteErrorId === String(t.id);
  // The spacer is the same element type as the real link (buttons don't inherit the page
  // font), so it occupies exactly the same width.
  return `<button type="button" class="tx-del tx-del-spacer" tabindex="-1" aria-hidden="true" disabled>Delete</button>
    <span class="tx-confirm" role="group" aria-label="Delete ${label}?">
      <button type="button" class="btn-secondary btn-sm tx-cancel" data-id="${id}">Cancel</button>
      <button type="button" class="btn-danger btn-sm tx-confirm-del" data-id="${id}">Confirm delete</button>
      ${failed ? `<span class="tx-confirm-error" role="alert">Couldn't delete. Check your connection and try again.</span>` : ""}
    </span>`;
}

function refreshRowActions(id) {
  const t = txById(id);
  if (!t) return;
  const dateStr = new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  actionsCells(id).forEach((cell) => (cell.innerHTML = actionsHtml(t, dateStr)));
}

// Only one row confirms at a time: starting a new one (or cancelling) reverts the old one.
function setConfirming(id, focus) {
  const prev = state.confirmingDeleteId;
  state.confirmingDeleteId = id === null ? null : String(id);
  state.deleteErrorId = null;
  if (prev !== null && prev !== state.confirmingDeleteId) refreshRowActions(prev);
  if (state.confirmingDeleteId !== null) refreshRowActions(state.confirmingDeleteId);
  if (focus === "cancel") visibleActionsCell(id)?.querySelector(".tx-cancel")?.focus();
  if (focus === "delete" && prev !== null) visibleActionsCell(prev)?.querySelector(".tx-del:not(.tx-del-spacer)")?.focus();
}

async function deleteTransaction(id) {
  actionsCells(id).forEach((cell) => cell.querySelectorAll("button").forEach((b) => (b.disabled = true)));
  const { error } = await supabase.from("transactions").delete().eq("id", id);
  if (error) {
    state.deleteErrorId = String(id);
    return refreshRowActions(id);
  }
  // Supabase Realtime can't deliver DELETE events on a filtered channel, so the list
  // never hears about the delete; update it here once the database has confirmed.
  state.tx = state.tx.filter((t) => String(t.id) !== String(id));
  state.confirmingDeleteId = null;
  state.deleteErrorId = null;
  render();
}

function onTxTableClick(e) {
  const del = e.target.closest("button.tx-del:not(.tx-del-spacer)");
  const cancel = e.target.closest(".tx-cancel");
  const confirm = e.target.closest(".tx-confirm-del");
  if (!del && !cancel && !confirm) return;
  // Handled here; keep the page-level "click elsewhere cancels" listener out of it.
  e.stopPropagation();
  if (del) return setConfirming(txById(del.dataset.id)?.id ?? null, "cancel");
  if (cancel) return setConfirming(null, "delete");
  deleteTransaction(txById(confirm.dataset.id)?.id);
}
$("txBody").addEventListener("click", onTxTableClick);
$("txBodyAll").addEventListener("click", onTxTableClick);

// Safety nets: clicking anywhere else, or pressing Esc, cancels a pending delete.
document.addEventListener("click", (e) => {
  if (state.confirmingDeleteId !== null && !e.target.closest(".tx-confirm")) setConfirming(null);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.confirmingDeleteId !== null) setConfirming(null, "delete");
});

$("breakdownToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-t]");
  if (!btn) return;
  state.breakdownType = btn.getAttribute("data-t");
  document.querySelectorAll("#breakdownToggle button").forEach((b) => b.classList.toggle("active", b === btn));
  render();
});

// ---------------------------------------------------------------------------
// views: Dashboard / Transactions / Recurring / Debts (show/hide, no router)
// ---------------------------------------------------------------------------
const VIEW_IDS = { dashboard: "viewDashboard", transactions: "viewTransactions", recurring: "viewRecurring", debts: "viewDebts", members: "viewMembers" };

function notify(message) {
  $("noticeBanner").textContent = message || "";
  $("noticeBanner").hidden = !message;
}

function showAppView(name) {
  state.view = name;
  for (const [view, id] of Object.entries(VIEW_IDS)) $(id).hidden = view !== name;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const on = btn.dataset.view === name;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  // Only Dashboard and Transactions are period-filtered.
  $("periodNav").hidden = !(name === "dashboard" || name === "transactions");
  // The add-transaction form moves into whichever view has a slot for it.
  const slot = $(VIEW_IDS[name]).querySelector(".entry-slot");
  (slot || $("entryParking")).append($("entryArea"));
  if (state.confirmingDeleteId !== null) setConfirming(null);
  // An invite panel opened on the Members page doesn't follow you to other views.
  if (name !== "members" && $("inviteSlotMembers").contains($("invitePanel"))) {
    $("invitePanel").hidden = true;
    $("membersInvite").setAttribute("aria-expanded", "false");
  }
  notify("");
  if (name === "recurring") renderRules();
  if (name === "debts") renderDebts();
  window.scrollTo(0, 0);
}

// The sticky Transactions toolbar sits just under the (sticky, on mobile) header, whose height
// changes with the view and screen width, so keep it in a CSS variable.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--header-h", `${Math.round(entry.borderBoxSize[0].blockSize)}px`);
}).observe(document.querySelector("header.top"));

document.querySelector(".app-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (!btn) return;
  if (state.view === "members") leaveMembers(btn.dataset.view);
  else showAppView(btn.dataset.view);
});

// Transactions view: type filter, search, pages
$("txFilter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.txFilter = btn.dataset.filter;
  state.txAllPage = 1;
  $("txFilter").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  render();
});
$("txSearch").addEventListener("input", (e) => {
  state.txQuery = e.target.value;
  state.txAllPage = 1;
  render();
});
$("txFooterAll").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn || btn.disabled) return;
  state.txAllPage = Number(btn.dataset.page);
  render();
  const head = $("txViewTitle");
  if (head.getBoundingClientRect().top < 0) head.scrollIntoView({ block: "start" });
  $("txFooterAll").querySelector('[aria-current="page"]')?.focus({ preventScroll: true });
});

const isMissingTable = (error) => Boolean(error) && (error.code === "PGRST205" || error.code === "42P01");
const MIGRATION_HINT = "isn't set up in the database yet. Run the latest migration from supabase/schema.sql.";

// A failed insert/update, as a message that says what went wrong instead of one catch-all.
// `checks` maps a table's check-constraint names to field-specific messages. (Missing tables
// are handled by the caller, which swaps the form for the migration hint.)
function saveErrorMessage(error, noun, checks = {}) {
  console.error(`[Ledger] saving the ${noun} failed:`, error);
  if (!error.code) return "Couldn't reach the server. Check your connection and try again.";
  if (error.code === "23514") {
    const constraint = /constraint "([^"]+)"/.exec(error.message || "")?.[1];
    return checks[constraint] ?? "One of the values isn't allowed. Check the fields and try again.";
  }
  if (error.code === "23502") return "A required field is empty. Fill in every field not marked optional.";
  if (error.code === "22P02") return "One of the numbers isn't valid. Check the amounts and try again.";
  if (error.code === "42501") return `You don't have permission to save this ${noun}. Reload the app and try again.`;
  return `Couldn't save the ${noun} (error ${error.code}). Try again.`;
}
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const monthStartKey = () => { const d = new Date(); return dayKey(new Date(d.getFullYear(), d.getMonth(), 1)); };

// ---------------------------------------------------------------------------
// recurring rules
// ---------------------------------------------------------------------------
// Creates this month's entries for rules whose day has arrived. Runs server-side in one
// transaction (see materialize_recurring in schema.sql), so two devices can't double-insert.
// LIMITATION: it only runs when someone opens the app. A Supabase pg_cron job calling the same
// function daily would make it independent of app usage; see DESIGN.md.
async function runRecurringRules() {
  const { data, error } = await supabase.rpc("materialize_recurring", { hid: state.household.id, today: dayKey(new Date()) });
  if (error) {
    if (error.code !== "PGRST202") console.warn("[Ledger] recurring rules not applied:", error.code, error.message);
    return 0;
  }
  return data || 0;
}

async function loadRules() {
  const { data, error } = await supabase.from("recurring_rules").select("*").eq("household_id", state.household.id).order("day_of_month");
  state.missing.rules = isMissingTable(error);
  if (!error) state.rules = data;
  if (state.view === "recurring") renderRules();
}

function nextRunDate(rule) {
  const now = new Date();
  return rule.day_of_month > now.getDate()
    ? new Date(now.getFullYear(), now.getMonth(), rule.day_of_month)
    : new Date(now.getFullYear(), now.getMonth() + 1, rule.day_of_month);
}

function renderRules() {
  const list = $("ruleList");
  const empty = $("ruleEmpty");
  empty.dataset.default ??= empty.textContent;
  $("ruleAddToggle").hidden = state.missing.rules;
  if (state.missing.rules) {
    list.innerHTML = "";
    empty.textContent = "Recurring rules " + MIGRATION_HINT;
    empty.style.display = "block";
    return;
  }
  empty.textContent = empty.dataset.default;
  empty.style.display = state.rules.length ? "none" : "block";
  const myId = state.session?.user?.id;
  list.innerHTML = state.rules
    .map((r) => {
      const mine = r.created_by === myId;
      const who = escapeHtml(state.names[r.created_by] || "your partner");
      const title = escapeHtml(r.note || r.category);
      // One compact row: name + amount, then "category · Next Oct 1" (or "Paused · 5th"),
      // with the switch on the same row. The switch's position shows active/paused.
      const when = r.active ? `Next ${shortDate(nextRunDate(r))}` : `Paused · ${ordinal(r.day_of_month)}`;
      return `<li class="rule-row${r.active ? "" : " paused"}">
        <p class="rule-name">${title}</p>
        <p class="rule-amt ${r.type}">${r.type === "expense" ? "-" : "+"}${fmtMoney(Number(r.amount))}</p>
        <p class="rule-meta">${escapeHtml(r.category)} · ${when}${mine ? "" : ` · ${who}`}</p>
        <button type="button" class="switch" role="switch" aria-checked="${r.active}" aria-label="${title}, recurring ${r.active ? "" : "(paused)"}"
          data-rule="${escapeHtml(r.id)}" title="${mine ? (r.active ? "Active. Tap to pause" : "Paused. Tap to resume") : `Only ${who} can pause or resume this rule`}"${mine ? "" : " disabled"}>
          <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
        </button>
      </li>`;
    })
    .join("");
}

$("ruleList").addEventListener("click", async (e) => {
  const sw = e.target.closest(".switch[data-rule]");
  if (!sw || sw.disabled) return;
  const rule = state.rules.find((r) => r.id === sw.dataset.rule);
  if (!rule) return;
  const patch = { active: !rule.active };
  // Resuming after this month's day has passed starts next month instead of backdating an entry.
  if (!rule.active && rule.day_of_month <= new Date().getDate() && !(rule.last_materialized_month >= monthStartKey())) {
    patch.last_materialized_month = monthStartKey();
  }
  sw.disabled = true;
  const { data, error } = await supabase.from("recurring_rules").update(patch).eq("id", rule.id).select().maybeSingle();
  if (error || !data) {
    sw.disabled = false;
    return notify("Couldn't update that rule. Check your connection and try again.");
  }
  Object.assign(rule, data);
  renderRules();
  document.querySelector(`.switch[data-rule="${CSS.escape(rule.id)}"]`)?.focus();
});

function setRuleType(type) {
  state.ruleType = type;
  $("ruleType").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  fillCategorySelect($("rCategory"), type);
}
$("ruleType").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (btn) setRuleType(btn.dataset.type);
});

// If the chosen day already passed this month, ask whether to add this month's entry now
// (default: no, it was probably already entered by hand) instead of silently backdating one.
function updateRuleNowRow() {
  const day = Number($("rDay").value);
  const passed = day <= new Date().getDate();
  $("rNowRow").hidden = !passed;
  if (passed) $("rNowText").textContent = `Also add this month's entry now (the ${ordinal(day)} has passed)`;
  else $("rNow").checked = false;
}
$("rDay").addEventListener("change", updateRuleNowRow);

const closeRuleForm = () => closeSheet($("ruleSheet"));
$("ruleSheet").addEventListener("close", () => {
  $("ruleForm").reset();
  $("ruleError").textContent = "";
});
$("ruleAddToggle").addEventListener("click", () => {
  setRuleType(state.ruleType);
  $("ruleError").textContent = "";
  updateRuleNowRow();
  openSheet($("ruleSheet"), { opener: $("ruleAddToggle"), focus: $("rAmount") });
});

$("ruleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Math.round(parseFloat($("rAmount").value) * 100) / 100;
  const category = $("rCategory").value;
  const day = Number($("rDay").value);
  if (!(amount > 0) || !category) return;
  const passed = day <= new Date().getDate();
  const addNow = passed && $("rNow").checked;
  $("ruleSave").disabled = true;
  const { error } = await supabase.from("recurring_rules").insert({
    household_id: state.household.id,
    type: state.ruleType,
    amount,
    category,
    note: $("rNote").value.trim(),
    day_of_month: day,
    created_by: state.session.user.id,
    // Marks this month as handled so the rule starts next month.
    last_materialized_month: passed && !addNow ? monthStartKey() : null
  });
  $("ruleSave").disabled = false;
  if (error) {
    if (isMissingTable(error)) {
      state.missing.rules = true;
      closeRuleForm();
      renderRules();
      return;
    }
    $("ruleError").textContent = saveErrorMessage(error, "rule", {
      recurring_rules_amount_check: "Amount must be above $0.",
      recurring_rules_day_of_month_check: "Choose a day from 1 to 28.",
      recurring_rules_type_check: "Choose Expense or Income."
    });
    return;
  }
  closeRuleForm();
  if (addNow && (await runRecurringRules()) > 0 && (await fetchTransactions())) render();
  await loadRules();
  notify(addNow ? "Rule saved, and this month's entry was added." : "Rule saved.");
});

// ---------------------------------------------------------------------------
// debts
// ---------------------------------------------------------------------------
const DEBT_TYPES = { credit_card: "Credit card", loan: "Loan", mortgage: "Mortgage", other: "Other" };

async function loadDebts() {
  const { data, error } = await supabase.from("debts").select("*").eq("household_id", state.household.id).order("created_at");
  state.missing.debts = isMissingTable(error);
  if (!error) state.debts = data;
  if (state.view === "debts") renderDebts();
}

// Plain arithmetic, deliberately simple: months = balance ÷ minimum payment. It ignores interest,
// so it's labelled a rough estimate, with a warning when interest would make it misleading.
function payoffEstimate(d) {
  const balance = Number(d.current_balance);
  const minimum = Number(d.minimum_payment) || 0;
  const apr = d.interest_rate == null ? null : Number(d.interest_rate);
  if (balance <= 0) return { text: "Paid off.", warn: "" };
  if (!minimum) return { text: "Add a minimum monthly payment to see a rough payoff date.", warn: "" };
  const months = Math.ceil(balance / minimum);
  const when = new Date();
  when.setDate(1);
  when.setMonth(when.getMonth() + months);
  // The APR and minimum are already in the facts line above this, so these don't repeat them.
  const text = `Rough estimate: paid off around ${when.toLocaleDateString(undefined, { month: "long", year: "numeric" })} ` +
    `(${months} month${months === 1 ? "" : "s"}), paying the minimum and ignoring interest.`;
  let warn = "";
  if (apr) {
    const monthlyInterest = (balance * apr) / 100 / 12;
    warn = monthlyInterest >= minimum
      ? `Interest adds about ${fmtMoney(monthlyInterest)} a month, as much as the minimum, so paying only the minimum won't bring this down.`
      : `About ${fmtMoney(monthlyInterest)} of each payment goes to interest, so the real date will be later.`;
  }
  return { text, warn };
}

// All debts as one journey, computed from the sums (not an average of per-debt percentages,
// which would understate progress on the largest debt). Percentages round DOWN, so "50%"
// never shows before half is really paid.
const MILESTONES = [25, 50, 75];
function debtTotals(debts = state.debts) {
  const original = debts.reduce((sum, d) => sum + Number(d.original_balance), 0);
  const current = debts.reduce((sum, d) => sum + Number(d.current_balance), 0);
  const paid = Math.max(0, original - current);
  const pct = original > 0 ? Math.min(100, (paid / original) * 100) : 0;
  return { original, current, paid, pct };
}
const floorPct = (pct) => (pct >= 100 ? 100 : Math.floor(pct));

// Red means "needs attention", never "a debt exists": only a debt with a balance and no
// payment logged for this many days (counted from when it was added, if it never had one).
const ATTENTION_DAYS = 45;
function daysWithoutPayment(d) {
  const last = state.tx.reduce((latest, t) => (t.debt_id === d.id && t.date > latest ? t.date : latest), "");
  const since = last ? new Date(`${last}T00:00:00`) : new Date(d.created_at);
  return Math.floor((Date.now() - since) / 86400000);
}

function renderJourney() {
  const el = $("debtJourney");
  el.hidden = state.missing.debts || !state.debts.length;
  if (el.hidden) return;
  const { original, current, paid, pct } = debtTotals();
  // Exact to one decimal, rounded DOWN (49.96% shows 49.9%, never an early 50.0%).
  const shown = pct >= 100 ? "100" : (Math.floor(pct * 10) / 10).toFixed(1);
  // Draw at the last value first, then move, so progress visibly grows (the fill follows
  // --p, a registered property; the percentage below follows with a matching transition).
  const from = state.journeyPct ?? pct;
  state.journeyPct = pct;
  // One statement per fact: the amount (headline), the bar, and the percentage in the caption
  // row under the end of the fill. "Start" doubles as a toggle for the total starting debt.
  el.innerHTML = `
    <p class="journey-paid"><span class="journey-amt">${fmtMoney(paid)}</span> paid off</p>
    <div class="journey-path" style="--p: ${from}">
      <div class="journey-track" role="progressbar" aria-label="Debt-free journey" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow="${shown}" aria-valuetext="${shown}% paid off, ${fmtMoney(current)} to go of ${fmtMoney(original)}">
        <span class="journey-fill"></span>
      </div>
      ${MILESTONES.map((m) => `<span class="journey-dot${pct >= m ? " reached" : ""}" style="left: ${m}%" title="${m}%" aria-hidden="true"></span>`).join("")}
      <span class="journey-flag${current <= 0 ? " reached" : ""}" aria-hidden="true">
        <svg viewBox="0 0 16 16"><path d="M4.5 14V2"/><path class="pennant" d="M4.5 2.5l8 3-8 3z"/></svg>
      </span>
    </div>
    <div class="journey-labels">
      <button type="button" class="journey-start" aria-pressed="${Boolean(state.journeyShowTotal)}"
        title="Show the total you started with">${state.journeyShowTotal ? `${fmtMoney(original)} total` : "Start"}</button>
      <span class="journey-pct" aria-hidden="true">${shown}%</span>
      <span class="end${current <= 0 ? " reached" : ""}" aria-hidden="true">$0</span>
    </div>`;
  el.querySelector(".journey-start").addEventListener("click", () => {
    state.journeyShowTotal = !state.journeyShowTotal;
    const start = el.querySelector(".journey-start");
    start.textContent = state.journeyShowTotal ? `${fmtMoney(original)} total` : "Start";
    start.setAttribute("aria-pressed", String(state.journeyShowTotal));
    placeJourneyPct(el, pct, false); // the wider label may push the percentage along
  });
  placeJourneyPct(el, from, false);
  requestAnimationFrame(() => {
    el.querySelector(".journey-path")?.style.setProperty("--p", String(pct));
    placeJourneyPct(el, pct, true);
  });
}

// The percentage is placed in pixels, so re-place it whenever the card's width changes
// (including the view going from hidden, width 0, to shown).
new ResizeObserver(() => {
  const el = $("debtJourney");
  if (!el.hidden && state.journeyPct != null) placeJourneyPct(el, state.journeyPct, false);
}).observe($("debtJourney"));

// Puts the percentage under the end of the fill: at p% of the row, shifted back by p% of its
// own width (left-aligned at 0%, right-aligned at 100%, always covering the fill point), but
// never over "Start" or "$0", so near either end it pins just beside them.
function placeJourneyPct(el, p, animate) {
  const row = el.querySelector(".journey-labels");
  const label = el.querySelector(".journey-pct");
  if (!row || !label) return;
  const w = row.clientWidth;
  const own = label.offsetWidth;
  const gap = 10;
  const start = el.querySelector(".journey-start");
  // offsetLeft/Width include the button's tap-target padding (6px each side), so its text
  // ends 6px before its box does.
  const min = start.offsetLeft + start.offsetWidth - 6 + gap;
  const endLabel = el.querySelector(".journey-labels .end");
  const max = w - endLabel.offsetWidth / 2 - gap - own; // "$0" is centred on the bar's end
  const left = Math.min(Math.max((w * p) / 100 - (own * p) / 100, min), Math.max(min, max));
  label.classList.toggle("animate", animate);
  label.style.left = `${left}px`;
}

// A short, non-blocking celebration: a toast with the concrete result, plus a confetti burst
// from the debt's bar (skipped for reduced motion). Gone in about 1.5 s; no dismiss needed.
function celebrate(headline, detail, origin) {
  const toast = $("celebrate");
  toast.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M6 10.5l2.6 2.5L14 7.5"/></svg>
    <span><b>${escapeHtml(headline)}</b><span>${escapeHtml(detail)}</span></span>`;
  toast.classList.remove("show");
  void toast.offsetWidth; // restart the transition if a second payment lands quickly
  toast.classList.add("show");
  clearTimeout(celebrate.timer);
  celebrate.timer = setTimeout(() => toast.classList.remove("show"), 1500);
  if (!origin) {
    const t = toast.getBoundingClientRect();
    origin = { x: t.left + t.width / 2, y: t.top };
  }
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) confetti(origin);
}

function confetti({ x, y }) {
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);
  const colors = ["var(--green)", "var(--brass)", "var(--activity-cyan)", "var(--activity-green)"];
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement("span");
    bit.style.cssText = `left:${x}px; top:${y}px; background:${colors[i % colors.length]}`;
    layer.append(bit);
    const angle = ((-90 + (Math.random() * 130 - 65)) * Math.PI) / 180; // an upward fan
    const speed = 80 + Math.random() * 110;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed;
    const spin = (Math.random() * 2 - 1) * 540;
    bit.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(calc(-50% + ${dx * 1.3}px), calc(-50% + ${dy + 150}px)) rotate(${spin}deg)`, opacity: 0 }
      ],
      { duration: 950 + Math.random() * 250, easing: "cubic-bezier(.2, .7, .3, 1)", fill: "forwards" }
    );
  }
  setTimeout(() => layer.remove(), 1300);
}

function paymentFormHtml(d) {
  const id = escapeHtml(d.id);
  return `<form class="pay-form" data-pay="${id}">
    <div class="field">
      <label for="pay-amt-${id}">Payment amount</label>
      <input type="number" class="pay-amount" id="pay-amt-${id}" step="0.01" min="0.01" max="${Number(d.current_balance)}" value="${d.minimum_payment ? Math.min(Number(d.minimum_payment), Number(d.current_balance)) : ""}" required>
    </div>
    <div class="field">
      <label for="pay-date-${id}">Date</label>
      <input type="date" class="pay-date" id="pay-date-${id}" value="${dayKey(new Date())}" max="${dayKey(new Date())}" required>
    </div>
    <p class="field-help pay-help">Lowers the balance and adds the same amount to Transactions as an expense (Loan &amp; card payments).</p>
    <p class="form-error pay-error" role="alert"></p>
    <div class="form-actions">
      <button type="button" class="btn-secondary" data-act="cancel-pay">Cancel</button>
      <button type="submit" class="btn-primary">Save payment</button>
    </div>
  </form>`;
}

function renderDebts() {
  const list = $("debtList");
  const empty = $("debtEmpty");
  empty.dataset.default ??= empty.textContent;
  // One piece of state drives the primary button: with a debt to pay it's "Log a payment"
  // (opens the sheet) and adding moves to the small "+" by the title; otherwise "+ Add debt".
  // Fully paid-off debts don't count, since there'd be nothing to pay.
  const canPay = !state.missing.debts && state.debts.some((d) => Number(d.current_balance) > 0);
  const primary = $("debtPrimary");
  primary.hidden = state.missing.debts;
  primary.textContent = canPay ? "Log a payment" : "+ Add debt";
  primary.dataset.action = canPay ? "pay" : "add";
  primary.setAttribute("aria-haspopup", canPay ? "dialog" : "false");
  $("debtTitleAdd").hidden = !canPay;
  renderJourney();
  if (state.missing.debts) {
    list.innerHTML = "";
    empty.textContent = "Debts " + MIGRATION_HINT;
    empty.style.display = "block";
    return;
  }
  empty.textContent = empty.dataset.default;
  empty.style.display = state.debts.length ? "none" : "block";
  const myId = state.session?.user?.id;
  list.innerHTML = state.debts
    .map((d) => {
      const original = Number(d.original_balance);
      const current = Number(d.current_balance);
      const paidOff = Math.max(0, original - current);
      const pct = floorPct(Math.min(1, paidOff / original) * 100);
      const est = payoffEstimate(d);
      const mine = d.created_by === myId;
      // Secondary detail, shown only under "More info" (the card itself states paid off once).
      const facts = [
        current > 0 ? `${fmtMoney(current)} left of ${fmtMoney(original)}` : `Paid in full (${fmtMoney(original)})`,
        `${pct}% paid off`,
        d.interest_rate != null ? `${Number(d.interest_rate)}% APR` : null,
        d.minimum_payment ? `${fmtMoney(Number(d.minimum_payment))}/mo minimum` : null
      ].filter(Boolean).join(" · ");
      const idle = current > 0 ? daysWithoutPayment(d) : 0;
      const id = escapeHtml(d.id);
      const name = escapeHtml(d.name);
      const open = state.expandedDebts.has(d.id);
      const paying = state.payingDebtId === d.id;
      // Collapsed: name + type, paid off (the lead number), bar, what's left, one dominant
      // action. The rest lives behind "More info"; Edit is a small icon.
      return `<article class="card debt-card" data-debt="${id}">
        <div class="debt-head">
          <p class="debt-name"><b>${name}</b></p>
          <p class="debt-paidoff"><b>${fmtMoney(paidOff)}</b> paid off</p>
        </div>
        <div class="debt-progress" role="progressbar" aria-label="${name} paid off" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="${pct}% paid off, ${fmtMoney(current)} left">
          <span style="width: ${pct}%"></span>
        </div>
        ${idle > ATTENTION_DAYS ? `<p class="debt-attention"><span class="attention-dot" aria-hidden="true"></span><span class="visually-hidden">Needs attention: </span>No payment in ${idle} days</p>` : ""}
        <!-- Two columns, like the row above: the primary action under the name, the
             secondary actions under "$X paid off". -->
        <div class="debt-actions">
          ${current > 0
            ? `<button type="button" class="btn-primary btn-sm debt-pay" data-act="pay" aria-expanded="${paying}">Log a payment</button>`
            : `<span class="debt-paid">Paid off</span>`}
          <div class="debt-secondary">
            <button type="button" class="debt-more" data-act="more" aria-expanded="${open}" aria-controls="debt-info-${id}">
              More info<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
            </button>
            ${mine
              ? `<button type="button" class="icon-btn" data-act="edit" aria-label="Edit ${name}" title="Edit"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.3a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1L5.6 13H3v-2.6z"/></svg></button>`
              : ""}
          </div>
        </div>
        ${paying ? paymentFormHtml(d) : ""}
        <div class="debt-info" id="debt-info-${id}"${open ? "" : " hidden"}>
          <p class="debt-type-label">${DEBT_TYPES[d.debt_type] || "Debt"}</p>
          <p class="card-meta">${facts}</p>
          <p class="debt-estimate">${escapeHtml(est.text)}</p>
          ${est.warn ? `<p class="debt-note">${escapeHtml(est.warn)}</p>` : ""}
          ${mine ? "" : `<p class="card-meta">Added by ${escapeHtml(state.names[d.created_by] || "your partner")}. Only they can edit it; anyone can log a payment.</p>`}
        </div>
      </article>`;
    })
    .join("");
}

function openDebtForm(debt, opener) {
  state.editingDebtId = debt ? debt.id : null;
  $("debtFormTitle").textContent = debt ? `Edit ${debt.name}` : "Add a debt";
  $("debtSave").textContent = debt ? "Save changes" : "Save debt";
  $("dName").value = debt ? debt.name : "";
  $("dType").value = debt ? debt.debt_type : "credit_card";
  $("dOriginal").value = debt ? debt.original_balance : "";
  $("dCurrent").value = debt ? debt.current_balance : "";
  $("dRate").value = debt && debt.interest_rate != null ? debt.interest_rate : "";
  $("dMin").value = debt && debt.minimum_payment != null ? debt.minimum_payment : "";
  $("debtError").textContent = "";
  // After an edit the card is re-rendered, so fall back to that debt's new Edit button.
  const editButton = () => debt && $("debtList").querySelector(`[data-debt="${CSS.escape(debt.id)}"] [data-act="edit"]`);
  openSheet($("debtSheet"), { opener, fallback: () => editButton() || $("debtPrimary"), focus: $("dName") });
}
const closeDebtForm = () => closeSheet($("debtSheet"));
$("debtSheet").addEventListener("close", () => {
  state.editingDebtId = null;
  $("debtForm").reset();
  $("debtError").textContent = "";
});
$("debtPrimary").addEventListener("click", (e) =>
  e.currentTarget.dataset.action === "pay" ? openPaySheet() : openDebtForm(null, e.currentTarget)
);
$("debtTitleAdd").addEventListener("click", (e) => openDebtForm(null, e.currentTarget));

// Keyed by the debts table's check-constraint names (Postgres's default <table>_<column>_check).
const DEBT_CHECKS = {
  debts_name_check: "Enter a name for the debt (up to 80 characters).",
  debts_debt_type_check: "Choose a type from the list.",
  debts_original_balance_check: "Original balance must be above $0.",
  debts_current_balance_check: "Current balance can't be negative.",
  debts_interest_rate_check: "Interest rate must be between 0 and 100%, or left blank.",
  debts_minimum_payment_check: "Minimum payment must be above $0, or left blank."
};

$("debtForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const num = (id) => ($(id).value === "" ? null : Math.round(parseFloat($(id).value) * 100) / 100);
  const payload = {
    name: $("dName").value.trim(),
    debt_type: $("dType").value,
    original_balance: num("dOriginal"),
    current_balance: num("dCurrent"),
    interest_rate: num("dRate"),
    minimum_payment: num("dMin")
  };
  // The browser's own validation (required/min/max) normally stops these first.
  const invalid =
    !payload.name ? ["dName", DEBT_CHECKS.debts_name_check] :
    !(payload.original_balance > 0) ? ["dOriginal", DEBT_CHECKS.debts_original_balance_check] :
    !(payload.current_balance >= 0) ? ["dCurrent", DEBT_CHECKS.debts_current_balance_check] :
    payload.interest_rate != null && !(payload.interest_rate >= 0 && payload.interest_rate <= 100) ? ["dRate", DEBT_CHECKS.debts_interest_rate_check] :
    payload.minimum_payment != null && !(payload.minimum_payment > 0) ? ["dMin", DEBT_CHECKS.debts_minimum_payment_check] :
    null;
  if (invalid) {
    $("debtError").textContent = invalid[1];
    $(invalid[0]).focus();
    return;
  }
  $("debtError").textContent = "";
  $("debtSave").disabled = true;
  // .select("id") on update: RLS makes an update of a row you can't edit match nothing
  // (no error), so an empty result is how that case shows up.
  const { data, error } = state.editingDebtId
    ? await supabase.from("debts").update(payload).eq("id", state.editingDebtId).select("id")
    : await supabase.from("debts").insert({ ...payload, household_id: state.household.id, created_by: state.session.user.id });
  $("debtSave").disabled = false;
  if (error) {
    if (isMissingTable(error)) {
      state.missing.debts = true;
      closeDebtForm();
      renderDebts();
      return;
    }
    $("debtError").textContent = saveErrorMessage(error, "debt", DEBT_CHECKS);
    return;
  }
  if (state.editingDebtId && !data?.length) {
    $("debtError").textContent = "This debt was deleted, or was added by someone else, so it can't be edited. Reload the app.";
    return;
  }
  const editedId = state.editingDebtId;
  const closed = closeDebtForm();
  await loadDebts();
  notify(editedId ? "Debt updated." : "Debt added.");
  // If the reload replaced the Edit button after the sheet had already given it focus,
  // land on that debt's new Edit button.
  await closed;
  if (!document.activeElement || document.activeElement === document.body) {
    const edit = editedId && $("debtList").querySelector(`[data-debt="${CSS.escape(editedId)}"] [data-act="edit"]`);
    (edit || $("debtPrimary")).focus({ preventScroll: true });
  }
});

const PAYMENT_ERRORS = {
  more_than_balance: "That's more than the remaining balance.",
  invalid_amount: "Enter an amount above $0.",
  debt_not_found: "This debt no longer exists. Reload the app."
};

$("debtList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const debt = state.debts.find((d) => d.id === btn.closest("[data-debt]")?.dataset.debt);
  if (!debt) return;
  if (btn.dataset.act === "edit") return openDebtForm(debt, btn);
  const cardFor = () => document.querySelector(`[data-debt="${CSS.escape(debt.id)}"]`);
  if (btn.dataset.act === "more") {
    if (state.expandedDebts.has(debt.id)) state.expandedDebts.delete(debt.id);
    else state.expandedDebts.add(debt.id);
    renderDebts();
    return cardFor()?.querySelector('[data-act="more"]')?.focus();
  }
  // "Log a payment" toggles its form; the form's Cancel closes it.
  state.payingDebtId = btn.dataset.act === "pay" && state.payingDebtId !== debt.id ? debt.id : null;
  renderDebts();
  if (state.payingDebtId) cardFor()?.querySelector(".pay-amount")?.focus();
  else cardFor()?.querySelector('[data-act="pay"]')?.focus();
});

$("debtList").addEventListener("submit", async (e) => {
  const form = e.target.closest(".pay-form");
  if (!form) return;
  e.preventDefault();
  const debt = state.debts.find((d) => d.id === form.dataset.pay);
  const amount = Math.round(parseFloat(form.querySelector(".pay-amount").value) * 100) / 100;
  const paidOn = form.querySelector(".pay-date").value;
  if (!debt || !(amount > 0)) return;
  form.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const card = () => $("debtList").querySelector(`[data-debt="${CSS.escape(debt.id)}"]`);
  // The form (and its focused Save button) is gone afterwards, so focus goes back to the card.
  const failed = await logDebtPayment(debt, amount, paidOn, {
    refocus: () => card()?.querySelector(".debt-pay, .debt-more")?.focus({ preventScroll: true })
  });
  if (failed) {
    form.querySelectorAll("button").forEach((b) => (b.disabled = false));
    form.querySelector(".pay-error").textContent = failed;
  }
});

// The one "log a payment" action, used by a card's inline form and by the bottom sheet.
// Saves it, shows the new balance at once (the function returns it), runs onSaved (e.g. the
// sheet closing), then celebrates; the full reload happens in the background.
// Returns an error message, or null on success.
async function logDebtPayment(debt, amount, paidOn, { onSaved, refocus }) {
  const { data: newBalance, error } = await supabase.rpc("log_debt_payment", { target_debt: debt.id, pay_amount: amount, paid_on: paidOn });
  if (error) {
    return error.code === "PGRST202" ? "Debt payments " + MIGRATION_HINT : PAYMENT_ERRORS[error.message] ?? "Couldn't save the payment. Try again.";
  }
  const before = debtTotals();
  debt.current_balance = newBalance != null ? Number(newBalance) : Math.max(0, Number(debt.current_balance) - amount);
  const after = debtTotals();
  state.payingDebtId = null;
  renderDebts();
  await onSaved?.();
  const original = Number(debt.original_balance);
  const debtPct = floorPct(Math.min(1, Math.max(0, original - debt.current_balance) / original) * 100);
  const crossed = MILESTONES.filter((m) => before.pct < m && after.pct >= m).pop();
  const headline = debt.current_balance <= 0 ? `${debt.name} is paid off!` : `${fmtMoney(amount)} closer to debt-free`;
  const detail =
    after.current <= 0 ? "That was the last one. You're debt-free!"
    : debt.current_balance <= 0 ? `${fmtMoney(amount)} closer to debt-free.`
    : crossed ? `You've passed ${crossed}% of the way to debt-free.`
    : `You've now paid off ${debtPct}% of ${debt.name}.`;
  // The banner goes in first: it shifts the page down, and the confetti needs final positions.
  notify(`Logged a ${fmtMoney(amount)} payment on ${debt.name}. It's also in Transactions as an expense.`);
  // Confetti bursts from the tip of this debt's bar when it's on screen, else from the toast.
  const r = $("debtList").querySelector(`[data-debt="${CSS.escape(debt.id)}"] .debt-progress`)?.getBoundingClientRect();
  const onScreen = r && r.bottom > 0 && r.top < innerHeight;
  celebrate(headline, detail, onScreen ? { x: r.left + (r.width * debtPct) / 100, y: r.top + r.height / 2 } : null);
  refocus();
  if (await fetchTransactions()) render();
  const focused = document.activeElement;
  await loadDebts(); // re-renders the cards
  if (!focused?.isConnected) refocus();
  return null;
}

// ---- "Log a payment" sheet (uses the shared sheet component) ----
function sheetDefaultAmount(debt) {
  const balance = Number(debt.current_balance);
  $("sheetAmount").max = String(balance);
  $("sheetAmount").value = debt.minimum_payment ? String(Math.min(Number(debt.minimum_payment), balance)) : "";
}

function openPaySheet() {
  const payable = state.debts.filter((d) => Number(d.current_balance) > 0);
  if (!payable.length) return;
  // Every debt is listed so it's clear what exists; paid-off ones can't take a payment.
  // With a single debt to pay it's preselected; with several you choose.
  const options = state.debts.map((d) => {
    const opt = new Option(Number(d.current_balance) > 0 ? d.name : `${d.name} (paid off)`, d.id);
    opt.disabled = Number(d.current_balance) <= 0;
    return opt;
  });
  if (payable.length > 1) {
    const placeholder = new Option("Choose a debt", "", true, true);
    placeholder.disabled = true;
    options.unshift(placeholder);
  }
  $("sheetDebt").replaceChildren(...options);
  $("sheetDebt").value = payable.length === 1 ? payable[0].id : "";
  if (payable.length === 1) sheetDefaultAmount(payable[0]);
  else $("sheetAmount").value = "";
  $("sheetError").textContent = "";
  $("sheetSubmit").disabled = false;
  openSheet($("paySheet"), { opener: $("debtPrimary"), focus: payable.length === 1 ? $("sheetAmount") : $("sheetDebt") });
}

$("sheetDebt").addEventListener("change", () => {
  const debt = state.debts.find((d) => d.id === $("sheetDebt").value);
  if (debt) sheetDefaultAmount(debt);
});
$("paySheetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const debt = state.debts.find((d) => d.id === $("sheetDebt").value);
  const amount = Math.round(parseFloat($("sheetAmount").value) * 100) / 100;
  if (!debt || !(amount > 0)) return;
  $("sheetError").textContent = "";
  $("sheetSubmit").disabled = true;
  const failed = await logDebtPayment(debt, amount, dayKey(new Date()), {
    onSaved: () => closeSheet($("paySheet")), // resolves once it's gone, so confetti isn't under it
    refocus: () => $("debtPrimary").focus({ preventScroll: true })
  });
  $("sheetSubmit").disabled = false;
  if (failed) $("sheetError").textContent = failed;
});

async function fetchTransactions() {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("household_id", state.household.id)
    .order("date", { ascending: false })
    .limit(1000);
  if (error) return false;
  state.tx = data;
  return true;
}

// Realtime doesn't send DELETE events on our filtered channel, so a partner's deletes
// would otherwise only show after a reload. Re-sync whenever the app comes back into view.
// At most once every 30 s: flicking between apps (or a browser resizing) can fire this repeatedly.
let lastForegroundSync = 0;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.household) return;
  if (Date.now() - lastForegroundSync < 30000) return;
  lastForegroundSync = Date.now();
  const added = await runRecurringRules(); // a new day may have made a rule due
  if (await fetchTransactions()) render();
  if (added > 0) notify(`Added ${added} recurring ${added === 1 ? "entry" : "entries"} for this month.`);
  loadRules();
  loadDebts();
  loadCategoryUsage();
});

async function startLedger() {
  populateCategorySelect();
  renderPeriodControls();

  // Due recurring entries are created first, so the first fetch already includes them.
  lastForegroundSync = Date.now(); // start-up is itself a fresh sync
  const autoAdded = await runRecurringRules();
  if (!(await fetchTransactions())) {
    $("permBanner").style.display = "block";
    $("permBanner").textContent = "Couldn't load transactions. Reload to try again.";
    return;
  }
  render();
  if (autoAdded > 0) notify(`Added ${autoAdded} recurring ${autoAdded === 1 ? "entry" : "entries"} for this month.`);
  loadRules();
  loadDebts();
  loadCategoryUsage();

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
    .subscribe();
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------
function resetSignedInState() {
  if (state.realtimeChannel) supabase.removeChannel(state.realtimeChannel);
  Object.assign(state, {
    routedUserId: null, household: null, names: {}, inviteLink: null, tx: [], realtimeChannel: null,
    rules: [], debts: [], payingDebtId: null, editingDebtId: null, txQuery: "", txFilter: "all", txAllPage: 1
  });
  state.members = [];
  state.journeyPct = undefined;
  state.categoryUsage = null;
  document.querySelectorAll("dialog.sheet[open]").forEach((sheet) => sheet.close());
  showAppView("dashboard");
  $("inviteSlotTop").append($("invitePanel"));
  $("invitePanel").hidden = true;
  closeAccountMenu(false);
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
