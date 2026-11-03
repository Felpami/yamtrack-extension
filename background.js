// AnimeWorld → Yamtrack: background service worker.
//
// Yamtrack (upstream) has no token API, so we talk to the same endpoints its
// web UI uses, with the user's normal login session:
//   GET  {base}/track_modal/mal/anime/{malId}?return_url=/   -> form + CSRF token
//   POST {base}/media_save                                   -> create/update entry
// Django's CSRF check rejects requests whose Origin isn't the Yamtrack origin, and
// extension requests carry Origin: chrome-extension://…, so a declarativeNetRequest
// rule rewrites Origin/Referer — only for requests initiated by this extension.

const DEFAULTS = {
  baseUrl: "",
  thresholdPct: 80,
  fallbackMinutes: 15,
  enabled: true,
};
const ORIGIN_RULE_ID = 1;

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

function normBase(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

async function applyOriginRule() {
  const { baseUrl } = await getSettings();
  const base = normBase(baseUrl);
  const addRules = [];
  if (base) {
    const origin = new URL(base).origin;
    addRules.push({
      id: ORIGIN_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "set", value: origin },
          { header: "referer", operation: "set", value: base + "/" },
        ],
      },
      condition: {
        urlFilter: "|" + origin + "/",
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest", "other"],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  applyOriginRule();
  chrome.storage.sync.get("baseUrl").then(({ baseUrl }) => {
    if (!baseUrl) chrome.runtime.openOptionsPage();
  });
});
chrome.runtime.onStartup.addListener(applyOriginRule);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.baseUrl) applyOriginRule();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// ---------- tiny HTML form parsing (no DOMParser in service workers) ----------

function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const m = tag.match(new RegExp("\\s" + name + '="([^"]*)"'));
  return m ? unescapeHtml(m[1]) : null;
}

// Extracts the media_save form fields from the track_modal HTML.
function parseTrackForm(html) {
  const formMatch = html.match(/<form[^>]*media_save[\s\S]*?<\/form>/);
  if (!formMatch) return null;
  const form = formMatch[0];
  const fields = {};
  for (const tag of form.match(/<input\b[^>]*>/g) || []) {
    const name = attr(tag, "name");
    if (name) fields[name] = attr(tag, "value") ?? "";
  }
  const select = form.match(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/);
  if (select) {
    const sel = select[1].match(/<option value="([^"]*)"[^>]*\sselected/);
    fields.status = sel ? unescapeHtml(sel[1]) : "";
  }
  const notes = form.match(/<textarea[^>]*name="notes"[^>]*>([\s\S]*?)<\/textarea>/);
  if (notes) fields.notes = unescapeHtml(notes[1].replace(/^\r?\n/, ""));
  const titleMatch = html.match(/<h\d[^>]*>([^<]+)<\/h\d>/);
  return { fields, title: titleMatch ? unescapeHtml(titleMatch[1]).trim() : null };
}

// ---------- Yamtrack calls ----------

class YamtrackError extends Error {
  // code: "auth" (logged out) and "offline" (unreachable) are retryable → queued.
  constructor(message, code = "error") {
    super(message);
    this.code = code;
  }
}

async function ytFetch(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: "include", ...init });
  } catch (e) {
    throw new YamtrackError("Cannot reach Yamtrack (" + e.message + ")", "offline");
  }
  if (/\/accounts\/login\/?/.test(new URL(res.url).pathname)) {
    throw new YamtrackError("Not logged in to Yamtrack.", "auth");
  }
  return res;
}

async function loadEntry(base, malId) {
  const res = await ytFetch(
    `${base}/track_modal/mal/anime/${encodeURIComponent(malId)}?return_url=/`
  );
  if (!res.ok) throw new YamtrackError(`Yamtrack returned HTTP ${res.status} for MAL ${malId}`);
  const parsed = parseTrackForm(await res.text());
  if (!parsed || !parsed.fields.csrfmiddlewaretoken) {
    throw new YamtrackError("Unexpected Yamtrack response (form not found).");
  }
  const f = parsed.fields;
  return {
    exists: Boolean(f.instance_id),
    progress: parseInt(f.progress || "0", 10),
    status: f.status,
    title: parsed.title,
    fields: f,
  };
}

function nowLocalInput() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function syncEpisode({ malId, episode, viaQueue = false }) {
  const { baseUrl, enabled } = await getSettings();
  const base = normBase(baseUrl);
  if (!enabled) return { result: "disabled", message: "Sync is disabled in settings." };
  if (!base) throw new YamtrackError("Yamtrack URL not set.", "nourl");

  const entry = await loadEntry(base, malId);
  const label = entry.title || `MAL ${malId}`;

  const info = { title: entry.title, progress: entry.progress, status: entry.status };
  if (entry.exists && entry.status === "Completed") {
    return { ...info, result: "skipped", reason: "completed", message: `${label} is already Completed in Yamtrack.` };
  }
  if (entry.exists && entry.progress >= episode) {
    return { ...info, result: "skipped", reason: "ahead", message: `${label}: Yamtrack is already at ep ${entry.progress}.` };
  }

  const f = entry.fields;
  const body = new URLSearchParams({
    csrfmiddlewaretoken: f.csrfmiddlewaretoken,
    instance_id: f.instance_id || "",
    media_type: "anime",
    source: "mal",
    media_id: String(malId),
    progress: String(episode),
    // "In progress" + progress == total makes Yamtrack auto-complete the entry.
    status: "In progress",
    score: entry.exists ? f.score || "" : "",
    start_date: entry.exists && f.start_date ? f.start_date : nowLocalInput(),
    end_date: entry.exists ? f.end_date || "" : "",
    notes: entry.exists ? f.notes || "" : "",
  });

  const res = await ytFetch(`${base}/media_save`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status === 403) {
    throw new YamtrackError("Yamtrack rejected the request (CSRF 403). Re-save the extension settings.");
  }
  if (!res.ok) throw new YamtrackError(`Yamtrack save failed: HTTP ${res.status}`);

  // Verify, since media_save redirects back even when form validation fails.
  const after = await loadEntry(base, malId);
  if (after.progress < episode && after.status !== "Completed") {
    throw new YamtrackError(`Save did not stick (Yamtrack shows ep ${after.progress}).`);
  }
  await recordHistory({ malId, title: after.title || label, episode: after.progress, status: after.status, viaQueue });
  return {
    result: "updated",
    title: after.title,
    progress: after.progress,
    status: after.status,
    message:
      after.status === "Completed"
        ? `${label}: ep ${episode} — marked Completed 🎉`
        : `${label}: progress → ep ${after.progress}`,
  };
}

