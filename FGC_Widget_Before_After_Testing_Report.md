# FGC Desktop Widget – WebSocket Investigation and Before/After Report

**Project:** FGC Incivility Desktop Widget

**Prepared for:** FGC / Crest Coder Development Team

**Date:** 25 July 2026
**Production WebSocket:** `ws://incivisme.fgc.cat:8080`

## Executive summary

After receiving and reviewing both the Electron widget and Symfony WebSocket
server code, we confirmed that the issue was not a proxy or load-balancer
timeout. Production connects directly to ReactPHP/Ratchet, whose protocol-level
keepalive sends a ping every 30 seconds.

The review identified multiple client and server defects that explain the wrong
pending count, delayed recovery, false notification behavior, and potential
whole-server disconnects:

1. The WebSocket count query did **not** use the same definition as the CMS
   “Alertes pendents” list.
2. A newly connected/reconnected widget could receive a stale count or no count.
3. The server broadcast every application message type to every widget.
4. A database exception in the periodic ReactPHP timer was not contained and
   could terminate the long-running process.
5. The widget had fragile fixed-delay reconnection, no sleep/wake recovery, and
   insufficient close diagnostics.
6. The widget UI could miss a very fast initial count due to a watcher race.
7. The server polled for changes only every 14 seconds, making normal delivery
   inherently delayed even while the connection was healthy.

Both client and server patches have been prepared. The rebuilt widget passes
lint and production build checks. A passive four-minute production WebSocket
test completed with **zero spontaneous disconnects**.

## Architecture confirmed by client

- Production server listens directly on port `8080`.
- No nginx/Apache proxy or load balancer is in the WebSocket path.
- Server stack: ReactPHP `SocketServer` + Ratchet.
- Ratchet protocol keepalive: 30 seconds.
- Development WebSocket port: `6018`.
- Widget log: `~/Library/Logs/FGC Widget APP/main.log`.

## Before – confirmed technical findings

### 1. Widget count did not match the CMS

The total displayed in CMS “Alertes pendents” is produced by
`AlertRepository::getTotalAlerts()`, which counts alerts with pending state and
excludes the `prova` test user.

The WebSocket query used a different definition. It did not exclude `prova`, and
it additionally required:

- `updatedAt IS NULL`
- `fromCms IS NULL`

Consequences:

- An incident could remain visible in CMS “Alertes pendents” but disappear from
  the widget count after being updated.
- A pending incident created from the CMS could be excluded from the widget.
- Pending alerts belonging to the `prova` user were counted by the widget but not
  by the CMS total.
- The mismatch was deterministic, not merely a temporary connection issue.

### 2. Initial and reconnect count could be stale

The server stored a cached `lastCount` updated every 14 seconds. On connection:

- no count was sent when the process had not completed its first timer cycle;
- otherwise, the cached value could be up to 14 seconds old.

This explains delayed or temporarily incorrect counts after starting or
reconnecting the widget.

### 3. Application messages were broadcast globally

The server accepted any JSON object containing `type` and broadcast that type
to all connected widgets.

This is unsafe because legacy widgets interpret any typed message other than
`stop_alerts` as a notification. JSON `ping`, `pong`, `sync`, or unknown
messages could therefore trigger false notification state across all widgets.

### 4. Timer/database errors could disconnect everyone

The database query ran inside a ReactPHP periodic callback with no exception
boundary. An exception escaping an event-loop timer can terminate the process,
which disconnects all widgets simultaneously until the process is restarted.

### 5. Notification replay on count decrease

Whenever the count changed and remained above zero, the server used
`notify=true`. For example, handling one incident and reducing the count from
five to four could replay sound/blinking even though no new incident arrived.

### 6. Client recovery and state issues

Before stabilization, the widget had:

- a single fixed five-second reconnect timer in the Vue layout;
- broken `onerror` cleanup;
- no reconnect on computer sleep/wake or network restoration;
- no WebSocket close code, reason, cleanliness, or session-duration logs;
- a possible race where the server snapshot arrived before the UI watcher.

### 7. Alert delivery had a built-in delay

The server checked the database every 14 seconds. A new incident could
therefore take nearly 14 seconds to reach a correctly connected widget.

### 8. A connecting widget could silence other widgets

The server compares each poll against a single shared `lastCount` baseline and
only broadcasts when the value changes. Any code path that refreshes that
baseline outside the broadcast therefore consumes the pending change.

This was verified during our own review and is now covered by an automated
regression test: if a widget connects (or requests a sync) between two polls,
the shared baseline must not be updated, otherwise the next poll sees “no
change” and the widgets already connected never receive the new incident.

## After – corrections delivered

### Server

- Pending count now mirrors the CMS total exactly: pending state, excluding the
  `prova` test user.
- A fresh database count is sent immediately on every connect/reconnect.
- Connect and sync responses no longer modify the shared broadcast baseline, so a
  widget connecting between polls cannot suppress another widget's notification.
- `sync` returns the current count only to the requester.
- optional application `ping` returns `pong` only to the requester.
- only `stop_alerts` is broadcast globally.
- count increases use `notify=true`; decreases update with `notify=false`.
- database/timer exceptions are logged and contained, allowing the next
  two-second cycle to retry.
- polling is reduced from 14 seconds to 2 seconds to bound normal delivery
  delay.
- a failed send is isolated to that client rather than breaking a full
  broadcast.
- Ratchet’s existing 30-second protocol keepalive remains enabled.

### Widget

