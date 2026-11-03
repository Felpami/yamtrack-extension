const $ = (id) => document.getElementById(id);
const DEFAULTS = { baseUrl: "", thresholdPct: 80, fallbackMinutes: 15, enabled: true };

// ---------- helpers ----------

function show(msg, ok) {
  $("status").textContent = msg;
  $("status").className = ok ? "ok" : "err";
}

const CONN_TEXT = {
  ok: "Connected",
  auth: "Not logged in",
  offline: "Unreachable",
  nourl: "Not set up",
  error: "Error",
  unknown: "Checking…",
};
function setConn(state) {
  $("conn").dataset.state = state;
  $("connText").textContent = CONN_TEXT[state] || state;
  const base = $("baseUrl").value.trim().replace(/\/+$/, "");
  const link = $("openYamtrack");
  link.hidden = !base || state === "nourl";
  if (base) link.href = state === "auth" ? base + "/accounts/login/" : base;
  link.textContent = state === "auth" ? "Log in to Yamtrack ↗" : "Open Yamtrack ↗";
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function malLink(malId) {
  const a = el("a", null, `MAL ${malId}`);
  a.href = `https://myanimelist.net/anime/${malId}`;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

let savedTimer;
function flashSaved() {
  $("savedTick").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("savedTick").classList.remove("show"), 1200);
}

// ---------- load ----------

function paintRange() {
  const v = +$("thresholdPct").value;
  $("thresholdOut").textContent = v + "%";
  const pct = ((v - 10) / 90) * 100;
  $("thresholdPct").style.setProperty("--fill", pct + "%");
}

async function load() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("baseUrl").value = s.baseUrl;
  $("thresholdPct").value = s.thresholdPct;
  $("fallbackMinutes").value = s.fallbackMinutes;
  $("enabled").checked = s.enabled;
  paintRange();
  document.body.dataset.loaded = "1";
  checkConnection();
  renderActivity();
}

// Passive check on open (no permission prompt): uses the saved URL.
async function checkConnection() {
  const saved = (await chrome.storage.sync.get(DEFAULTS)).baseUrl;
  if (!saved) return setConn("nourl");
  setConn("unknown");
  const res = await chrome.runtime.sendMessage({ type: "test" });
  setConn(res.ok ? "ok" : res.code || "error");
}

// ---------- URL save / test ----------

async function save(quiet = false) {
  let base = $("baseUrl").value.trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    show("Enter a valid http(s) URL, e.g. http://192.168.1.50:8000", false);
    return false;
  }
  // Port-less pattern on purpose: it covers every port, and the cookies API
  // (used to detect Yamtrack logins for the queue) ignores ports when checking.
  // Must run inside the click handler (user gesture).
  const pattern = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    show("Permission to access " + url.hostname + " was denied.", false);
    return false;
  }
  await chrome.storage.sync.set({ baseUrl: base });
  $("baseUrl").value = base;
  await chrome.runtime.sendMessage({ type: "applyRule" });
  if (!quiet) show("Saved.", true);
  return true;
}

async function test() {
  const btn = $("test");
  btn.disabled = true;
  show("Testing…", true);
  setConn("unknown");
  try {
    // Test what's in the form, not a stale saved value.
    if (!(await save(true))) return setConn("error");
    const res = await chrome.runtime.sendMessage({ type: "test" });
    show(res.message, res.ok);
    setConn(res.ok ? "ok" : res.code || "error");
    renderActivity();
  } finally {
    btn.disabled = false;
  }
}

// ---------- behaviour settings: save instantly ----------

async function saveBehaviour() {
  await chrome.storage.sync.set({
    thresholdPct: Math.min(100, Math.max(1, parseInt($("thresholdPct").value, 10) || 80)),
    fallbackMinutes: Math.min(180, Math.max(0, parseInt($("fallbackMinutes").value, 10) || 0)),
    enabled: $("enabled").checked,
  });
  flashSaved();
}

// ---------- queue + history ----------

