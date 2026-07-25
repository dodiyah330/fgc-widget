# FGC WebSocket server patch

Replace these files in the Symfony application, then restart the
`app:websocket-server` process:

- `src/WebSocketServer.php`
- `src/Command/WebSocketServerCommand.php`

## Confirmed fixes

1. The pending count now mirrors `AlertRepository::getTotalAlerts()`, the query
   behind the CMS **Alertes pendents** total: `state = 1 AND user != 'prova'`.
   The old query excluded alerts with `updatedAt` or `fromCms` and did not
   exclude `prova`, so the widget and CMS could show different totals.
2. Every connection receives a fresh database count immediately. The old
   implementation could send a cached value up to 14 seconds old, or no value
   before the first timer cycle.
3. `sync` and application `ping` responses are private. The old implementation
   broadcast every message type to every widget, which could trigger false
   notifications in legacy clients.
4. Only `stop_alerts` remains a global application event.
5. Count decreases update the widget without replaying sound/blinking.
6. Pending-count polling is reduced from 14 seconds to 2 seconds, bounding
   normal alert delivery delay without producing per-cycle info logs.
7. Database/query failures in the periodic ReactPHP timer are caught and
   logged instead of escaping the event loop and potentially terminating the
   WebSocket process.
8. Ratchet protocol-level keepalive remains enabled at 30 seconds in
   `WebSocketServerCommand.php`. Browsers respond to those control frames
   automatically; no JSON heartbeat is required from the widget.
9. `onOpen` and `sync` no longer touch the shared `lastCount` baseline. Because
   broadcasts are emitted only when the polled count differs from that baseline,
   refreshing it outside `broadcastAlerts()` would let a widget connecting
   between two polls suppress the notification for all other widgets.

## Validation

Run from the Widget repository:

```bash
php -l server-patch/src/WebSocketServer.php
php tests/server-websocket-smoke.php
```

After deployment, compare the widget count with the unfiltered CMS
**Alertes pendents** total and monitor the server process/logs through at least
one database interruption or restart scenario.
