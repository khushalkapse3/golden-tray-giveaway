# Golden tray app

A small app that runs on its own. It gives a free golden tray to up to **N random qualifying Shopify orders**. It has a **hard cap**, live odds you can change, and an admin dashboard.

The design and the reasons behind it are in `../plan.md`. The HTTP API is in `API.md`.

- **Runtime:** Node ≥ 22.
- **Dependencies:** Express and `@libsql/client`.
- **Database:** a hosted **Turso** database (libSQL, free plan) in production. Locally, with `DATABASE_URL` empty, a plain file under `DATA_DIR`. Same SQL either way.
- **Shopify:** GraphQL Admin API **2026-10**.

## How it works

1. **Shopify sends `orders/create`.** The app checks the HMAC, then stores any order in the window that contains the bundle.
2. **The order waits for the delay** (`delaySeconds`, 60 s by default), so linc-app routes it first.
3. **The app rolls 1 in N.** Losers stop here, and no Shopify call is made for them.
4. **A winner takes a slot under the cap.** This step is atomic. The app then re-reads the order from Shopify and checks it:
   - paid;
   - not cancelled;
   - not "Potential Fraud";
   - not released to a warehouse;
   - routed by linc-app. If it isn't routed yet, the app waits up to `maxWaitSeconds`.
5. **The app adds the tray.** It begins an order edit, adds the variant, applies a 100% discount, then commits with `notifyCustomer: false`.
6. **The app tags the order and the customer** (`GoldenTrayNov2026`). Failed tags are retried every minute.
7. **Failures are retried** up to 3 times (after 30 s, 90 s and 270 s). The slot is given back each time, so a failure never uses up a tray.
8. **Backfill** (every 3 min) catches any order whose webhook never arrived.
9. **Auto-pace** (optional) moves N towards the suggestion so the cap is reached by the end of the window.

**Time zone:** the whole dashboard can be shown in **IST** (default) or **UK** (London, GMT/BST) with the switch in the header. The choice is remembered in the browser. Every time on the page changes, window fields you have typed but not saved keep meaning the same moment, and UTC plus the other zone are always shown beside it. Times are stored and sent to the server as UTC either way.

Campaign settings live in the database and are changed from the dashboard. Env vars are only for infrastructure and secrets. Tray, SKU and tag settings are locked while the giveaway is live.

## Run it

```bash
npm install
cp .env.example .env          # fill it in
npm run dev                   # http://localhost:3100
```

- **Dashboard only, with fake data:** `npm run mock-dashboard` starts it at http://localhost:4100. The password is `dev`.
- **Whole app against a fake Shopify:** run `npm run fake-shopify`, then `SHOPIFY_BASE_URL=http://127.0.0.1:4200 SHOPIFY_DOMAIN=fake-store.myshopify.com npm run dev`.

## Tests

```bash
npm test                      # unit + HTTP tests (node --test), no network
npm run e2e                   # starts the real app + a fake Shopify, 25 end-to-end checks
npm run validate:graphql      # checks every GraphQL document against the 2026-10 schema (uses linc-app's copy)
```

## Test on staging (local app → staging store)

**Never point it at production while testing.** The header shows which store it's connected to.

