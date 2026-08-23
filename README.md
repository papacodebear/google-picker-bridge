# google-picker-bridge

A small static site that gives Google's Picker widget an `https://` origin to
run from — for browser extensions whose own origin scheme Google's Picker
backend won't accept — and runs its own OAuth handshake so Picker's session
state stays scoped to that same origin throughout.

## Why this exists

Google's Picker only runs from an origin it recognizes: `chrome-extension://...`
works (undocumented), `moz-extension://...` gets a server-side 403. No
client-side fix — Firefox extensions just aren't on Google's list. This site
sidesteps that by giving Picker an `https://` origin instead, hosted wherever
you like. It loads Picker the normal, documented way (live from
`apis.google.com`) — no vendoring, unlike
[`google-picker-offline-loader`](https://github.com/papacodebear/google-picker-offline-loader),
which exists for the different problem of code shipped *inside* an extension
bundle under Mozilla's `REMOTE_SCRIPT` policy.

## How it's opened, and why

`public/index.html` is meant to be opened as a **popup** (`window.open()`),
not embedded as an `<iframe>`. An iframe doesn't work: Picker checks
`window.location.ancestorOrigins`, a browser-computed property that, nested
under the extension's own page, always reports the extension's origin no
matter what this page claims. A popup has no ancestors, so that check never
applies.

## Why this site runs its own OAuth handshake

Earlier versions received an already-obtained access token from the caller.
That broke because Google's key validation and Picker's `drive.file`
grant-registration both depend on a Google session cookie scoped to wherever
the token's *original* consent redirect happened — a different origin than
this site when the caller's OAuth flow runs in its own top-level context
(e.g. a browser extension's `launchWebAuthFlow`). Firefox's cross-site cookie
isolation (on by default) then hides that cookie here regardless of the
user's Google login state. Confirmed by toggling *only* that setting in a
fresh profile and watching the failure flip on and off.

So this site now runs its own separate OAuth redirect, entirely within its
own origin, before it ever loads Picker — see Protocol below.

This also means the bridge's OAuth client is registered as a **Web
application** client in Cloud Console (it needs its own `https://` redirect
URI, unlike a Chrome Extension client) — the type Google actually issues a
client secret for. The bridge runs the authorization-code flow instead of
the implicit grant, exchanging `code` for a token server-side via
`POST /api/exchange-token`, authenticated with that secret.

## Protocol

Not `window.postMessage` — tried first, broken on Firefox in both directions
(a popup from a privileged extension page has no `window.opener`, and
retrying via repeated `window.open()` gets popup-blocked once it's not tied
to a fresh user gesture). Instead, data flows through URLs and `sessionStorage`:

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
(top-level, same window) to Google's OAuth consent screen (`response_type=code`)
with `redirect_uri` set to this site's own `auth-return.html`. That page
verifies the returned `state`, then `POST`s the authorization `code` to this
site's own `/api/exchange-token` — a Cloudflare Worker route, not a static
file — which exchanges it for an access token using `client_id` (from the
stashed payload) and this deployment's `GOOGLE_CLIENT_SECRET` (see
Configuration below). The access token comes back to `auth-return.html`,
gets cached in `sessionStorage`, and the page redirects to `/` — which now
finds a valid cached token and proceeds straight to Picker. A second pick
within the same popup session reuses the cached token instead of repeating
the redirect round trip. The client secret itself never reaches the
browser.

`appId` matters for `drive.file` scope: picking a file the caller didn't
itself create only *grants* access when the picker also had `setAppId()` set
to the Cloud project number (the numeric prefix on an OAuth client ID).
Omit it and Picker still returns a real `fileId`, but the caller's next
Drive API call for it 404s.

**Out** — once Picker finishes (pick, cancel, or error), this site navigates
itself to `callbackUrl` with the result in its own hash fragment:

```js
callbackUrl + '#' + encodeURIComponent(JSON.stringify({ fileId, name }))
// or on cancel:   { fileId: undefined }
// or on error:    { error: "..." }
```

`callbackUrl` is expected to be a page *inside your own extension* (declared
in `web_accessible_resources`) that reads its own hash fragment and relays
the result via `chrome.runtime.sendMessage`, which works identically on
Chrome and Firefox since it never leaves the extension's privileged context.

## Configuration

The token exchange needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`,
available to `src/worker.js` as `env.*` — neither committed, neither sent to
the browser. Set both as Worker secrets, either via `npx wrangler secret put
<NAME>` or the Cloudflare dashboard (same underlying store; `wrangler deploy`
doesn't touch either). `/api/exchange-token` rejects any `clientId` other
than the configured one instead of forwarding it to Google.

For local dev (`wrangler dev`), copy `.dev.vars.example` to `.dev.vars` and
fill in values there — `.dev.vars` is gitignored.

## Using this

The static files live in `public/` — `index.html` and `auth-return.html` —
kept separate from `package.json`/`node_modules` so a plain static deploy
never sweeps those up as site content. The token exchange lives in
`src/worker.js`, wired up via `wrangler.jsonc`'s `main` field alongside the
`public/` assets — Cloudflare serves matching static files directly and
only invokes the Worker for `/api/exchange-token`.

Since `GOOGLE_CLIENT_SECRET` pins this deployment to one OAuth client, using
your own client means forking and deploying your own copy — not pointing at
the hosted default. Self-hosting needs: **register
`https://your-bridge.example/auth-return.html` as an authorized redirect URI
on your own Web application client in Google Cloud Console**, and **set
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`** (see Configuration above). Deploy
as-is via `npm install && npm run deploy`. A different host is possible but
means reimplementing `/api/exchange-token` yourself, since this is no longer
a purely static site — `npm install google-picker-bridge` and copying
`public/` + `src/worker.js` into your own build output covers that case.

Whichever you pick, point your extension's Picker-launching code at that
deployment's URL, and register its `auth-return.html` as an authorized
redirect URI on your OAuth client.

## Trust model / what this site does *not* do

- Minimal server-side logic, no database. `src/worker.js`'s
  `/api/exchange-token` route is a stateless proxy to Google's own token
  endpoint, holding no data of its own.
- Holds two long-term secrets — `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET`, stored as Cloudflare Worker secrets, never sent to
  the browser — used only to authenticate the token exchange with Google.
  The access token it gets back is short-lived, cached only in
  `sessionStorage` on the client (gone once the popup's tab closes).
- Doesn't authenticate the caller cryptographically — it doesn't need to,
  since it only ever hands its result to whatever `callbackUrl` it was given
  at open time. The client secret authenticates the bridge to Google, not
  the caller to the bridge.

## License

MIT
