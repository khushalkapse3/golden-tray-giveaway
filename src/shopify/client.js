'use strict';

// GraphQL Admin API client over fetch.
// - Auth: a static access token, or the client-credentials grant (Dev Dashboard apps; the token
//   lasts 24 h and is refreshed 5 minutes early, or after a 401).
// - Retries: THROTTLED / 429 for everything (Shopify rejected the request, nothing ran);
//   5xx / network only for queries. A mutation that failed in transit may have been applied,
//   so the caller decides (the engine re-checks the order before trying again).

const REQUEST_TIMEOUT_MS = 20000;
const MAX_THROTTLE_RETRIES = 5;
const MAX_QUERY_ATTEMPTS = 3;
const TOKEN_REFRESH_EARLY_MS = 5 * 60 * 1000;

class ShopifyError extends Error {
  constructor(message, { code, retryable = false, status, operation, userErrors } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.operation = operation;
    if (userErrors) this.userErrors = userErrors;
  }
}

class ShopifyClient {
  constructor({ domain, apiVersion = '2026-10', accessToken, clientId, clientSecret, baseUrl, fetch: fetchImpl = globalThis.fetch, sleep, now, logger } = {}) {
    this.domain = domain;
    // Local testing against a fake Shopify only (config refuses it in production).
    this.origin = baseUrl ? String(baseUrl).replace(/\/+$/, '') : `https://${domain}`;
    this.apiVersion = apiVersion;
    this.staticToken = accessToken || '';
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    this.fetch = fetchImpl;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now || Date.now;
    this.logger = logger;
    this.cachedToken = null; // {token, expiresAt}
  }

  get authMode() {
    return this.staticToken ? 'token' : 'client_credentials';
  }

  get endpoint() {
    return `${this.origin}/admin/api/${this.apiVersion}/graphql.json`;
  }

  async token({ refresh = false } = {}) {
    if (this.staticToken) return this.staticToken;
    if (!refresh && this.cachedToken && this.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_EARLY_MS) return this.cachedToken.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret });
    let response;
    try {
      response = await this.fetch(`${this.origin}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ShopifyError(`Token request failed: ${error.message}`, { code: 'TOKEN', retryable: true });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      const why = data.error ? `${data.error}${data.error_description ? `: ${data.error_description}` : ''}` : `HTTP ${response.status}`;
      throw new ShopifyError(`Token request refused (${why})`, { code: 'TOKEN', retryable: response.status >= 500, status: response.status });
    }
    this.cachedToken = { token: data.access_token, expiresAt: this.now() + Number(data.expires_in || 86399) * 1000, scope: data.scope };
    return this.cachedToken.token;
  }

  /** Runs one GraphQL document and returns `data`. Throws ShopifyError. */
  async request(query, variables = {}, { operation = 'graphql', mutation = false } = {}) {
    let throttles = 0;
    let attempts = 0;
    let refreshedAfter401 = false;
    for (;;) {
      attempts += 1;
      let response;
      try {
        response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': await this.token() },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof ShopifyError) throw error;
        const failure = new ShopifyError(`${operation}: network error (${error.message})`, { code: 'NETWORK', retryable: true, operation });
        if (!mutation && attempts < MAX_QUERY_ATTEMPTS) { await this.sleep(500 * 2 ** attempts); continue; }
        throw failure;
      }

      if (response.status === 401) {
        if (!this.staticToken && !refreshedAfter401) {
          refreshedAfter401 = true;
          await this.token({ refresh: true });
          attempts -= 1;
          continue;
        }
        throw new ShopifyError(`${operation}: Shopify rejected the access token (401)`, { code: 'UNAUTHORIZED', status: 401, operation });
      }
      if (response.status === 429) {
        if (++throttles > MAX_THROTTLE_RETRIES) throw new ShopifyError(`${operation}: throttled`, { code: 'THROTTLED', retryable: true, status: 429, operation });
        await this.sleep(1000 * 2 ** (throttles - 1));
        attempts -= 1;
        continue;
      }
      if (response.status >= 500) {
        const failure = new ShopifyError(`${operation}: Shopify HTTP ${response.status}`, { code: `HTTP_${response.status}`, retryable: true, status: response.status, operation });
        if (!mutation && attempts < MAX_QUERY_ATTEMPTS) { await this.sleep(500 * 2 ** attempts); continue; }
        throw failure;
      }

      const body = await response.json().catch(() => null);
      if (!response.ok || !body) {
        throw new ShopifyError(`${operation}: Shopify HTTP ${response.status}`, { code: `HTTP_${response.status}`, status: response.status, operation });
      }
      if (body.errors) {
        const errors = Array.isArray(body.errors) ? body.errors : [{ message: String(body.errors) }];
        if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
          if (++throttles > MAX_THROTTLE_RETRIES) throw new ShopifyError(`${operation}: throttled`, { code: 'THROTTLED', retryable: true, operation });
          await this.sleep(throttleWaitMs(body.extensions?.cost, throttles));
          attempts -= 1;
          continue;
        }
        throw new ShopifyError(`${operation}: ${errors.map((e) => e.message).join('; ')}`, { code: 'GRAPHQL', operation });
      }
      return body.data;
    }
  }
}

function throttleWaitMs(cost, throttles) {
  const status = cost?.throttleStatus;
  if (status && cost.requestedQueryCost && status.restoreRate) {
    const missing = Math.max(cost.requestedQueryCost - status.currentlyAvailable, 0);
    return Math.ceil((missing / status.restoreRate) * 1000) + 200;
  }
  return 1000 * 2 ** (throttles - 1);
}

module.exports = { ShopifyClient, ShopifyError };
