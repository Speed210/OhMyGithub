# Desktop device-relay proof (before APK)

Use `scripts/mock-device-relay-client.mjs` as a stand-in phone on a Mac/Linux desktop.
It speaks the same WSS protocol as the Android client: `hello` → `ready`, then
`open` → real TCP to allowlisted hosts, binary frames `u32be stream_id || payload`.

## What you need

1. A **device token** (bound to your GitHub login, 10 min TTL).
2. A **runner** WebSocket paired to the same login (OpenCode / `device-proxy-relay.mjs`).
   Opens are always initiated by the runner; the device alone cannot open streams.

Allowlisted hosts (port 443 only): `opencode.ai`, `openrouter.ai`. `models.opencode.ai` uses WARP/DataImpulse/direct (egress mux), never the phone.

## 1. Sign in and get a device token

In a browser already signed in at `https://omgithub.com` (or your brand
`android-create.*` host — same-origin session cookie `omgithub_session`):

```js
// DevTools console on that origin:
const r = await fetch('/api/device-relay/token', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
console.log(await r.json())
// → { token, expires_in: 600, ws_url: "wss://…/api/device-relay/ws", protocol: 1 }
```

Or with curl (paste the cookie value; do not commit it):

```bash
curl -sS -X POST 'https://omgithub.com/api/device-relay/token' \
  -H 'content-type: application/json' \
  -H "origin: https://omgithub.com" \
  -H "cookie: omgithub_session=YOUR_COOKIE" \
  --data '{}'
```

Save the token to a file (never print it into chat/logs):

```bash
# assume JSON was saved as /tmp/device-token.json
jq -r .token /tmp/device-token.json > /tmp/device.token
chmod 600 /tmp/device.token
WS=$(jq -r .ws_url /tmp/device-token.json)
```

Guests are rejected. Refresh the token while the client stays open (re-POST before expiry).

## 2. Run the desktop "phone"

From an OhMyGithub checkout (Node 18+; no extra npm deps):

```bash
cd OhMyGithub
DEVICE_RELAY_TOKEN="$(cat /tmp/device.token)" \
DEVICE_RELAY_WS="${WS:-wss://omgithub.com/api/device-relay/ws}" \
  node scripts/mock-device-relay-client.mjs
```

Or:

```bash
node scripts/mock-device-relay-client.mjs \
  --token-file /tmp/device.token \
  --ws wss://omgithub.com/api/device-relay/ws
```

You should see:

```
[mock-phone] connected; hello sent
[mock-phone] ready user=<your-login>
```

Leave it running. `MOCK_ECHO=1` swaps real TCP for a local echo (unit tests only).

## 3. Pair a runner (needed for traffic)

### Option A — real OpenCode run (full OC proof)

Start a PlayGround issue run owned by the **same** GitHub login as the device token.
The runner scripts (`device-proxy.sh` / `device-proxy-relay.mjs`) probe
`GET …/device-relay`, and when `available:true` they CONNECT model hosts through your
desktop client. Model calls then egress from **your Mac's public IP**.

### Option B — local CONNECT harness (no GitHub Actions)

Needs a **run token** for the same login. Production run tokens are minted only with
GitHub Actions OIDC against an active PlayGround run. For a dry proof without Actions,
an operator who can mint with the live `SESSION_SECRET` can write a one-off
`{ token, ws_url, max_bytes, max_streams }` creds JSON (same shape the runner deletes
after read). Then:

```bash
# creds file is deleted after read — keep a backup if you need to retry
cp /tmp/run-creds.json /tmp/run-creds-live.json
node scripts/device-proxy-relay.mjs /tmp/run-creds-live.json /tmp/relay.port /tmp/relay.bytes.json
PORT=$(cat /tmp/relay.port)

# Any HTTPS client through the local CONNECT proxy:
curl -x "http://127.0.0.1:${PORT}" -sS -o /dev/null -w "%{http_code}\n" https://opencode.ai/
```

On success the mock phone logs `opened #N -> opencode.ai:443 (local <ip>:<port>)`
and `/tmp/relay.bytes.json` shows non-zero `tunnels` / host byte counts.

## 4. Verify

| Check | Expect |
|-------|--------|
| Phone log | `ready user=…` then `opened #1 -> opencode.ai:443` |
| `curl -x … https://opencode.ai/` | HTTP 200 |
| bytes JSON | `tunnels >= 1`, `hosts["opencode.ai"] > 0` |
| a2 log | `[device-relay] device_ready` / `opened` / `stream_close` (no tokens) |

There is also an omsite copy at `omsite/scripts/mock-device-relay-client.mjs` (imports
`ws` + `server/lib/device-relay.mjs`). Prefer this OhMyGithub standalone on a Mac.

## Notes

- One device WS and one runner WS per login.
- Device token rate: 30/hour/user. TTL 10 min.
- Per-run byte cap: 150 MB. Max 8 streams.
- Copilot/Fusion stay on `NO_PROXY` (never through the device).
