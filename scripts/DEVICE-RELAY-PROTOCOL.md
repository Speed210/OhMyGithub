# Device Relay Protocol v1 (omsite ↔ Android)

Blind HTTPS CONNECT through the owner's phone. Phone never sees keys or prompts.
When the phone WebSocket drops, the run falls back to normal egress (WARP / DataImpulse / runner).

## Roles
- **phone**: Android app, WebSocket client, while on-screen only (no foreground service).
- **runner**: GitHub Actions job, opens a second WebSocket; local `127.0.0.1` CONNECT relay feeds OpenCode.
- **a2 (omsite)**: authenticates both sides, pairs by GitHub login, bridges streams, enforces allowlist.

## Endpoints (same-origin per brand host)
| Method | Path | Who | Auth |
|--------|------|-----|------|
| `POST` | `/api/device-relay/token` | phone | session cookie `omgithub_session` (SameSite=Lax) |
| `GET`  | `/api/device-relay/status` | phone | session cookie |
| `POST` | `/api/device-relay/revoke` | phone | session cookie |
| `POST` | `/api/github/:owner/:repo/issues/:n/device-relay` | runner | GitHub Actions OIDC Bearer (same as `/ci-proxy`) |
| `GET`  | `/api/github/:owner/:repo/issues/:n/device-relay` | runner | OIDC; fast probe `{available:bool}` |
| `WSS`  | `/api/device-relay/ws` | phone + runner | `Authorization: Bearer <token>` (not cookie) |

Hosts: `omgithub.com`, `android-create.<family>` (incl. `lolgames.net`). No shared sign-in across families.

## Tokens
**Device token** (`POST /token`):
```json
{ "token": "<opaque>", "expires_in": 600, "ws_url": "wss://<host>/api/device-relay/ws", "protocol": 1 }
```
- Bound to `user.id` + `user.login` (lowercased). TTL 10 min; refresh while app open (re-POST).
- Guests rejected (401). Any signed-in user allowed.
- Opaque HMAC like `omg1.` callback tokens (reuse `sessionSecret`); not a JWT with secrets inside.

**Run token** (`POST .../device-relay`):
```json
{ "token": "<opaque>", "expires_in": 3600, "ws_url": "wss://<host>/api/device-relay/ws",
  "available": true, "protocol": 1, "max_streams": 8, "max_bytes": 157286400 }
```
- Same OIDC checks as `ci-proxy.mjs`: PlayGround only, active `issueRuns` record, trusted workflow.
- Bound to `owner/repo#number` + `run` + `attempt` + owner login (`owner` path = GitHub login).
- `available:false` (200) when no phone online for that login → runner skips without error.
- 409 if run not active; 403 if issue owner ≠ phone owner mapping.

## WebSocket framing
First message after connect MUST be text JSON `hello`. Then mixed text (control) + binary (payload).

### Binary data frame
```
offset 0  u32be stream_id
offset 4  payload bytes (TLS ciphertext; never logged)
```
Max frame payload: 64 KiB. Larger writes are split across frames.

### Control messages (text JSON)
```json
{"v":1,"type":"hello","role":"device"|"runner","token":"<same bearer>"}
{"v":1,"type":"ready","user":"<login>","max_streams":8}
{"v":1,"type":"open","id":1,"host":"opencode.ai","port":443}
{"v":1,"type":"opened","id":1}
{"v":1,"type":"open_error","id":1,"code":"forbidden"|"refused"|"timeout"|"offline","message":"..."}
{"v":1,"type":"close","id":1,"reason":"eof"|"error"|"revoke"|"cap"}
{"v":1,"type":"device_offline","code":"eof"|"revoke"}
{"v":1,"type":"ping","t":<unix_ms>}
{"v":1,"type":"pong","t":<unix_ms>}
{"v":1,"type":"window","id":1,"credit":32}
{"v":1,"type":"error","code":"unauthorized"|"version"|"busy","message":"..."}
```

### Stream lifecycle (runner → a2 → phone)
1. Runner local relay gets OpenCode `CONNECT host:443`.
2. Runner sends `open {id,host,port}`; a2 validates allowlist; forwards to phone.
3. Phone TCP-connects `host:443` (OS stack = phone public IP); replies `opened` or `open_error`.
4. a2 tells runner `opened` → local relay answers `HTTP/1.1 200 Connection Established`.
5. Bidirectional binary frames until `close` or WS drop.
6. On phone WS drop: a2 sends `device_offline` to the runner, `open_error/offline` for pending opens, and `close` for live streams. The runner records `last_error=offline`, fails every tunnel, and the watcher calls `drop-proxy.sh` within ~2 s — even when no request is in flight.

