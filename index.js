/**
 * Host half of `dsh-balance-battery`.
 *
 * Why this row now owns a route
 * -----------------------------
 * DeepSeek's balance is still read by the browser half through the shipped
 * `account` Remote namespace. Kimi (Moonshot) has no account projection to
 * consume: its balance lives behind the Open Platform's
 * `GET /v1/users/me/balance` endpoint and the API key DSH already stores for the
 * `moonshotai-cn` LLM route. A browser cannot read that endpoint directly —
 * the key must not reach the page, and the endpoint has no CORS grant for this
 * origin — so this row serves the two provider probes over the local web
 * server and the browser half fetches them same-origin:
 *
 *   GET /dsh-balance-battery/deepseek   → { ok, total, recharge, bonus, … }
 *   GET /dsh-balance-battery/kimi       → { ok, total, recharge, bonus, … }
 *
 * The key itself never leaves this process: it is resolved per request through
 * `ctx.credentials` (the same store the Models page writes), used as a Bearer
 * header, and discarded. The response carries only amounts, the credential
 * *name* that was tried, and a top-up URL.
 *
 * Routes pass through the connection service's Host/Origin fence before any
 * work happens, so another local page cannot read the numbers. Results are
 * cached briefly (20 s) and single-flighted per provider; `?fresh=1` bypasses
 * the cache for the gauge's click-to-refresh.
 *
 * There is deliberately no schema/config surface: the credential names are the
 * ones DSH's own providers use, with a few common aliases as fallbacks.
 */

const ROUTE_BASE = '/dsh-balance-battery';

/** Successful answers are reused for this long; a click sends `?fresh=1`. */
const CACHE_TTL_MS = 20_000;
/** Outbound probe budget; a hanging endpoint must not pin the route. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ currency: string, total: number, recharge: number|null, bonus: number|null }} ProbeBalance
 * @typedef {{ title: string, url: string, refs: string[], topUpUrl: string, parse: (json: unknown) => ProbeBalance|null }} ProviderSpec
 */

/** @type {Record<string, ProviderSpec>} */
const PROVIDERS = {
  deepseek: {
    title: 'DeepSeek',
    url: 'https://api.deepseek.com/user/balance',
    refs: ['DEEPSEEK_API_KEY'],
    topUpUrl: 'https://platform.deepseek.com/top_up',
    /**
     * DeepSeek answers `balance_infos` with decimal strings; CNY is the wallet
     * the gauge is denominated in, and a USD-only account still reads.
     * @param json - parsed response body.
     */
    parse(json) {
      const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
      const info = infos.find((row) => row?.currency === 'CNY') ?? infos[0];
      if (info === undefined || info === null) return null;
      const total = amountOf(info.total_balance);
      if (total === null) return null;
      return {
        currency: info.currency === 'USD' ? 'USD' : 'CNY',
        total,
        recharge: amountOf(info.topped_up_balance),
        bonus: amountOf(info.granted_balance),
      };
    },
  },
  kimi: {
    title: 'Kimi',
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    /**
     * The international site. A .ai key (or a .cn host that is unreachable
     * from abroad) falls through here; both sites answer the same shape.
     */
    fallback: {
      url: 'https://api.moonshot.ai/v1/users/me/balance',
      topUpUrl: 'https://platform.kimi.ai/console/account',
    },
    refs: ['MOONSHOTAI_CN_API_KEY', 'MOONSHOTAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    topUpUrl: 'https://platform.kimi.com/console/account',
    /**
     * Kimi answers floats: available = cash + voucher. The gauge reads the
     * spendable total; the readout splits cash and vouchers.
     * @param json - parsed response body.
     */
    parse(json) {
      const data = json?.data;
      if (data === undefined || data === null) return null;
      const total = amountOf(data.available_balance);
      if (total === null) return null;
      return {
        currency: 'CNY',
        total,
        recharge: amountOf(data.cash_balance),
        bonus: amountOf(data.voucher_balance),
      };
    },
  },
};

/**
 * Parse one provider amount (number or decimal literal) without turning a
 * malformed value into a zero.
 * @param value - raw amount from the provider.
 * @returns the finite amount, or null.
 */
function amountOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param ctx - host plugin context. @returns the web server, or null. */
function webServerOf(ctx) {
  try {
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
    return server !== null && server !== undefined && typeof server.register === 'function' ? server : null;
  } catch (error) {
    return null;
  }
}

/** @param ctx - host plugin context. @returns the connection service, or null. */
function connectionOf(ctx) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
    return connection !== null && connection !== undefined && typeof connection.requestRejection === 'function' ? connection : null;
  } catch (error) {
    return null;
  }
}

