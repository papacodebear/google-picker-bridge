# google-picker-bridge

A small static site that gives Google's Picker widget an `https://` origin to
run from — for browser extensions whose own origin scheme Google's Picker
backend won't accept — and runs its own OAuth handshake so Picker's session
state stays scoped to that same origin throughout.

## Why this exists

Google's Picker only runs from an origin it recognizes. Tested directly
against Google's backend: it accepts requests where the `origin` parameter is
a `chrome-extension://...` string (undocumented, but it works) — and rejects
`moz-extension://...` outright, with a server-side 403. Same request, only
the origin differs. There's no client-side fix for that — it's Google's
backend, and Firefox extensions just aren't on the list.

This site sidesteps the problem by giving Picker what it already accepts: an
`https://` origin, hosted wherever you like.

It loads Google's Picker the normal, fully-documented way (live from
`apis.google.com`) — no vendoring, no interception. That's deliberate:
Mozilla's `REMOTE_SCRIPT` add-on policy (the reason
[`google-picker-offline-loader`](https://github.com/papacodebear/google-picker-offline-loader)
exists) is about code shipped *inside* an extension bundle, not an external
page the extension merely opens.

## How it's opened, and why

`public/index.html` is meant to be opened as a **popup** (`window.open()`), not
embedded as an `<iframe>`. An iframe was tried first and doesn't work:
Picker's own client-side check compares the origin it's told against
`window.location.ancestorOrigins` — a browser-computed, unspoofable property
of the frame-nesting chain — which, nested under the extension's own page,
always reports the extension's own origin no matter what this page claims. A
popup has no ancestors at all, so that check never applies.

## Why this site runs its own OAuth handshake

Earlier versions of this site received an already-obtained OAuth access token
directly from the caller. That broke in two different ways once the API key
this site uses had an HTTP referrer restriction configured on it (worth doing
— see the trust-model section of `google-picker-offline-loader`'s docs on API
key hygiene): Google's key validation, and Picker's own `drive.file`
grant-registration at pick time, both apparently depend on a Google session
cookie — one that only exists scoped to wherever the token's *original*
consent redirect happened. For a caller whose own OAuth flow runs in a
different top-level browsing context (a browser extension's
`launchWebAuthFlow`, say), that's a different origin than this site — and
Firefox's cross-site cookie isolation (on by default, not just under Strict
tracking protection) keeps that cookie from ever being visible here,
regardless of the user's ambient Google login state. Confirmed via a
controlled test in a brand-new browser profile with no prior Google login at
all — toggling *only* Firefox's cross-site cookie isolation flipped the
failure on and off, everything else held constant.

So this site now runs its own separate implicit-grant OAuth redirect,
entirely within its own origin, before it ever loads Picker — see Protocol
below. Whatever session cookie Google's validation wants ends up scoped to
the one place that actually needs it.

## Protocol

Not `window.postMessage` between the caller and this site — tried first, and
broken on Firefox in both directions (a popup opened from a privileged
extension page has no `window.opener` there, and retrying via repeated
`window.open()` calls gets silently popup-blocked once it's not tied to a
fresh user gesture). Instead, data flows through URLs and `sessionStorage`:

**In** — the caller opens `public/index.html` with a URL hash fragment (never sent
to any server; hash fragments are client-side only) containing JSON:

```
https://your-bridge.example/#<encodeURIComponent(JSON.stringify({
  developerKey: "...",  // your Google Picker API key
  appId: "...",         // optional: your Google Cloud project number
  clientId: "...",      // your OAuth 2.0 client ID
  scope: "...",         // OAuth scope to request, e.g. drive.file
  callbackUrl: "..."    // a URL this site will navigate to when done
}))>
```

`index.html` (the entry page) stashes this in `sessionStorage`, then checks
for a still-valid cached access token there. If none exists, it redirects
(top-level, same window) to Google's OAuth consent screen with `redirect_uri`
set to this site's own `auth-return.html`. That page verifies the returned
`state`,
caches the resulting token in `sessionStorage`, and redirects back to `/` —
which now finds a valid cached token and proceeds straight to Picker. A
second pick within the same popup session reuses the cached token instead of
repeating the redirect round trip.