- exponential reconnect backoff from 2 to 30 seconds;
- 15-second connection-attempt timeout;
- stale connection and reconnect timers are cleaned safely;
- reconnect after Electron resume/unlock and browser network restoration;
- close logs now include `code`, `reason`, `wasClean`, and `durationMs`;
- broken `onerror` Promise/context logic removed;
- visible incident count derives directly from Pinia state, eliminating the
  initial-snapshot watcher race;
- if the authoritative count is higher after a reconnect, the widget treats
  the difference as incidents missed during the gap and triggers notification;
- no JSON heartbeat is sent—the browser automatically answers Ratchet’s
  protocol-level ping frames.

## Before vs after

| Area | Before | After |
|---|---|---|
| Pending-count definition | Extra exclusions; could differ from CMS | Matches CMS pending state |
| Count on connection | Cached, stale, or absent | Fresh authoritative database count |
| Message routing | Every type broadcast globally | Explicit routing; only stop event global |
| Count decrease | Could replay sound/blinking | Counter updates without notification |
| Normal alert delay | Up to ~14 seconds by polling design | Up to ~2 seconds by polling design |
| Timer query failure | Could escape event loop | Logged and contained |
| Reconnection | Fixed 5-second UI timer | Exponential 2–30 second store-managed retry |
| Connection attempt | No explicit timeout | 15-second timeout |
| Sleep/network recovery | Not handled | Forced reconnect on resume/online |
| Disconnect logs | Generic message only | Code, reason, cleanliness, duration |
| Initial UI count | Watcher race possible | Direct reactive store value |
| Incident during disconnect | Count could recover silently or stay stale | Higher reconnect snapshot triggers notification |
| Heartbeat | Ratchet protocol ping already active | Preserved; no unsafe JSON ping traffic |

## Testing completed

### Production passive connection soak

The probe sent no JSON ping or sync traffic. It relied only on the same
standards-based protocol keepalive used by Electron/Chromium.

| Run | Duration | Connections opened | Spontaneous disconnects | Longest session |
| --- | --- | --- | --- | --- |
| 1 | 4 minutes | 1 | 0 | 239,149 ms |
| 2 | 20 minutes | 1 | 0 | 1,199,782 ms |

- Initial server payload: `{"alerts":0,"notify":false}`
- Final close in both runs: intentional, code `1000` (`probe_done`)

Across 24 minutes of production connection time, both runs held a single
uninterrupted session. Ten consecutive two-minute windows elapsed without a
disconnect, so the reported "disconnects every two minutes" is not reproducible
at the transport level from our network, and the 30-second protocol keepalive
behaves correctly with a standard client.

The practical consequence is that the reported symptoms are explained by the
application-level defects above — an incorrect count definition, stale counts on
connect, globally broadcast message types, suppressed increments and 14-second
polling — rather than by a periodic transport timeout. On-site validation on a
previously affected FGC workstation is still required, because we cannot observe
that network from here.

### Automated server smoke test

Passed:

- current count on open;
- count filter identical to the CMS pending total;
- private ping/pong;
- private sync response;
- global `stop_alerts`;
- first cycle after restart publishes without replaying an alarm;
- unchanged count is not rebroadcast;
- notify on count increase, delivered to every connected widget;
- no notify on count decrease;
- a widget connecting between polls does not suppress the pending notification
  for the widgets already connected;
- a sync request between polls does not suppress the next broadcast;
- database failure containment;
- broadcasting continues after a client disconnects.

### Build and static checks

- PHP syntax checks: **pass**
- Server behavior smoke test: **pass**
- Client WebSocket store smoke test: **pass**
- Widget ESLint: **pass**
- macOS arm64 Electron build: **pass**

Build artifacts (verification only, macOS arm64):

- `dist/electron/Packaged/mac-arm64/fgc-widget.app`
- `dist/electron/Packaged/fgc-widget_arm64.dmg`
- `dist/electron/Packaged/fgc-widget_arm64.pkg`

These artifacts are signed with a local *Apple Development* certificate and are
not notarized, so `spctl` rejects them on other Macs. The distributable build
must be produced on the release machine using the Informage Developer ID
identity together with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`, so that `src-electron/mac-config/notarize.js` notarizes it.
Windows (`msi`) and Linux targets remain configured but were not built or tested
in this engagement.

## Deployment order

1. Replace the Symfony files with:
   - `server-patch/src/WebSocketServer.php`
   - `server-patch/src/Command/WebSocketServerCommand.php`
2. Restart the `app:websocket-server` production process.
3. Install the rebuilt widget.
4. Confirm the widget count equals the unfiltered CMS “Alertes pendents” total.

## Required on-site acceptance test

1. Run the widget for 2–4 hours on a workstation that previously reproduced
   the issue.
2. Send incidents whose description contains `test`.
3. Verify each incident appears in the CMS and the widget count matches exactly.
4. Manage/remove incidents and verify the count decreases without a new-alert
   sound.
5. Test sleep/wake and a temporary network interruption.
6. Review `~/Library/Logs/FGC Widget APP/main.log` for any `[WS] connection
   closed` entry.
7. Delete only test incidents after validation.

## Conclusion

The server was not behind a proxy and its Ratchet keepalive was correctly
enabled. However, server-side business logic and message routing defects were
confirmed alongside client recovery defects.

The delivered changes make the WebSocket count authoritative, prevent global
message amplification, contain long-running server failures, improve automatic
recovery, and provide actionable diagnostics. Final production acceptance
requires deploying both patches and completing the on-site test above.
