# Golden tray app: HTTP API contract

All JSON. Everything under `/api` needs a session cookie (`POST /api/login`) or `Authorization: Bearer <ADMIN_TOKEN>`. Without one it returns `401 {"error":"unauthorized"}`.

Mutations must send `Content-Type: application/json`. Times are ISO-8601 UTC strings. Money is a number in the store's currency (GBP).

## Auth
- `POST /api/login` `{name, password}` → `200 {ok:true, name}`, `401 {error:"bad_password"}` or `429 {error:"too_many_attempts"}`. Sets an HttpOnly cookie `gt_session`.
- `POST /api/logout` → `{ok:true}`
- `GET /api/me` → `{name}` or `401`

## Status: `GET /api/status`
```json
{
  "now": "2026-11-06T09:12:03.120Z",
  "version": "1.0.0",
  "settings": { "...": "see Settings" },
  "rules": {
    "delaySeconds": 60, "maxWaitSeconds": 180,
    "routedTags": ["Linc Manual", "Linc Queue", "..."],
    "releasedTags": ["Linc", "ILG_RELEASED", "..."]
  },
  "lockedWhileLive": ["traySku","trayVariantId","qualifyingSkus","tag","allowedCountries"],
  "window": {
    "startsAt": "2026-11-06T07:00:00.000Z", "endsAt": "2026-11-06T19:00:00.000Z",
    "state": "not_started | open | ended",
    "totalHours": 12, "hoursElapsed": 2.2, "hoursLeft": 9.8,
    "msToStart": 0, "msToEnd": 35280000
  },
  "counts": {
    "live":   { "received": 0, "queued": 0, "not_eligible": 0, "eligible": 0, "lost": 0, "cap_reached": 0,
                "awarding": 0, "won": 0, "skipped": 0, "failed": 0, "tag_failed": 0 },
    "shadow": { "...same keys...": 0 }
  },
  "activeMode": "live | shadow | null",
  "traysLeft": 412,
  "pacing": {
    "oneInN": 20, "probabilityPct": 5,
    "suggestedOneInN": 18, "ratePerHour": 820.5, "basis": "observed | estimate",
    "expectedRemainingOrders": 8040, "projectedWinners": 490,
    "traysLeft": 412
  },
  "worker":   { "running": true, "lastTickAt": "...", "queued": 3, "awarding": 0, "tagRetriesPending": 0 },
  "backfill": { "lastRunAt": "...", "lastFound": 0, "lastError": null },
  "shopify":  { "store": "staging-purdy-global.myshopify.com", "adminOrdersUrl": "https://admin.shopify.com/store/staging-purdy-global/orders/",
                "apiVersion": "2026-10", "authMode": "token | client_credentials" },
  "setup":    { "ok": true, "checkedAt": "...", "problems": [] }
}
```
- `counts.*.eligible` = orders that were rolled (lost + won + cap_reached + awarding + skipped-after-roll + failed).
- `received` = all stored rows for that mode.
- `traysLeft` is for `activeMode`, or live when off.
- A row's mode is the mode at the time it was decided. Queued rows count under the current mode.

## Rules (`rules` in the status): read-only, developers only
The delay before the roll, the max wait for linc-app's routing, and the routed/released tag lists are fixed in code (`src/rules.js`; `DELAY_SECONDS` / `MAX_WAIT_SECONDS` env for developers). They are **not** settings: `PATCH /api/settings` answers `400 {error:"invalid", field}` ("Unknown setting") for them. Backfill is always on and auto-pace no longer exists.

## Settings (`settings` object; `PATCH /api/settings` takes any subset)
| key | type | rules |
|---|---|---|
| campaignName | string | 1–80 chars |
| mode | `"off" \| "shadow" \| "live"` | live refused (409) if setup check fails |
| startsAt, endsAt | ISO string | endsAt > startsAt |
| oneInN | int | ≥ 1 |
| cap | int | ≥ 0 |
| estimatedOrders | int | ≥ 1 |
| minSubtotal | number | ≥ 0 |
| traySku | string | locked while live |
| trayVariantId | string (numeric id) | locked while live |
| qualifyingSkus | string[] | ≥ 1, locked while live |
| allowTestOrders | bool | accept Shopify test orders (staging only) |
| tag | string | locked while live |
| allowedCountries | string[] (ISO-2) | locked while live |
| discountDescription | string | 1–80 |

Responses:
- `200 {settings, warnings:[string]}`
- `400 {error:"invalid", field, message}`
- `409 {error:"locked_while_live", field}`
- `409 {error:"setup_incomplete", problems:[…]}`

## Orders
`GET /api/orders?status=&mode=&q=&limit=50&offset=0` → `{total, items:[Order]}`
- `status` is one of the statuses below, or `"all"`.
- `q` matches the order name, number or customer email.

`GET /api/winners?mode=live|shadow` → `{items:[Order]}`, with status won (live) or shadow_won, sorted by slot.

`GET /api/winners.csv?mode=live` → CSV columns `slot,order,order_id,created_at,won_at,customer_id,customer_email,subtotal,tag_status`.

Order:
```json
{ "id":"13527749558651", "name":"#38014", "number":38014, "createdAt":"…", "receivedAt":"…",
  "source":"webhook | backfill", "subtotal":54, "currency":"GBP",
  "customerId":"…", "customerEmail":"j***@example.com", "country":"GB",
  "status":"queued | not_eligible | lost | cap_reached | awarding | won | shadow_won | skipped | failed",
  "reason":"subtotal_below_min | potential_fraud | … | null", "mode":"live | shadow | null",
  "slot":3, "rollN":20, "attempts":1, "lastError":null, "trayAddedAt":"…",
  "tagStatus":"ok | failed | pending | null", "updatedAt":"…",
  "adminUrl":"https://admin.shopify.com/store/<handle>/orders/13527749558651" }
```
Actions:
- `POST /api/orders/:id/retry` → `{ok:true}` re-queues a `failed` (or `skipped`) order, or returns `409 {error}`.
- `POST /api/orders/:id/retry-tags` → `{ok:true}`.
- `POST /api/orders/check {order:"#38014" | "38014" | "<id>"}` → `{order:{id,name,…}, checks:[{name, ok, detail}], eligible:bool, stored:Order|null}`. Read-only, no roll.

## Timeline
`GET /api/timeline?bucketMinutes=15` → `{bucketMinutes, window:{startsAt,endsAt}, cap, buckets:[{start, eligible, winners, cumulativeWinners, idealCumulative}]}`, for the active mode, or live when off.

## Events
`GET /api/events?limit=50&before=<id>` → `{items:[{id, at, level:"info|warn|error", type, orderId, orderName, actor, message}]}`, newest first.

## Setup
- `GET /api/setup` → `{ok, checkedAt, checks:[{name, ok, detail}], webhook:{registered, uri}}`. Calls Shopify; results are cached for `status.setup`.
- `POST /api/setup/webhook` → `{ok, created:bool, id}`.

## Danger
`POST /api/reset {scope:"shadow"|"all", confirm:"RESET"}` → `{ok, deleted}`. `all` returns `409` while mode is live.

## Public
- `GET /health` → `{ok:true}`
- `POST /webhooks/orders/create`: Shopify, HMAC-verified.