`appId` matters for `drive.file` scope specifically: picking a file the
caller didn't itself create only actually *grants* the caller access to it
when the picker that showed it also had `setAppId()` set to the Google Cloud
project number (the numeric prefix on an OAuth client ID, before its first
hyphen, doubles as this by Google's own convention). Omit it and Picker still
returns a real `fileId`/`name` — it just never registers the grant, so the
caller's very next Drive API call for that file comes back a 404 that's
easy to mistake for "file doesn't exist."

**Out** — once Picker finishes (pick, cancel, or error), this site navigates
itself to `callbackUrl` with the result in its own hash fragment:

```js
callbackUrl + '#' + encodeURIComponent(JSON.stringify({ fileId, name }))
// or on cancel:   { fileId: undefined }
// or on error:    { error: "..." }
```

`callbackUrl` is expected to be a page *inside your own extension* (declared
in `web_accessible_resources` so this site is allowed to navigate to it) that
reads its own hash fragment and relays the result into the rest of the
extension — e.g. via `chrome.runtime.sendMessage`, which works identically on
Chrome and Firefox and isn't subject to any of the cross-origin messaging
problems above, since it never leaves the extension's own privileged context.

## Using this

The static files live in `public/` — `index.html` and `auth-return.html` —
deliberately kept separate from `package.json`/`node_modules` at the repo
root, so a plain static deploy never accidentally sweeps up installed
packages as if they were site content. Self-hosting requires one extra
one-time step beyond copying the files: **register
`https://your-bridge.example/auth-return.html` as an authorized redirect URI
on your own OAuth 2.0 client in Google Cloud Console**, alongside whatever
redirect URIs your extension's own OAuth flow already uses. Without that,
Google will reject this site's own auth redirect with `redirect_uri_mismatch`.

- **Use the hosted default.**
  [`google-picker-bridge.papacodebear.workers.dev`](https://google-picker-bridge.papacodebear.workers.dev/)
  runs this exact code, kept in sync with this repo. It doesn't hardcode any
  particular OAuth client — `clientId`, `scope`, and `developerKey` all come
  from the payload each caller supplies — so it works for your own extension
  too, as long as you register
  `https://google-picker-bridge.papacodebear.workers.dev/auth-return.html` as
  an authorized redirect URI on *your own* OAuth client in Cloud Console.
  You still need your own OAuth client and API key either way (this site
  can't provide those); the choice below is only about whether you also
  host the static files yourself.
- **Fork this repo and deploy your own copy.** This repo already includes a
  `wrangler.jsonc` (assets pointed at `public/`) for deploying to Cloudflare
  Workers as-is via `npm install && npm run deploy`. Any other static host —
  Cloudflare Pages, GitHub Pages, Netlify, an S3 bucket with static hosting
  enabled — works too; just publish the contents of `public/`, not the repo
  root, so `node_modules` never ends up served as a "static asset."
- **Install it as an npm dependency:**

  ```
  npm install google-picker-bridge
  ```

  then copy `node_modules/google-picker-bridge/public/{index.html,auth-return.html}`
  into your own build output. This mainly helps if your deploy pipeline
  already pulls assets out of `node_modules` (Keetar's own webpack config
  does this for
  [`google-picker-offline-loader`](https://github.com/papacodebear/google-picker-offline-loader)).

Whichever you pick, point your extension's Picker-launching code at that
deployment's URL, and register its `auth-return.html` as an authorized
redirect URI on your OAuth client.

## Trust model / what this site does *not* do

- No server-side logic, no database — pure static HTML/JS, safe to host on
  infrastructure with zero backend of its own.
- Holds no long-term secrets. The access token it obtains is short-lived,
  cached only in `sessionStorage` (scoped to this site's own origin and to
  the popup's tab — gone the moment that tab closes), and never sent to any
  server other than Google's own APIs, which is what it's for.
- Doesn't authenticate the caller cryptographically — it doesn't need to,
  since it never stores anything long-term and only ever hands its result to
  whatever `callbackUrl` it was given at open time.

## License

MIT
