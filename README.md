# google-picker-bridge

A tiny static page, hosted via GitHub Pages, that lets a browser extension use Google's Picker widget even when the browser's own extension-scheme origin (`moz-extension://...`) isn't one Google's Picker backend accepts.

## Why this exists

Google's Picker requires a real origin to run from. Testing this directly: Google's Picker backend accepts requests where the `origin` parameter is a `chrome-extension://...` string (undocumented, but real and working) — but rejects `moz-extension://...` outright with a genuine server-side 403, identical request otherwise. There's no client-side fix for that; it's Google's own backend deciding what it recognizes.

This page sidesteps the problem by giving Picker what it actually wants: a real `https://` origin. An extension embeds this page in an iframe, hands it a short-lived OAuth access token and a Picker API key over `postMessage`, and gets the picked file's ID back the same way.

This page loads Google's Picker the normal, fully-documented way (live from `apis.google.com`) — no vendoring, no interception. That's deliberate: Mozilla's `REMOTE_SCRIPT` add-on policy (which is why [`google-picker-offline-loader`](https://github.com/papacodebear/google-picker-offline-loader) exists) is about code shipped *inside* an extension bundle, not an external website the extension merely embeds via iframe.

## Protocol

`window.postMessage`, both directions:

- Extension → bridge: `{ type: 'keetar-picker-show', accessToken, developerKey }`
- Bridge → extension, on load: `{ type: 'keetar-picker-ready' }`
- Bridge → extension, on pick/cancel: `{ type: 'keetar-picker-result', fileId?, name? }`
- Bridge → extension, on failure: `{ type: 'keetar-picker-error', message }`

Incoming messages are only acted on if `event.origin` starts with `chrome-extension://` or `moz-extension://`. Replies are always sent via `event.source.postMessage(data, event.origin)` — both browser-verified, unspoofable properties of the received message — so results only ever go back to whichever window actually sent the request, regardless of its specific extension ID or browser.

## Trust model / what this page does *not* do

- No login, no session, no server-side logic, no database — pure static HTML/JS.
- Holds no long-term secrets. The access token it's handed is short-lived and never persisted.
- Doesn't authenticate the caller cryptographically — it doesn't need to, since it never stores anything and always replies to the verified sender, never a hardcoded or attacker-suppliable target.

## License

MIT
