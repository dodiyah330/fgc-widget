# FGC Desktop Widget – WebSocket Before & After Testing Report

**Project:** FGC Incivility Desktop Widget (Electron)  
**Prepared by:** Crest Coder Development Team  
**Date:** 24 July 2026  
**Endpoint tested:** `ws://incivisme.fgc.cat:8080`  
**Build delivered:** `fgc-widget.app` / `fgc-widget_arm64.dmg` (macOS arm64)

---

## 1. Executive summary

The widget was experiencing intermittent WebSocket disconnects (reported ~every 2 minutes), delayed or missed alerts, and an inconsistent unread counter.

**Root cause (client side):** The original widget had no keepalive/heartbeat, weak reconnection, no recovery after sleep/network change, incomplete disconnect logging, and no post-reconnect state sync. Quiet connections are vulnerable to proxy/load-balancer idle timeouts; any alert broadcast during a disconnect gap was lost until the next push, leaving the counter wrong.

**What we delivered:** A hardened WebSocket client with 25-second keepalive pings, exponential-backoff reconnect, sleep/resume and network recovery, structured close-event logging, and sync-on-connect. A production macOS build was produced and validated with connection soak probes against the production WebSocket endpoint.

**Result of lab soak tests (after fix):** Continuous connection for 3+ minutes with heartbeat; **0 spontaneous disconnects** during the probe window. Longer on-site soak (2–4 hours) with CMS “test” alerts is recommended to confirm behaviour on the client’s network and workstations.

---

## 2. Reported issues (before)

| # | Issue (client report) | Frequency / impact |
|---|------------------------|--------------------|
| 1 | Widget disconnects | ~every 2 minutes |
| 2 | Delayed notifications | Alerts not always immediate |
| 3 | Lost notifications | Incidents during disconnect window may never appear |
| 4 | Incorrect unread counter | Count drifts after disconnects |
| 5 | Prior fixes unsuccessful | Problem present since original development; worse in production |

---

## 3. Before – technical baseline

### 3.1 Behaviour

| Area | Before |
|------|--------|
| Keepalive / heartbeat | **None** – no ping/pong; socket idle when no alerts |
| Reconnect | Fixed **5 second** single retry in UI layer |
| Sleep / wake / network | **Not handled** – no Electron power/network recovery |
| Close diagnostics | Log line only; **no** close code, reason, or session duration |
| Error handling | Broken `onerror` path (`this.ws` / `close()` treated as Promise) |
| Counter after reconnect | **No sync request**; relied only on next live broadcast |
| Architecture risk | Idle proxy/LB timeout (~60–120s typical) can force periodic drops |

### 3.2 Why this caused the symptoms

```
Connect → idle (no traffic) → intermediary/server closes socket (~2 min typical)
         → 5s reconnect → alerts sent during the gap are missed
         → unread counter stays stale until another broadcast arrives
```

Production was reported worse than development (common when PROD has a different proxy/LB idle timeout).

### 3.3 Before – expected / observed operational behaviour

| Check | Before |
|-------|--------|
| Stable long-lived connection while idle | Unreliable (client-reported ~2 min drops) |
| Automatic recovery after brief network blip | Slow / single fixed delay only |
| Recovery after PC sleep | Unreliable |
| Alert during short disconnect | Often lost |
| Unread count vs CMS “Alertes pendents” | Can diverge after reconnect |
| Diagnostic logs for disconnect RCA | Insufficient |

---

## 4. After – changes implemented

| Area | After |
|------|--------|
| Keepalive | Application **`ping` every 25 seconds** (keeps proxies awake) |
| Reconnect | **Exponential backoff** (2s → max 30s), owned by WebSocket store |
| Sleep / wake | Electron `powerMonitor` resume / unlock → forced reconnect |
| Network | Browser `online` event → forced reconnect |
| Close diagnostics | Logs **code, reason, wasClean, durationMs** (`[WS]` prefix → electron-log) |
| Error handling | Corrected; wait for `onclose` for cleanup |
| Counter recovery | **`sync` request on every successful connect**; server already pushes `{ alerts, notify }` on connect (verified) |
| Logging volume | Routine ping noise reduced; disconnects and alert payloads retained |

### Protocol additions (widget → server)

- `{ "type": "ping", "ts": <ms> }` — every ~25s  
- `{ "type": "sync" }` — after each connect  
- `{ "type": "pong", "ts": <ms> }` — if the server sends ping  

Existing messages (`stop_alerts`, alert payloads) are unchanged.

---

## 5. After – testing results

### 5.1 Lab probes against production WebSocket

| Test | Method | Duration | Result |
|------|--------|----------|--------|
| Soak **with** heartbeat | `scripts/ws-soak-probe.mjs` | 3 minutes | **1 open, 0 spontaneous closes**; session ~178s until intentional stop |
| Idle control **without** heartbeat | `scripts/ws-idle-probe.mjs` | 3 minutes | Stayed open ~180s on this developer network path |

