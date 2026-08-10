# google-picker-bridge

A single static HTML page that gives Google's Picker widget an `https://`
origin to run from — for browser extensions whose own origin scheme Google's
Picker backend won't accept.

## Why this exists

Google's Picker only runs from an origin it recognizes. Tested directly
against Google's backend: it accepts requests where the `origin` parameter is
a `chrome-extension://...` string (undocumented, but it works) — and rejects
`moz-extension://...` outright, with a server-side 403. Same request, only
the origin differs. There's no client-side fix for that — it's Google's
backend, and Firefox extensions just aren't on the list.

This page sidesteps the problem by giving Picker what it already accepts: an
`https://` origin, hosted wherever you like.

It loads Google's Picker the normal, fully-documented way (live from
`apis.google.com`) — no vendoring, no interception. That's deliberate:
Mozilla's `REMOTE_SCRIPT` add-on policy (the reason
[`google-picker-offline-loader`](https://github.com/papacodebear/google-picker-offline-loader)
exists) is about code shipped *inside* an extension bundle, not an external
page the extension merely opens.

## How it's opened, and why

This page is meant to be opened as a **popup** (`window.open()`), not
embedded as an `<iframe>`. An iframe was tried first and doesn't work:
Picker's own client-side check compares the origin it's told against
`window.location.ancestorOrigins` — a browser-computed, unspoofable property
of the frame-nesting chain — which, nested under the extension's own page,
always reports the extension's own origin no matter what this page claims. A
popup has no ancestors at all, so that check never applies.

## Protocol

Not `window.postMessage` — tried first, and broken on Firefox in both
directions (a popup opened from a privileged extension page has no
`window.opener` there, and retrying via repeated `window.open()` calls gets
silently popup-blocked once it's not tied to a fresh user gesture). Instead,
data flows through URLs:

**In** — the caller opens this page with a URL hash fragment (never sent to
any server; hash fragments are client-side only) containing JSON:

```
https://your-bridge.example/#<encodeURIComponent(JSON.stringify({
  accessToken: "...",   // short-lived OAuth access token, drive.file scope
  developerKey: "...",  // your Google Picker API key
  appId: "...",         // optional: your Google Cloud project number
  callbackUrl: "..."    // a URL this page will navigate to when done
}))>
```

`appId` matters for `drive.file` scope specifically: picking a file the
caller didn't itself create only actually *grants* the caller access to it
when the picker that showed it also had `setAppId()` set to the Google Cloud
project number (the numeric prefix on an OAuth client ID, before its first
hyphen, doubles as this by Google's own convention). Omit it and Picker still
returns a real `fileId`/`name` — it just never registers the grant, so the
caller's very next Drive API call for that file comes back a 404 that's
easy to mistake for "file doesn't exist."

**Out** — once Picker finishes (pick, cancel, or error), this page navigates
itself to `callbackUrl` with the result in its own hash fragment:

```js
callbackUrl + '#' + encodeURIComponent(JSON.stringify({ fileId, name }))
// or on cancel:   { fileId: undefined }
// or on error:    { error: "..." }
```

`callbackUrl` is expected to be a page *inside your own extension* (declared
in `web_accessible_resources` so this page is allowed to navigate to it) that
reads its own hash fragment and relays the result into the rest of the
extension — e.g. via `chrome.runtime.sendMessage`, which works identically on
Chrome and Firefox and isn't subject to any of the cross-origin messaging
problems above, since it never leaves the extension's own privileged context.

## Using this

The entire implementation is the one `index.html` file — there's no build
step, server-side logic, or configuration behind it. Pick whichever of these
fits:

- **Use the hosted default.**
  [`google-picker-bridge.papacodebear.workers.dev`](https://google-picker-bridge.papacodebear.workers.dev/)
  runs this exact file, kept in sync with this repo. Point your extension at
  it and skip hosting entirely.
- **Fork this repo and deploy your own copy.** Push `index.html` as-is to
  any static host — Cloudflare Pages, GitHub Pages, Netlify, an S3 bucket
  with static hosting enabled, wherever. No npm needed for this route.
- **Install it as an npm dependency:**

  ```
  npm install google-picker-bridge
  ```

  then copy `node_modules/google-picker-bridge/index.html` into your own
  build output. This mainly helps if your deploy pipeline already pulls
  assets out of `node_modules` (Keetar's own webpack config does this for
  [`google-picker-offline-loader`](https://github.com/papacodebear/google-picker-offline-loader)).

Whichever you pick, point your extension's Picker-launching code at that
deployment's URL.

## Trust model / what this page does *not* do

- No login, no session, no server-side logic, no database — pure static
  HTML/JS, safe to host on infrastructure with zero backend of its own.
- Holds no long-term secrets. The access token it's handed is short-lived,
  lives only in the URL hash fragment and in memory, and is never persisted
  or sent to any server (yours or Google's) other than Google's own Picker
  API, which is what it's for.
- Doesn't authenticate the caller cryptographically — it doesn't need to,
  since it never stores anything and only ever hands its result to whatever
  `callbackUrl` it was given at open time.

## License

MIT
