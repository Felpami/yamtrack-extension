// AnimeWorld → Yamtrack: content script for animeworld /play/ pages.
//
// Badge layout:
//   line 1  what was recognized:  <title> · MAL <id> · Ep <n>
//   line 2  status / error, with a fix link when there is one
(() => {
  const POLL_MS = 2000;
  const MIN_VIDEO_SECONDS = 120; // ignore trailers/ads shorter than this

  let settings = { thresholdPct: 80, fallbackMinutes: 15, enabled: true, baseUrl: "" };
  let current = null; // per-episode state, see newEpisodeState()
  let lastProblemKey = null; // avoid re-rendering the same "not recognized" message
  const hookedVideos = new WeakSet();

  // ---------- page parsing ----------

  function readMalId() {
    const a = document.querySelector(
      '#mal-button[href*="myanimelist.net/anime/"], a.watchlist-edit-mal[href*="myanimelist.net/anime/"], a[href*="myanimelist.net/anime/"]'
    );
    const m = a && a.href.match(/myanimelist\.net\/anime\/(\d+)/);
    return m ? m[1] : null;
  }

  function readEpisodeRaw() {
    const active = document.querySelector(".server.active .episode a.active, .episode a.active");
    const raw =
      (active && (active.dataset.episodeNum || active.dataset.num)) ||
      document.querySelector("#player[data-num]")?.dataset.num;
    return raw ? raw.trim() : null;
  }

  function readPageTitle() {
    const h = document.querySelector("#anime-title, h1.title, h2.title");
    return h ? (h.dataset.jtitle || h.textContent).trim() : document.title;
  }

  // ---------- badge UI ----------

  let badge, showLine, statusLine, actionLink, syncBtn;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function ensureBadge() {
    if (badge) return;
    badge = el("div");
    badge.id = "aw-yamtrack-badge";
    const main = el("div", "aw-yt-main");
    showLine = el("div", "aw-yt-show");
    const statusRow = el("div", "aw-yt-status-row");
    statusLine = el("span", "aw-yt-status");
    actionLink = el("a", "aw-yt-action");
    actionLink.target = "_blank";
    actionLink.rel = "noopener";
    statusRow.append(statusLine, actionLink);
    main.append(showLine, statusRow);
    syncBtn = el("button", "aw-yt-sync", "Sync now");
    syncBtn.type = "button";
    syncBtn.addEventListener("click", () => doSync(true));
    const close = el("button", "aw-yt-close", "×");
    close.type = "button";
    close.title = "Hide";
    close.addEventListener("click", () => badge.classList.add("aw-yt-hidden"));
    badge.append(main, syncBtn, close);
    document.body.appendChild(badge);
  }

  // show: { title, malId, episode } | null ; action: { label, href } | { label, onClick } | null
  function render({ show, status, state = "idle", action = null, canSync = true }) {
    ensureBadge();
    badge.dataset.state = state;

    showLine.replaceChildren();
    if (show) {
      showLine.append(el("strong", null, show.title || "Unknown title"), " · ");
      if (show.malId) {
        const mal = el("a", "aw-yt-mal", `MAL ${show.malId}`);
        mal.href = `https://myanimelist.net/anime/${show.malId}`;
        mal.target = "_blank";
        mal.rel = "noopener";
        mal.title = "Recognized MyAnimeList entry";
        showLine.append(mal, " · ");
      }
      showLine.append(`Ep ${show.episode ?? "?"}`);
    } else {
      showLine.textContent = "Yamtrack";
    }

    statusLine.textContent = status;
    actionLink.hidden = !action;
    actionLink.onclick = null;
    if (action) {
      actionLink.textContent = action.label;
      if (action.href) actionLink.href = action.href;
      else {
        actionLink.removeAttribute("href");
        actionLink.onclick = (e) => (e.preventDefault(), action.onClick());
      }
    }
    syncBtn.hidden = !canSync || state === "busy" || state === "done";
  }

  function showInfo(c) {
    return { title: c.ytTitle || c.pageTitle, malId: c.malId, episode: c.episode };
  }

  // Error → message + fix action. `queued` = the episode is safely waiting in the queue.
  function describeError(code, message, queued) {
    const later = queued ? " Ep queued — will sync after." : "";
    switch (code) {
      case "auth":
        return {
          status: `⚠ Not logged in to Yamtrack.${later || " Log in so episodes can sync."}`,
          action: settings.baseUrl ? { label: "Open Yamtrack", href: settings.baseUrl + "/accounts/login/" } : null,
          state: queued ? "queued" : "error",
        };
      case "offline":
        return {
          status: `⚠ Can't reach Yamtrack (${settings.baseUrl}).${later || " Check it's running / you're on your network."}`,
          action: settings.baseUrl ? { label: "Open Yamtrack", href: settings.baseUrl } : null,
          state: queued ? "queued" : "error",
        };
      case "nourl":
        return {
          status: "⚠ Yamtrack URL not set.",
          action: { label: "Open settings", onClick: () => send({ type: "openOptions" }) },
          state: "error",
        };
      default:
        return { status: `⚠ ${message}`, action: null, state: "error" };
    }
  }

  function describeYamtrack(c) {
    // Check existence first: for untracked shows Yamtrack's form defaults status to "Completed".
    if (!c.ytExists) return "Yamtrack: not in your list yet";
    if (c.ytStatus === "Completed") return "Yamtrack: Completed";
    return `Yamtrack: ep ${c.ytProgress} · ${c.ytStatus}`;
  }

  function describeWaiting(c) {
    if (c.ytExists && c.ytStatus === "Completed") return `${describeYamtrack(c)} — nothing to sync`;
    if (c.ytExists && c.ytProgress >= c.episode) return `${describeYamtrack(c)} — already up to date`;
    const minsLeft = Math.max(1, Math.ceil((settings.fallbackMinutes * 60 - c.visibleSeconds) / 60));
    const when = c.sawVideo
      ? `syncs at ${settings.thresholdPct}% watched`
      : settings.fallbackMinutes > 0
        ? `player not found yet — syncs in ~${minsLeft} min on page`
        : "player not found — use Sync now";
    const queued = c.queuedEpisode ? ` · ep ${c.queuedEpisode} queued` : "";
    return `${describeYamtrack(c)} → ${when}${queued}`;
  }

  function renderWaiting(c) {
    if (c.peekError) {
      const d = describeError(c.peekError.code, c.peekError.message, false);
      render({ show: showInfo(c), ...d });
    } else if (c.peeked) {
      render({ show: showInfo(c), status: describeWaiting(c), state: "idle" });
    } else {
      render({ show: showInfo(c), status: "Checking Yamtrack…", state: "busy" });
    }
  }

  // ---------- messaging ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) =>
          resolve(res || { ok: false, message: chrome.runtime.lastError?.message || "No response from extension" })
        );
      } catch (e) {
        resolve({ ok: false, message: "Extension was reloaded — refresh this page." });
      }
    });
  }

  async function doPeek(c) {
    if (!settings.enabled) {
      render({ show: showInfo(c), status: "Sync disabled in extension settings.", state: "idle", canSync: false });
      return;
    }
    c.peekAt = Date.now();
    const res = await send({ type: "peek", malId: c.malId });
    if (c !== current) return;
    c.peeked = true;
    if (res.ok) {
      c.peekError = null;
      c.ytTitle = res.title;
      c.ytExists = res.exists;
      c.ytProgress = res.progress;
      c.ytStatus = res.status;
      c.queuedEpisode = res.queuedEpisode;
    } else {
      c.peekError = { code: res.code, message: res.message };
    }
    if (!c.synced && !c.syncing) renderWaiting(c);
  }

  async function doSync(manual) {
    const c = current;
    if (!c || c.syncing || (c.synced && !manual)) return;
    c.syncing = true;
    render({ show: showInfo(c), status: `Syncing ep ${c.episode}…`, state: "busy" });
    const res = await send({ type: "sync", malId: c.malId, episode: c.episode, title: c.pageTitle });
    c.syncing = false;
    if (c !== current) return; // episode changed meanwhile
    if (res.title) c.ytTitle = res.title;

    if (res.ok && res.result === "queued") {
      c.synced = true; // handed to the queue; don't re-trigger on every timeupdate
      render({ show: showInfo(c), ...describeError(res.code, res.message, true) });
    } else if (res.ok && res.result === "updated") {
      c.synced = true;
      const done = res.status === "Completed";
      render({
        show: showInfo(c),
        status: done ? `✓ Synced — Yamtrack: Completed 🎉` : `✓ Synced — Yamtrack: ep ${res.progress} · ${res.status}`,
        state: "done",
      });
    } else if (res.ok && res.result === "skipped") {
      c.synced = true;
      render({
        show: showInfo(c),
        status:
          res.reason === "completed"
            ? "✓ Already Completed in Yamtrack — nothing changed"
            : `✓ Yamtrack already at ep ${res.progress} — nothing changed`,
        state: "done",
      });
    } else if (res.ok) {
      render({ show: showInfo(c), status: res.message, state: "idle" });
    } else {
      render({ show: showInfo(c), ...describeError(res.code, res.message, false) });
    }
  }

  // ---------- watch detection ----------

  // AnimeWorld's own server plays the episode inside a same-origin iframe
  // (/api/episode/serverPlayerAnimeWorld?id=…), so look inside same-origin frames too.
  // Cross-origin frames (YouTube trailer, external hosts) throw and are skipped.
  function findVideos(doc = document, depth = 0) {
    const vids = [...doc.querySelectorAll("video")];
    if (depth < 2) {
      for (const f of doc.querySelectorAll("iframe")) {
        try {
          if (f.contentDocument) vids.push(...findVideos(f.contentDocument, depth + 1));
        } catch {
          /* cross-origin */
        }
      }
    }
    return vids;
  }

  const isEpisodeVideo = (v) => isFinite(v.duration) && v.duration >= MIN_VIDEO_SECONDS;

  function markVideoSeen() {
    const c = current;
    if (c && !c.sawVideo) {
      c.sawVideo = true;
      if (!c.syncing && !c.synced && c.peeked) renderWaiting(c);
    }
  }

  function hookVideos() {
    for (const v of findVideos()) {
      if (isEpisodeVideo(v)) markVideoSeen(); // metadata already loaded
      if (hookedVideos.has(v)) continue;
      hookedVideos.add(v);
      v.addEventListener("loadedmetadata", () => isEpisodeVideo(v) && markVideoSeen());
      v.addEventListener("timeupdate", () => {
        const c = current;
        if (!c || c.synced || !isEpisodeVideo(v)) return;
        markVideoSeen();
        if (v.currentTime / v.duration >= settings.thresholdPct / 100) doSync(false);
      });
    }
  }

  function newEpisodeState(malId, episode) {
    return {
      key: `${malId}:${episode}`, malId, episode, pageTitle: readPageTitle(),
      synced: false, syncing: false, visibleSeconds: 0, sawVideo: false,
      peeked: false, peekError: null, ytTitle: null, ytExists: false, ytProgress: 0, ytStatus: null, queuedEpisode: null,
    };
  }

  function tick() {
    const malId = readMalId();
    const raw = readEpisodeRaw();

    // Problems that prevent syncing on this page: say so instead of staying silent.
    let problem = null;
    if (!malId) problem = { k: "nomal", status: "⚠ Show not recognized: this page has no MyAnimeList link." };
    else if (!raw) problem = { k: "noep", status: "⚠ Couldn't find the episode number on this page." };
    else if (!/^\d+$/.test(raw)) problem = { k: "special:" + raw, status: `Episode "${raw}" is a special — not synced.` };
    if (problem) {
      current = null;
      if (lastProblemKey !== problem.k + malId) {
        lastProblemKey = problem.k + malId;
        render({
          show: malId ? { title: readPageTitle(), malId, episode: raw } : null,
          status: problem.status,
          state: problem.k.startsWith("special") ? "idle" : "error",
          canSync: false,
        });
      }
      return;
    }
    lastProblemKey = null;

    const episode = parseInt(raw, 10);
    if (!current || current.key !== `${malId}:${episode}`) {
      current = newEpisodeState(malId, episode);
      renderWaiting(current);
      doPeek(current);
    }

    hookVideos();
    const c = current;
    // While showing a connection error (e.g. logged out), re-check so the badge clears after you log in.
    if (c.peekError && !c.synced && !c.syncing && Date.now() - (c.peekAt || 0) > 30000) doPeek(c);
    if (!settings.enabled || c.synced || c.syncing || c.peekError?.code === "nourl") return;

    // Fallback for players we can't see into (cross-origin iframes): time on page.
    if (!c.sawVideo && document.visibilityState === "visible" && settings.fallbackMinutes > 0) {
      c.visibleSeconds += POLL_MS / 1000;
      if (c.visibleSeconds >= settings.fallbackMinutes * 60) doSync(false);
      else if (Math.round(c.visibleSeconds) % 30 === 0 && c.peeked) renderWaiting(c);
    }
  }

  async function init() {
    const res = await send({ type: "getSettings" });
    if (res.ok) settings = { ...settings, ...res };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      if (current) {
        current.peeked = false;
        doPeek(current); // e.g. URL just set → re-check
      }
    });
    tick();
    setInterval(tick, POLL_MS);
  }

  init();
})();