### Heartbeat
- Either side sends `ping` every 15s; expect `pong` within 10s.
- Missed pong → close WS. Phone reconnects with a fresh/refreshed token.
- a2 idle-kills a device WS after 45s without ping/pong or traffic.

### Flow control
- Per-stream credit window: start 32 frames; each `window` adds credit; sender stops at 0.
- Max concurrent streams per pair: **8** (`max_streams`).
- Global per-user: 1 device WS, 1 runner WS per active run.

### Versioning
- `hello.v` / `protocol` field. Unknown major → `error code=version` and close.
- Additive fields OK; removing/renaming needs v2.

## Host allowlist (port 443 only)
Enforced on **a2** (before `open` reaches phone) and **phone** (defense in depth). Reject anything else.

Exact hosts (no wildcards in v1):
```
opencode.ai
openrouter.ai
```
`models.opencode.ai` is **not** on the phone — runner egress mux sends it to WARP / DataImpulse / direct (same as pre-device).

Deny: `models.opencode.ai` (on the device path), `github.com`, `*.github.com`, `githubcopilot.com`, `githubusercontent.com`, private/literal IPs, non-443.

## Runner integration
1. Probe `GET .../device-relay` (OIDC). If `available`, fetch run token via `POST`.
2. Start local relay (sibling of `proxy-relay.mjs`) listening `127.0.0.1`; upstream = device WSS.
3. Creds file pattern: write once, delete after read; never put token in OpenCode env.
4. `start-opencode-serve.sh` gets `http://127.0.0.1:PORT` only (the egress mux when the phone is up); keep existing `NO_PROXY` for GitHub/Copilot.
5. Priority when device presence on: **mux(device for allowlist, WARP/DataImpulse/direct for `models.opencode.ai`) → else WARP → DataImpulse → bare**.
6. Mid-run phone loss: relay `onFailure` → `drop-proxy.sh` (reuse `opencode-proxy.fallback`).
7. Byte cap: 150 MB default (same as `PROXY_RELAY_MAX_BYTES`); totals + per-host counts; no payloads logged.

## Limits & abuse
- Device token rate: 30/hour/user. Run token: 1 active per issue run.
- Cap 150 MB/run; concurrent streams 8; connect timeout 15s; idle stream 120s.
- Logs: stream id, host, bytes, durations, error codes — **never** Authorization, cookies, TLS bytes, prompts.
- `POST /revoke` (or Settings clear): drop device WS, invalidate outstanding device tokens, in-flight streams `close reason=revoke`.
- Pairing: phone `user.login` must equal issue `owner` (PlayGround under that login). View-as admin sessions are allowed (Igor, 2026-11-05).

## Android client checklist
- Debug setting on → obtain token → open WSS while Activity resumed; close on `onPause`/`onStop`.
- No new permissions; no foreground service; no key/prompt access (blind TCP only).
- WebView session cookie already set via Custom Tab redeem; `POST /token` is same-origin XHR/fetch with credentials.
- Implement allowlist identically; reject `open` locally if mismatch.
- Reconnect with backoff (1s, 2s, 5s, max 15s) while setting on and Activity resumed.

## Mock phone (for omsite / desktop proof)
- **omsite** `scripts/mock-device-relay-client.mjs`: needs `ws` + `server/lib/device-relay.mjs`; used by unit tests.
- **OhMyGithub** `scripts/mock-device-relay-client.mjs` (preferred on a Mac): Node built-ins only; same protocol. Docs: `scripts/DEVICE-RELAY-DESKTOP.md`.
Both connect with a device token, accept `open` only for allowlisted hosts, and pipe to real TCP (or a loopback echo under `MOCK_ECHO=1`). Point at live `wss://omgithub.com/api/device-relay/ws` (or brand host). Opens still require a paired runner.

## Decisions (Igor, 2026-11-05)
1. Priority: phone first, then WARP (device → WARP → DataImpulse → bare).
2. Allowlist was three hosts; **2026-11-05 (scope change):** `models.opencode.ai` removed — only `opencode.ai` + `openrouter.ai` use the phone; models stay on WARP/DataImpulse/runner via egress mux.
3. Copilot/Fusion never through the phone (NO_PROXY).
4. Live WS presence is enough; no server-side "enabled" flag.
5. Admins viewing as another user are not blocked.
6. Per-run cap stays 150 MB.
Status: implemented (omsite + OhMyGithub runner); Android client separate (may still list models in its local allowlist until APK update — runner never opens that host).