**Server behaviour observed during tests:**

- On connect: pushes `{ "alerts": <n>, "notify": <bool> }` (authoritative snapshot — used for counter recovery).  
- Echoes `{ "type": "ping" }` and `{ "type": "sync" }` (does not yet return a dedicated `pong` or sync body with alerts).  
- Occasional `{ "type": "stop_alerts" }` from other channel activity.

**Note:** Exact ~2-minute idle kill was **not** reproduced from the lab network in a 3-minute window (network/proxy path dependent). Client hardening remains the correct mitigation for idle timeouts and for recovery when disconnects do occur. Longer soak on FGC workstations is the final production confirmation.

### 5.2 Build & quality

| Check | Result |
|-------|--------|
| ESLint | Pass |
| Production Electron build (macOS arm64) | **Success** |
| Artifacts | `dist/electron/Packaged/mac-arm64/fgc-widget.app`, `fgc-widget_arm64.dmg`, `fgc-widget_arm64.pkg` |

### 5.3 Before vs after – comparison matrix

| Criterion | Before | After |
|-----------|--------|-------|
| Application heartbeat | No | Yes (25s) |
| Reconnect strategy | Fixed 5s | Exponential backoff |
| Sleep / network recovery | No | Yes |
| Disconnect logging (code/reason/duration) | No | Yes |
| Sync / snapshot after reconnect | No | Yes (connect push + sync request) |
| Lab soak (3 min, with heartbeat) | N/A (legacy unstable by report) | **Stable – no spontaneous close** |
| Lost alerts during brief gap | Likely | Mitigated by fast reconnect + connect snapshot |
| Unread counter after reconnect | Often wrong | Restored from server connect payload |

---

## 6. Success criteria status

| Success criterion | Status |
|-------------------|--------|
| Stable WebSocket connection | **Improved** – keepalive + lab soak OK; confirm with on-site long soak |
| Reliable automatic reconnection | **Implemented** |
| Notifications without undue delay | **Improved** – fewer/shorter disconnect windows |
| No lost notifications | **Mitigated** – reconnect + connect-time count; gaps still possible if server does not queue offline messages |
| Accurate unread counter | **Improved** – restored on each connect from server snapshot |
| No recurring ~2 min disconnects in extended testing | **Lab 3 min OK**; **client-site 2–4 hour soak still recommended** |
| Stable in production environment | **Build ready**; deploy and validate on FGC machines |

---

## 7. Recommended on-site validation (FGC)

Please run the new build on a machine that previously showed disconnects:

1. Keep the widget running **2–4 hours**.  
2. Confirm the UI does **not** repeatedly show “DESCONECTAT” every ~2 minutes.  
3. From the mobile app, send alerts with description **`test`**.  
4. Confirm widget count matches CMS **Alertes pendents**.  
5. Sleep/wake the PC; confirm reconnection and correct count.  
6. Delete only alerts whose description contains **`test`**.

Logs: electron-log path is printed at app startup (`Ruta de logs:`). Look for `[WS] connection closed` entries (code / reason / durationMs).

---

## 8. Remaining recommendations (server / infrastructure)

To complete permanent end-to-end hardening (Symfony/WebSocket source was not in the Widget package):

1. Respond to `{ "type": "ping" }` with `{ "type": "pong" }`.  
2. On `{ "type": "sync" }` (or every connect), always return `{ "alerts", "notify" }` with the current pending count.  
3. Review proxy/LB idle timeouts for port `8080` (recommend idle timeout **well above** 25s; e.g. 60–300s).  
4. Prefer **`wss://`** for production if TLS is available.

A separate checklist of items still useful from the client team is available on request (`CLIENT_DELIVERABLES.txt`).

---

## 9. Deliverables package

| Item | Description |
|------|-------------|
| Stabilized widget source | Heartbeat, reconnect, sleep/network recovery, sync, logging |
| Production macOS build | `.app` / `.dmg` / `.pkg` under `dist/electron/Packaged/` |
| This report | Before / after testing summary for stakeholders |
| Backend recommendations | Server & proxy alignment notes |

---

## 10. Conclusion

**Before:** The widget relied on a fragile, idle WebSocket with minimal recovery — matching the reported ~2-minute disconnects, missed alerts, and wrong unread counts.

**After:** The widget actively keeps the connection alive, reconnects intelligently, recovers after sleep/network events, re-syncs the alert count on connect, and logs disconnects for diagnostics. Lab soak against production showed a stable multi-minute session with heartbeat.  

**Next step for FGC:** Install the new build on a previously affected workstation, run the on-site checklist in section 7, and share logs if any disconnect cadence remains so proxy/server idle settings can be confirmed.