async function testConnection() {
  const { baseUrl } = await getSettings();
  const base = normBase(baseUrl);
  if (!base) throw new YamtrackError("No Yamtrack URL set.", "nourl");
  const res = await ytFetch(`${base}/settings/account`);
  if (!res.ok) throw new YamtrackError(`Yamtrack returned HTTP ${res.status}`);
  const flushed = await flushQueue();
  return {
    result: "ok",
    message: "Connected and logged in to Yamtrack." + (flushed ? ` Sent ${flushed} queued update(s).` : ""),
  };
}

// ---------- recent syncs (shown on the settings page) ----------

const HISTORY_MAX = 10;
async function recordHistory(entry) {
  const { history } = await chrome.storage.local.get({ history: [] });
  history.unshift({ ...entry, at: Date.now() });
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

// ---------- offline / logged-out queue ----------
// chrome.storage.local (not synced): { queue: { [malId]: { malId, episode, title, queuedAt } } }

async function getQueue() {
  return (await chrome.storage.local.get({ queue: {} })).queue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
  const n = Object.keys(queue).length;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  await chrome.action.setTitle({
    title: n ? `AnimeWorld → Yamtrack: ${n} update(s) waiting for Yamtrack login` : "AnimeWorld → Yamtrack settings",
  });
}

async function enqueue({ malId, episode, title }) {
  const queue = await getQueue();
  const prev = queue[malId];
  if (!prev || prev.episode < episode) {
    queue[malId] = { malId, episode, title: title || prev?.title || null, queuedAt: Date.now() };
    await setQueue(queue);
  }
}

let flushing = null;
function flushQueue() {
  // Single-flight: concurrent triggers share one run.
  flushing ??= (async () => {
    let sent = 0;
    try {
      for (const item of Object.values(await getQueue())) {
        try {
          await syncEpisode({ ...item, viaQueue: true });
          sent++;
        } catch (e) {
          if (e.code === "auth" || e.code === "offline") break; // still unavailable; retry later
          console.warn("Dropping queued update", item, e.message); // permanent error
        }
        const q = await getQueue();
        if (q[item.malId] && q[item.malId].episode <= item.episode) delete q[item.malId];
        await setQueue(q);
      }
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}

// Sync now; if Yamtrack is logged out/unreachable, queue it instead of failing.
async function syncOrQueue(msg) {
  try {
    const res = await syncEpisode(msg);
    flushQueue(); // we're clearly online + logged in: push anything pending
    return res;
  } catch (e) {
    if (e.code === "auth" || e.code === "offline") {
      await enqueue(msg);
      return { result: "queued", code: e.code, message: e.message };
    }
    throw e;
  }
}

// Flush triggers: Yamtrack login cookie appears, browser start, every 15 min.
chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed || cookie.name !== "sessionid") return;
  const { baseUrl } = await getSettings();
  if (!baseUrl) return;
  const host = new URL(normBase(baseUrl)).hostname;
  if (cookie.domain.replace(/^\./, "") === host) flushQueue();
});
// Only create if missing: re-creating on every service-worker wake would reset the timer.
chrome.alarms.get("flush-queue").then((a) => {
  if (!a) chrome.alarms.create("flush-queue", { periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "flush-queue") flushQueue();
});
chrome.runtime.onStartup.addListener(() => {
  getQueue().then(setQueue); // restore icon badge
  flushQueue();
});

// What Yamtrack currently has for this show (used by the page badge on load).
async function peek({ malId }) {
  const { baseUrl } = await getSettings();
  const base = normBase(baseUrl);
  if (!base) throw new YamtrackError("Yamtrack URL not set.", "nourl");
  const e = await loadEntry(base, malId);
  const queued = (await getQueue())[malId];
  return {
    baseUrl: base,
    title: e.title,
    exists: e.exists,
    progress: e.progress,
    status: e.status,
    queuedEpisode: queued ? queued.episode : null,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    sync: () => syncOrQueue(msg),
    peek: () => peek(msg),
    openOptions: async () => (chrome.runtime.openOptionsPage(), { result: "ok" }),
    test: testConnection,
    getSettings,
    getQueue: async () => ({ queue: await getQueue() }),
    dequeue: async () => {
      const q = await getQueue();
      delete q[msg.malId];
      await setQueue(q); // also updates the toolbar count
      return { result: "ok" };
    },
    getActivity: async () => ({
      queue: await getQueue(),
      history: (await chrome.storage.local.get({ history: [] })).history,
    }),
    flush: async () => ({ sent: await flushQueue() }),
    applyRule: () => applyOriginRule().then(() => ({ result: "ok" })),
  };
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  fn()
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, code: e.code || "error", message: e.message || String(e) }));
  return true; // async response
});