/** @param ctx - host plugin context. @returns the credentials service, or null. */
function credentialsOf(ctx) {
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials;
    return credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function' ? credentials : null;
  } catch (error) {
    return null;
  }
}

/**
 * Resolve the first configured credential for a provider.
 *
 * `ctx.credentials.resolve` already layers the stored value over the launch
 * environment (an empty stored value counts as absent), so the process
 * environment is consulted only when the service itself is unavailable.
 * @param ctx - host plugin context.
 * @param refs - credential names to try, most specific first.
 * @returns `{ ref, key }`, or null when none is configured.
 */
async function resolveKey(ctx, refs) {
  const credentials = credentialsOf(ctx);
  if (credentials !== null) {
    for (const ref of refs) {
      try {
        const hit = await credentials.resolve(ref);
        const value = hit?.value;
        if (typeof value === 'string' && value.trim() !== '') return { ref, key: value.trim() };
      } catch (error) {
        /* A malformed stored value must not shadow the next alias. */
      }
    }
    return null;
  }
  for (const ref of refs) {
    const value = process.env[ref];
    if (typeof value === 'string' && value.trim() !== '') return { ref, key: value.trim() };
  }
  return null;
}

/** @param providerId - route id. @returns a JSON error body with a stable code. */
function failure(providerId, code, extra = {}) {
  return { ok: false, provider: providerId, error: code, ...extra, at: Date.now() };
}

/** @param providerId - route id. @returns the success body shared by both hosts. */
function successBody(providerId, credential, balance, topUpUrl, fresh) {
  return {
    ok: true,
    provider: providerId,
    ref: credential.ref,
    currency: balance.currency,
    total: balance.total,
    recharge: balance.recharge,
    bonus: balance.bonus,
    topUpUrl,
    at: Date.now(),
    fresh: fresh === true,
  };
}

/**
 * One request against one host, normalized to success/failure.
 *
 * `retry` marks the failures that may mean "this account lives on the other
 * site" — a rejected key (401/403) or a host unreachable from here (network /
 * timeout). The caller may then try the provider's fallback host once.
 * @param providerId - route id.
 * @param credential - `{ ref, key }` resolved for this provider.
 * @param url - the balance host to probe.
 * @param parse - the provider's response parser.
 * @returns `{ ok: true, balance }` or `{ ok: false, retry: boolean, failure: object }`.
 */
async function attempt(providerId, credential, url, parse) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential.key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'timeout' : 'network';
    return { ok: false, retry: true, failure: failure(providerId, code, { ref: credential.ref }) };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, retry: true, failure: failure(providerId, 'unauthorized', { ref: credential.ref, status: response.status }) };
  }
  if (response.status === 429) {
    return { ok: false, retry: false, failure: failure(providerId, 'rate-limited', { ref: credential.ref, status: response.status }) };
  }
  if (!response.ok) {
    return { ok: false, retry: false, failure: failure(providerId, 'http', { ref: credential.ref, status: response.status }) };
  }

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  const balance = parse(body);
  if (balance === null) {
    return { ok: false, retry: false, failure: failure(providerId, 'bad-response', { ref: credential.ref }) };
  }
  return { ok: true, balance };
}

/**
 * Query one provider and normalize every outcome to a JSON body.
 * @param ctx - host plugin context.
 * @param providerId - `deepseek` or `kimi`.
 * @param fresh - bypass the short result cache (click-to-refresh).
 */