1. **`.env`:**
   - `SHOPIFY_DOMAIN=staging-purdy-global.myshopify.com`;
   - `SHOPIFY_ACCESS_TOKEN`: linc-app's staging token works, since it has `write_order_edits`;
   - `SHOPIFY_WEBHOOK_SECRET`: the store webhook signing secret (linc-app's `SHOPIFY_WEBHOOK_SECRET`, not `SHOPIFY_SECRET_KEY`);
   - `ADMIN_PASSWORD`, and `PUBLIC_URL` (your ngrok https URL).
2. **Turn off linc-app's own golden tray code** (`GOLDEN_TRAY_MODE=off`), so the two don't both add trays.
3. **Start the app and log in.** Then, under Settings:
   - tray SKU `GT-STAGING-TRAY`, variant `56547070345595`;
   - a window around now;
   - delay 60 s.

   Then click **Run checks**.
4. **Get orders to the app**, one of two ways:
   - **Register webhook** (needs ngrok on port 3100);
   - or skip webhooks and rely on **backfill**, which finds orders every 3 min.
5. **Shadow first, then Live** with a small cap, for example 3. Create orders with `../scripts/staging-create-test-orders.js`. Run it from the linc-app root; it uses linc-app's `.env` and refuses to run against anything that isn't staging.
6. **Check:**
   - the tray is on the order at £0 and the total is unchanged;
   - the order and the customer are tagged;
   - no customer email was sent;
   - linc-app re-routed the order with the tray (not to Linc Manual);
   - the cap holds;
   - the winners list and the CSV are right.

## Database

- **Production: Turso, free plan** (500 M rows read and 10 M rows written a month, 5 GB). Create it once:
  ```bash
  turso db create golden-tray --location lhr   # a region near Render's
  turso db show golden-tray --url              # → DATABASE_URL (libsql://...)
  turso db tokens create golden-tray           # → DATABASE_AUTH_TOKEN
  ```
  Then check it before deploying: `DATABASE_URL=... DATABASE_AUTH_TOKEN=... npm run check-db`.
- **Locally:** leave `DATABASE_URL` empty and the app uses `DATA_DIR/golden-tray.db`.
- **How the cap stays exact without transactions:** taking a slot and handing out the next slot number are each **one SQL statement**, so no other request can get in between.
- **Free-plan budget:** the dashboard's heavy reads (counts, chart, lists) are reused for 8 s (`READ_CACHE_MS`). Anything the giveaway decides on (winner count, slot claim, due orders) is never cached.

## Running more than one copy

During a zero-downtime deploy the old and new copies run at the same time. Only the copy holding the **leader lease** (a row in the database, renewed every 5 s, valid 20 s) processes orders and runs the backfill. Both copies still answer webhooks and the dashboard, because receiving an order is safe twice.

On shutdown a copy finishes its in-flight awards, then gives the lease up, so the new copy takes over within a few seconds. If a copy crashes, its lease runs out after 20 s. The next leader then puts the crashed copy's unfinished awards back in the queue.

## Capacity

`npm run load-test` pushes orders through the real engine and store, with network delay added to every database and Shopify call. On 2026-10-29: 8,000 orders arriving at 25 a second (more than 100 times the real day's average), with the cap of 500 reached. See `../context.md` for the numbers.

## Deploy

**Render:** use `render.yaml`.
- It's a paid **Starter** web service. A free instance sleeps, which would stop the timers.
- There's **no disk**, so Render keeps zero-downtime deploys.
- Set `DATABASE_URL` and `DATABASE_AUTH_TOKEN` (Turso), plus the Shopify and admin variables.

**Hetzner:** a small VPS running Node 22, with the app under systemd (`npm start`) and Caddy in front for HTTPS. Use the same Turso database, or leave `DATABASE_URL` empty for a local file.

## Files

| Path | What |
|---|---|
| `src/server.js` | wiring and graceful shutdown |
| `src/engine.js` | the giveaway: receive, roll, claim, award, tag, retry, backfill, auto-pace, setup check |
| `src/store.js` | database (Turso/libSQL): tables, the one-statement cap claim, leader lease, read cache |
| `src/settings.js` | defaults, validation, live locks |
| `src/eligibility.js` | prefilter (webhook copy) and fresh checks (before the edit) |
| `src/pacing.js` | window maths, suggested N, timeline |
| `src/shopify/` | GraphQL client (auth, retries), documents, operations |
| `src/http/` | Express app, login and sessions |
| `public/` | dashboard (vanilla JS, no CDN) |
| `scripts/` | fake Shopify, e2e smoke test, load test, database check, GraphQL validation |
| `dev/mock-server.js` | dashboard with fake data, no backend needed |
