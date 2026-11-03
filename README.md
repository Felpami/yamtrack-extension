# AnimeWorld → Yamtrack

Browser extension (Chrome / Edge, Manifest V3) that updates your self-hosted
[Yamtrack](https://github.com/FuzzyGrim/Yamtrack) anime progress when you watch an
episode on animeworld.ac / .so / .tv.

## How it works

- Reads the MyAnimeList ID from the episode page's MAL link (`#mal-button`) and the
  episode number from the active episode (`.episode a.active` / `#player[data-num]`).
  No title matching, so no wrong-show matches.
- Syncs when you reach 80% of the episode video. AnimeWorld's own server plays it in a
  same-origin iframe (`/api/episode/serverPlayerAnimeWorld?id=…`), which the extension
  looks inside; videos under 2 minutes (the YouTube trailer) are ignored. With a
  cross-origin player (other servers) it falls back to "15 minutes on the page". A
  **Sync now** button in the bottom-right badge works any time.
- Talks to Yamtrack with your normal browser login (upstream Yamtrack has no API
  tokens): `GET /track_modal/mal/anime/<id>` for the form + CSRF token, then
  `POST /media_save`. A `declarativeNetRequest` rule sets `Origin`/`Referer` to your
  Yamtrack URL **only for requests made by this extension**, so Django's CSRF check
  passes without changing Yamtrack's config.
- Rules: creates the entry if missing (In progress, start date = now); never lowers
  progress; never touches entries already Completed; reaching the last episode makes
  Yamtrack mark it Completed. Score, notes and dates are preserved.

## Offline / logged-out queue

If Yamtrack is unreachable or you're logged out, the episode is queued (the page
badge turns amber and the toolbar icon shows the count) instead of being lost. Only
the highest episode per show is kept. The queue lives in `chrome.storage.local`, on
disk, so it survives browser restarts, network outages and reboots. It is sent when:
you log in to Yamtrack (detected via its `sessionid` cookie), the browser starts,
every 15 minutes, after any successful sync, or when you click **Test connection**.
Only uninstalling the extension or clearing its data deletes it.

Tip: Yamtrack logins expire after 14 days by default; set
`SESSION_COOKIE_AGE=31536000` in the Yamtrack container environment for 1 year.

## Install

1. `edge://extensions` (or `chrome://extensions`) → enable **Developer mode** →
   **Load unpacked** → pick this folder.
2. The settings page opens: enter your Yamtrack URL (e.g. `http://192.168.1.50:8000`,
   include the sub-path if you use `BASE_URL`), **Save**, accept the permission prompt.
3. Log in to Yamtrack in the same browser, then **Test connection**.

## Limits

- Uses the Yamtrack web UI's internal endpoints, so a future Yamtrack release could
  change them; the badge will show an error if a save doesn't stick.
- Specials with non-integer numbers (e.g. "12.5") are skipped.
- Season mapping is whatever AnimeWorld's MAL link says (each season is its own MAL entry).
