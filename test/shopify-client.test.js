'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShopifyClient, ShopifyError } = require('../src/shopify/client');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

const base = { domain: 'shop.myshopify.com', apiVersion: '2026-10', sleep: async () => {} };

test('sends the token and the pinned API version, and returns data', async () => {
  const fetch = fakeFetch([json(200, { data: { shop: { name: 'S' } } })]);
  const client = new ShopifyClient({ ...base, accessToken: 'shpat_x', fetch });
  assert.deepEqual(await client.request('{ shop { name } }', {}, { operation: 'Shop' }), { shop: { name: 'S' } });
  assert.equal(fetch.calls[0].url, 'https://shop.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(fetch.calls[0].init.headers['X-Shopify-Access-Token'], 'shpat_x');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { query: '{ shop { name } }', variables: {} });
  assert.equal(client.authMode, 'token');
});

test('retries THROTTLED, for mutations too, then succeeds', async () => {
  const throttled = json(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 10, restoreRate: 50 } } } });
  const sleeps = [];
  const fetch = fakeFetch([throttled, json(200, { data: { ok: 1 } })]);
  const client = new ShopifyClient({ ...base, accessToken: 't', fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(await client.request('mutation { x }', {}, { operation: 'X', mutation: true }), { ok: 1 });
  assert.equal(fetch.calls.length, 2);
  assert.ok(sleeps[0] >= 1800, `waits for the bucket to refill, got ${sleeps[0]}`);
});

test('retries HTTP 429', async () => {
  const fetch = fakeFetch([json(429, {}), json(200, { data: { ok: 1 } })]);
  const client = new ShopifyClient({ ...base, accessToken: 't', fetch });
  assert.deepEqual(await client.request('{ x }', {}, { operation: 'X' }), { ok: 1 });
});

test('queries retry 5xx and network errors; gives up after the limit', async () => {
  const fetch = fakeFetch([json(502, {}), new TypeError('fetch failed'), json(200, { data: { ok: 1 } })]);
  const client = new ShopifyClient({ ...base, accessToken: 't', fetch });
  assert.deepEqual(await client.request('{ x }', {}, { operation: 'X' }), { ok: 1 });

  const failing = fakeFetch([json(500, {}), json(500, {}), json(500, {}), json(500, {}), json(500, {})]);
  const client2 = new ShopifyClient({ ...base, accessToken: 't', fetch: failing });
  await assert.rejects(client2.request('{ x }', {}, { operation: 'X' }), (e) => e instanceof ShopifyError && e.code === 'HTTP_500' && e.retryable);
  assert.equal(failing.calls.length, 3);
});

test('mutations do NOT retry 5xx or network errors (the write may have happened)', async () => {
  const fetch = fakeFetch([new TypeError('fetch failed')]);
  const client = new ShopifyClient({ ...base, accessToken: 't', fetch });
  await assert.rejects(client.request('mutation { x }', {}, { operation: 'X', mutation: true }), (e) => e.code === 'NETWORK' && e.retryable === true);
  assert.equal(fetch.calls.length, 1);
});

test('other GraphQL errors fail at once and are not retryable', async () => {
  const fetch = fakeFetch([json(200, { errors: [{ message: 'Field x does not exist' }] })]);
  const client = new ShopifyClient({ ...base, accessToken: 't', fetch });
  await assert.rejects(client.request('{ x }', {}, { operation: 'X' }), (e) => e.code === 'GRAPHQL' && e.retryable === false && /does not exist/.test(e.message));
});

test('401 with a static token is a clear, non-retryable error', async () => {
  const fetch = fakeFetch([json(401, { errors: '[API] Invalid API key or access token' })]);
  const client = new ShopifyClient({ ...base, accessToken: 'bad', fetch });
  await assert.rejects(client.request('{ x }', {}, { operation: 'X' }), (e) => e.code === 'UNAUTHORIZED' && !e.retryable);
});

test('client credentials: gets a token (form post), caches it, and refreshes it when it expires', async () => {
  let clock = 0;
  const tokenResponse = (token) => json(200, { access_token: token, scope: 'read_orders', expires_in: 86399 });
  const fetch = fakeFetch([tokenResponse('tok1'), json(200, { data: { a: 1 } }), json(200, { data: { a: 2 } }), tokenResponse('tok2'), json(200, { data: { a: 3 } })]);
  const client = new ShopifyClient({ ...base, clientId: 'cid', clientSecret: 'csec', fetch, now: () => clock });
  assert.equal(client.authMode, 'client_credentials');
  await client.request('{ a }', {}, { operation: 'A' });
  await client.request('{ a }', {}, { operation: 'A' });
  const tokenCall = fetch.calls[0];
  assert.equal(tokenCall.url, 'https://shop.myshopify.com/admin/oauth/access_token');
  assert.equal(tokenCall.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(String(tokenCall.init.body), 'grant_type=client_credentials&client_id=cid&client_secret=csec');
  assert.equal(fetch.calls[1].init.headers['X-Shopify-Access-Token'], 'tok1');
  assert.equal(fetch.calls[2].init.headers['X-Shopify-Access-Token'], 'tok1');
  clock = 86399 * 1000; // expired (refresh 5 minutes early)
  await client.request('{ a }', {}, { operation: 'A' });
  assert.equal(fetch.calls[4].init.headers['X-Shopify-Access-Token'], 'tok2');
});

test('client credentials: a 401 gets a new token once and retries', async () => {
  const fetch = fakeFetch([
    json(200, { access_token: 'old', expires_in: 86399 }),
    json(401, {}),
    json(200, { access_token: 'new', expires_in: 86399 }),
    json(200, { data: { ok: 1 } }),
  ]);
  const client = new ShopifyClient({ ...base, clientId: 'c', clientSecret: 's', fetch });
  assert.deepEqual(await client.request('{ x }', {}, { operation: 'X' }), { ok: 1 });
  assert.equal(fetch.calls[3].init.headers['X-Shopify-Access-Token'], 'new');
});

test('client credentials: a failed token request explains why', async () => {
  const fetch = fakeFetch([json(400, { error: 'shop_not_permitted', error_description: 'not same org' })]);
  const client = new ShopifyClient({ ...base, clientId: 'c', clientSecret: 's', fetch });
  await assert.rejects(client.request('{ x }', {}, { operation: 'X' }), (e) => e.code === 'TOKEN' && /shop_not_permitted/.test(e.message));
});

test('baseUrl override (local fake Shopify only) replaces https://<domain> for API and token calls', async () => {
  const fetch = fakeFetch([json(200, { access_token: 't', expires_in: 86399 }), json(200, { data: { ok: 1 } })]);
  const client = new ShopifyClient({ ...base, clientId: 'c', clientSecret: 's', baseUrl: 'http://127.0.0.1:4200/', fetch });
  await client.request('{ x }', {}, { operation: 'X' });
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:4200/admin/oauth/access_token');
  assert.equal(fetch.calls[1].url, 'http://127.0.0.1:4200/admin/api/2026-10/graphql.json');
});
