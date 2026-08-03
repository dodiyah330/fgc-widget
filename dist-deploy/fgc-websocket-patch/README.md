# FGC WebSocket server patch

Replace this file in the Symfony application, then restart the
`app:websocket-server` process:

- `src/WebSocketServer.php`

`src/Command/WebSocketServerCommand.php` is unchanged from the previous
delivery and only needs deploying if it was never applied.

## Pending-count rule (as requested on 2026-07-28)

The widget total is deliberately **not** the CMS **Alertes pendents** total. It
counts only incidents still awaiting an operator:

- pending state (`state = 1`)
- not yet handled by an operator (`updatedAt IS NULL`)
- not created manually from the CMS (`fromCms IS NULL`)
- excluding user `prova`

The widget number can therefore legitimately be lower than the CMS total.

## Fix in this revision: silent incidents

Under the rule above an alert leaves the pending set the moment an operator
handles it. The previous revision decided everything from the pending count
alone, and only emitted when that number changed. So when an operator handled
an alert in the same two-second poll window in which a new incident arrived,
the removal and the arrival cancelled out, the count looked unchanged, and the
server sent **nothing at all** — no sound, no blinking, and no count update.
The widget kept showing a number that was arithmetically correct, which is why
the situation looked normal until someone opened the CMS.

The poll now also reads `MAX(id)` over the pending set and keeps a
monotonic watermark of the highest incident id ever seen:

- a broadcast is emitted when the count changes **or** the watermark advances;
- `notify` is true when the watermark advances, whichever way the count moved.

Behaviour required by the client is unchanged:

| Event | Count | Sound |
| --- | --- | --- |
| New alert from the app | increases | yes |
| Operator handles an alert | decreases | no |
| Alert created from the CMS | unchanged | no |
| Handling + new alert in the same poll | unchanged | **yes** (was silent) |

Broadcasts now also log `max_alert_id` and `masked_arrival`, so this specific
collision is identifiable in the server log.

## Retained from the previous revision

1. Every connection receives a fresh database count immediately, rather than a
   cached value up to 14 seconds old.
2. `sync` and application `ping` responses are private. Only `stop_alerts` is a
   global application event.
3. Count decreases update the widget without replaying sound/blinking.
4. Polling runs every 2 seconds.
5. Database/query failures in the periodic ReactPHP timer are caught and logged
   instead of escaping the event loop and terminating the WebSocket process.
6. Ratchet protocol-level keepalive remains enabled at 30 seconds in
   `WebSocketServerCommand.php`. Browsers answer those control frames
   automatically; no JSON heartbeat is required from the widget.
7. `onOpen` and `sync` never touch the shared broadcast baselines. Because
   broadcasts are emitted only when the polled state differs from those
   baselines, refreshing them outside `broadcastAlerts()` would let a widget
   connecting between two polls suppress the notification for every other
   widget.

## Validation

Run from the Widget repository:

```bash
php -l server-patch/src/WebSocketServer.php
php tests/server-websocket-smoke.php
```

After deployment, confirm that a new alert sent from the mobile app notifies
the widget **while an operator is handling other alerts in the CMS**, which is
the case this revision fixes. Monitor the server log for
`Error consultando alertas` and for `masked_arrival: true`.
