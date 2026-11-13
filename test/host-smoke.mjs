/**
 * Host-half smoke test for `dsh-balance-battery`.
 *
 * No server, no network: a fake context captures the two routes `apply`
 * registers, a scripted `fetch` plays each provider, and scripted credentials
 * answer the key lookups. Covered here are the paths the browser test cannot
 * see: credential selection, the Bearer header, the short cache, `?fresh=1`,
 * the connection fence, HTTP/network failures, and the rule that the key never
 * appears in a response body.
 *
 * Run: node test/host-smoke.mjs
 */
import { apply, inject, name } from '../index.js';

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === '' ? '' : `  — ${detail}`}`);
  }
};

const MOONSHOT_KEY = 'sk-moonshot-test-key-DO-NOT-LEAK';
const DEEPSEEK_KEY = 'sk-deepseek-test-key-DO-NOT-LEAK';
for (const ref of ['MOONSHOTAI_CN_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY']) {
  delete process.env[ref];
}

/* ---------- fake response ---------- */

function createResponse() {
  return {
    statusCode: 200,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? null;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
  };
}

const jsonOf = (response) => JSON.parse(response.body);

/** @returns a promise for the handler plus the response it wrote. */
async function call(routes, path, { method = 'GET', query = '' } = {}) {
  const route = routes.get(path);
  if (route === undefined) throw new Error(`route not registered: ${path}`);
  const res = createResponse();
  await route.handler({ method, url: path + query, headers: {} }, res);
  return res;
}

/* ---------- scripted world ---------- */

const fetchCalls = [];
let fetchScript = async (url) => {
  if (url.includes('/users/me/balance')) {
    return {
      status: 200,
      ok: true,
      json: async () => ({
        code: 0,
        data: { available_balance: 5.26872, voucher_balance: 5.1343904, cash_balance: 0.13433 },
        scode: '0x0',
        status: true,
      }),
    };
  }
  if (url.includes('/user/balance')) {
    return {
      status: 200,
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '33.32', granted_balance: '23.24', topped_up_balance: '10.07' }],
      }),
    };
  }
  throw new Error(`unexpected fetch ${url}`);
};
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url: String(url), options });
  return fetchScript(String(url), options);
};

let credentialScript = {
  MOONSHOTAI_CN_API_KEY: MOONSHOT_KEY,
  DEEPSEEK_API_KEY: DEEPSEEK_KEY,
};
let credentialCalls = 0;
let rejectNext = undefined;

function makeContext({ credentials = true, connection = true } = {}) {
  const routes = new Map();
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { const dispose = fn(); return { dispose }; },
    get(nameOf) {
      if (nameOf === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
      }
      if (nameOf === 'connection' && connection) {
        return {
          requestRejection() {
            if (rejectNext !== undefined) {
              const code = rejectNext;
              rejectNext = undefined;
              return code;
            }
            return undefined;
          },
        };
      }
      if (nameOf === 'credentials' && credentials) {
        return {
          async resolve(ref) {
            credentialCalls += 1;
            const value = credentialScript[ref];
            return typeof value === 'string' && value !== '' ? { value, source: 'store' } : undefined;
          },
        };
      }
      return undefined;
    },
  };
  ctx.effect(() => () => {}, 'test');
  apply(ctx);
  return routes;
}

console.log('module shape');
check('exports apply/inject/name', typeof apply === 'function' && Array.isArray(inject) && typeof name === 'string');
check('host needs only the web server structurally', inject.join(',') === 'webServer', inject.join(','));

console.log('\nroutes');
const routes = makeContext();
check('registers the two provider routes', routes.has('/dsh-balance-battery/deepseek') && routes.has('/dsh-balance-battery/kimi'), [...routes.keys()].join(','));
check('routes are exact matches', routes.get('/dsh-balance-battery/kimi').kind === 'exact');

console.log('\nkimi');
let res = await call(routes, '/dsh-balance-battery/kimi');
check('answers 200 JSON', res.statusCode === 200 && String(res.headers?.['Content-Type']).startsWith('application/json'));
let body = jsonOf(res);
check('reports the spendable total', body.ok === true && body.total === 5.26872, JSON.stringify(body));
check('splits cash and vouchers', body.recharge === 0.13433 && body.bonus === 5.1343904, JSON.stringify(body));
check('carries the Kimi top-up URL', body.topUpUrl === 'https://platform.kimi.com/console/account', String(body.topUpUrl));
check('names the credential it used, never its value', body.ref === 'MOONSHOTAI_CN_API_KEY' && !res.body.includes(MOONSHOT_KEY), res.body);
check('sends the key as a Bearer header', fetchCalls[0]?.options?.headers?.Authorization === `Bearer ${MOONSHOT_KEY}`);
check('calls the CN balance endpoint', fetchCalls[0]?.url === 'https://api.moonshot.cn/v1/users/me/balance', String(fetchCalls[0]?.url));
check('response body never stores the key', !res.body.includes('sk-'), res.body);

console.log('\ncache');
const before = fetchCalls.length;
res = await call(routes, '/dsh-balance-battery/kimi');
check('a repeat read is served from the short cache', fetchCalls.length === before, `${before} -> ${fetchCalls.length}`);
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('?fresh=1 bypasses the cache', fetchCalls.length === before + 1, `${before} -> ${fetchCalls.length}`);
check('the fresh read is still a successful answer', jsonOf(res).ok === true);

console.log('\ndeepseek');
res = await call(routes, '/dsh-balance-battery/deepseek');
body = jsonOf(res);
check('reads the DeepSeek API-key balance', body.ok === true && body.total === 33.32, JSON.stringify(body));
check('keeps recharge and grants apart', body.recharge === 10.07 && body.bonus === 23.24, JSON.stringify(body));
check('uses DEEPSEEK_API_KEY', body.ref === 'DEEPSEEK_API_KEY', String(body.ref));
check('calls api.deepseek.com/user/balance', fetchCalls.some((entry) => entry.url === 'https://api.deepseek.com/user/balance'));

console.log('\nkey aliases');
credentialScript = { MOONSHOT_API_KEY: MOONSHOT_KEY };
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('falls back to MOONSHOT_API_KEY', jsonOf(res).ok === true && jsonOf(res).ref === 'MOONSHOT_API_KEY', res.body);
credentialScript = { KIMI_API_KEY: MOONSHOT_KEY };
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('falls back to KIMI_API_KEY', jsonOf(res).ok === true && jsonOf(res).ref === 'KIMI_API_KEY', res.body);
credentialScript = {};

console.log('\nmissing credential');
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
body = jsonOf(res);
check('reports missing-credential instead of zero', body.ok === false && body.error === 'missing-credential', JSON.stringify(body));
check('lists the names it tried for the readout', Array.isArray(body.refs) && body.refs[0] === 'MOONSHOTAI_CN_API_KEY', JSON.stringify(body.refs));
check('does not call the provider without a key', fetchCalls.every((entry) => !entry.url.includes('/users/me/balance') || !entry.options.headers.Authorization.includes('undefined')));

console.log('\nlaunch environment fallback');
process.env.MOONSHOTAI_CN_API_KEY = 'sk-from-env';
const envRoutes = makeContext({ credentials: false });
res = await call(envRoutes, '/dsh-balance-battery/kimi');
check('uses the process environment when no credential store is mounted', jsonOf(res).ok === true && jsonOf(res).ref === 'MOONSHOTAI_CN_API_KEY', res.body);
delete process.env.MOONSHOTAI_CN_API_KEY;

console.log('\nauthorization');
credentialScript = { MOONSHOTAI_CN_API_KEY: MOONSHOT_KEY, DEEPSEEK_API_KEY: DEEPSEEK_KEY };
fetchScript = async () => ({ status: 401, ok: false, json: async () => ({}) });
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a rejected key is unauthorized, not a zero balance', jsonOf(res).error === 'unauthorized', res.body);
res = await call(routes, '/dsh-balance-battery/deepseek', { query: '?fresh=1' });
check('deepseek unauthorized maps the same way', jsonOf(res).error === 'unauthorized', res.body);

console.log('\nprovider failures');
fetchScript = async () => ({ status: 500, ok: false, json: async () => ({}) });
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('an HTTP failure keeps its status', jsonOf(res).error === 'http' && jsonOf(res).status === 500, res.body);
fetchScript = async () => ({ status: 429, ok: false, json: async () => ({}) });
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a rate-limited response is its own code', jsonOf(res).error === 'rate-limited' && jsonOf(res).status === 429, res.body);
fetchScript = async () => ({ status: 200, ok: true, json: async () => ({}) });
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('an unexpected body is bad-response', jsonOf(res).error === 'bad-response', res.body);
fetchScript = async () => { throw new Error('offline'); };
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a network throw is network', jsonOf(res).error === 'network', res.body);
fetchScript = async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; };
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a timeout is timeout', jsonOf(res).error === 'timeout', res.body);

console.log('\nconnection fence');
fetchScript = async () => ({ status: 200, ok: true, json: async () => ({ data: { available_balance: 1 } }) });
rejectNext = 401;
const fenced = fetchCalls.length;
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a rejected request stops before the provider', res.statusCode === 401 && res.body === '' && fetchCalls.length === fenced, `${res.statusCode}/${res.body}`);

console.log('\nconnection fence — fail closed');
const unfenced = makeContext({ connection: false });
res = await call(unfenced, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a missing connection service refuses (403) instead of leaking', res.statusCode === 403 && res.body === '', `${res.statusCode}/${res.body}`);

console.log('\nmethod');
res = await call(routes, '/dsh-balance-battery/kimi', { method: 'POST' });
check('non-GET answers 405', res.statusCode === 405 && jsonOf(res).error === 'method-not-allowed', `${res.statusCode} ${res.body}`);

console.log('\nno web server');
let warned = false;
apply({
  logger: { warn: () => { warned = true; } },
  effect: (fn) => { fn(); },
  get: () => undefined,
});
check('a composition without a web server warns instead of throwing', warned);

console.log('\nkimi — international site fallback');
credentialScript = { MOONSHOTAI_API_KEY: MOONSHOT_KEY };
const intlAttempts = [];
const domesticScript = fetchScript;
fetchScript = async (url) => {
  intlAttempts.push(String(url));
  if (String(url).includes('api.moonshot.cn')) return { status: 401, ok: false, json: async () => ({}) };
  return { status: 200, ok: true, json: async () => ({ data: { available_balance: 9.5, cash_balance: 1, voucher_balance: 8.5 } }) };
};
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
body = jsonOf(res);
check('a rejected .cn key is retried on the international site', body.ok === true && body.total === 9.5, JSON.stringify(body));
check('the retry uses the .ai top-up URL', body.topUpUrl === 'https://platform.kimi.ai/console/account', String(body.topUpUrl));
check('the retry hits api.moonshot.ai', intlAttempts.some((url) => url.includes('api.moonshot.ai')), intlAttempts.join(','));
check('the .ai alias MOONSHOTAI_API_KEY is resolved', body.ref === 'MOONSHOTAI_API_KEY', String(body.ref));
fetchScript = domesticScript;

console.log('\nkimi — fallback keeps the primary network error');
credentialScript = { MOONSHOTAI_CN_API_KEY: MOONSHOT_KEY };
fetchScript = async (url) => {
  if (String(url).includes('api.moonshot.cn')) throw new Error('offline');
  return { status: 401, ok: false, json: async () => ({}) };
};
res = await call(routes, '/dsh-balance-battery/kimi', { query: '?fresh=1' });
check('a .cn outage with a .cn key reports network, not a rejected key', jsonOf(res).error === 'network', res.body);
fetchScript = domesticScript;

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