async function renderActivity() {
  const res = await chrome.runtime.sendMessage({ type: "getActivity" });
  if (!res || !res.ok) return;

  const items = Object.values(res.queue).sort((a, b) => b.queuedAt - a.queuedAt);
  const qList = $("queueList");
  qList.replaceChildren(
    ...items.map((it) => {
      const li = el("li");
      li.append(el("span", "ep-badge wait", `Ep ${it.episode}`));
      const main = el("div", "item-main");
      main.append(el("div", "item-title", it.title || `MAL ${it.malId}`));
      const meta = el("div", "item-meta");
      meta.append(malLink(it.malId), ` · queued ${timeAgo(it.queuedAt)}`);
      main.append(meta);
      li.append(main);
      const rm = el("button", "remove-btn", "✕");
      rm.type = "button";
      rm.title = "Remove from queue (won't be sent to Yamtrack)";
      rm.setAttribute("aria-label", `Remove ${it.title || "MAL " + it.malId} ep ${it.episode} from queue`);
      rm.addEventListener("click", async () => {
        rm.disabled = true;
        li.classList.add("removing");
        await chrome.runtime.sendMessage({ type: "dequeue", malId: it.malId });
        show(`Removed ${it.title || "MAL " + it.malId} ep ${it.episode} from the queue.`, true);
        renderActivity();
      });
      li.append(rm);
      return li;
    })
  );
  $("queueCount").textContent = items.length;
  $("queueCount").classList.toggle("has", items.length > 0);
  $("queueEmpty").hidden = items.length > 0;
  $("flush").hidden = items.length === 0;

  const hList = $("historyList");
  hList.replaceChildren(
    ...res.history.map((h) => {
      const li = el("li");
      const done = h.status === "Completed";
      li.append(el("span", "ep-badge" + (done ? " done" : ""), done ? "✓ Done" : `Ep ${h.episode}`));
      const main = el("div", "item-main");
      main.append(el("div", "item-title", h.title || `MAL ${h.malId}`));
      const meta = el("div", "item-meta");
      meta.append(malLink(h.malId), ` · ${done ? "Completed" : h.status} · ${timeAgo(h.at)}${h.viaQueue ? " · sent from queue" : ""}`);
      main.append(meta);
      li.append(main);
      return li;
    })
  );
  $("historyEmpty").hidden = res.history.length > 0;
  $("historyCount").textContent = res.history.length;
}

async function flush() {
  const btn = $("flush");
  btn.disabled = true;
  btn.textContent = "Sending…";
  const res = await chrome.runtime.sendMessage({ type: "flush" });
  btn.disabled = false;
  btn.textContent = "Send now";
  await renderActivity();
  const left = Object.keys((await chrome.runtime.sendMessage({ type: "getQueue" })).queue).length;
  if (left) {
    show(`Still ${left} waiting — is Yamtrack reachable and are you logged in?`, false);
    checkConnection();
  } else if (res.ok) {
    show(`Sent ${res.sent} update(s).`, true);
  }
}

// ---------- wire up ----------

$("save").addEventListener("click", () => save().then((ok) => ok && checkConnection()));
$("test").addEventListener("click", test);
$("baseUrl").addEventListener("keydown", (e) => e.key === "Enter" && test());
$("flush").addEventListener("click", flush);
$("enabled").addEventListener("change", saveBehaviour);
$("thresholdPct").addEventListener("input", paintRange);
$("thresholdPct").addEventListener("change", saveBehaviour);
$("fallbackMinutes").addEventListener("change", saveBehaviour);
for (const b of document.querySelectorAll(".step")) {
  b.addEventListener("click", () => {
    const i = $("fallbackMinutes");
    i.value = Math.min(180, Math.max(0, (parseInt(i.value, 10) || 0) + +b.dataset.step));
    saveBehaviour();
  });
}
// Keep queue/history live while the page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.queue || changes.history)) renderActivity();
});
setInterval(renderActivity, 30000); // refresh "x min ago"

load();