async function probe(ctx, providerId, fresh) {
  const spec = PROVIDERS[providerId];
  if (spec === undefined) return failure(providerId, 'unknown-provider');

  const credential = await resolveKey(ctx, spec.refs);
  if (credential === null) {
    return failure(providerId, 'missing-credential', { refs: spec.refs });
  }

  const primary = await attempt(providerId, credential, spec.url, spec.parse);
  if (primary.ok === true) {
    return successBody(providerId, credential, primary.balance, spec.topUpUrl, fresh);
  }
  // A key from the other region, or a host unreachable from here, may still
  // work on the provider's fallback host: try it once.
  if (primary.retry === true && spec.fallback !== undefined) {
    const secondary = await attempt(providerId, credential, spec.fallback.url, spec.parse);
    if (secondary.ok === true) {
      return successBody(providerId, credential, secondary.balance, spec.fallback.topUpUrl, fresh);
    }
    return secondary.failure;
  }
  return primary.failure;
}

/**
 * Create the route handler set: one short cache and one single-flight slot per
 * provider, shared by every request.
 * @param ctx - host plugin context.
 */
function createRoutes(ctx) {
  /** @type {Map<string, { at: number, body: unknown }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map();

  const read = (providerId, fresh) => {
    if (fresh !== true) {
      const hit = cache.get(providerId);
      if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.body);
    }
    const running = inflight.get(providerId);
    if (running !== undefined) return running;
    const run = probe(ctx, providerId, fresh)
      .then((body) => {
        if (body.ok === true) cache.set(providerId, { at: Date.now(), body });
        return body;
      })
      .finally(() => {
        inflight.delete(providerId);
      });
    inflight.set(providerId, run);
    return run;
  };

  return { read };
}

/** @param res - node response. @param code - HTTP status. @param payload - JSON body. */
function sendJson(res, code, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
  });
  res.end(bytes);
}

/**
 * Host plugin body: claim the two balance routes on the local web server.
 * A composition without a web server keeps its client half working (the
 * DeepSeek account route needs no host cooperation), it just cannot show Kimi.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const server = webServerOf(ctx);
  if (server === null) {
    try {
      ctx.logger?.warn?.('[dsh-balance-battery] no webServer in this profile; the Kimi balance route is unavailable.');
    } catch (error) {
      /* Logging is best effort. */
    }
    return;
  }

  const { read } = createRoutes(ctx);
  const disposers = [];

  for (const providerId of Object.keys(PROVIDERS)) {
    const path = `${ROUTE_BASE}/${providerId}`;
    try {
      disposers.push(server.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          // Browser fence first: another local page must not read these numbers.
          // Fail closed: a profile without the connection service has no
          // Host/Origin fence at all, so refuse rather than leak balances.
          try {
            const connection = connectionOf(ctx);
            if (connection === null) {
              res.statusCode = 403;
              res.end();
              return;
            }
            const rejection = connection.requestRejection(req);
            if (rejection !== undefined && rejection !== null && rejection !== false) {
              res.statusCode = typeof rejection === 'number' ? rejection : 403;
              res.end();
              return;
            }
          } catch (error) {
            res.statusCode = 403;
            res.end();
            return;
          }

          if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
            sendJson(res, 405, failure(providerId, 'method-not-allowed'));
            return;
          }

          let fresh = false;
          try {
            fresh = new URL(req.url ?? path, 'http://localhost').searchParams.get('fresh') === '1';
          } catch (error) {
            fresh = false;
          }

          let body;
          try {
            body = await read(providerId, fresh);
          } catch (error) {
            body = failure(providerId, 'internal');
          }
          sendJson(res, 200, body);
        },
      }));
    } catch (error) {
      try {
        ctx.logger?.warn?.(`[dsh-balance-battery] cannot register ${path}: ${String(error?.message ?? error)}`);
      } catch (ignored) {
        /* Logging is best effort. */
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          /* Already gone. */
        }
      }
    }, 'dsh-balance-battery: balance routes');
  }
}

/** Required host services: only the web server is structural; the rest are read lazily per request. */
export const inject = ['webServer'];
/** Registered name, used by the loader's diagnostics. */
export const name = 'dsh-balance-battery';
