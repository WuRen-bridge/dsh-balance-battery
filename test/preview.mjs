/**
 * Render the gauge to static HTML for visual review.
 *
 * It captures the plugin's REAL style sheet (through `apply`), renders the REAL
 * component tree with the mini React used by the smoke test, serializes that
 * tree to HTML, and wraps it in the host's REAL theme tokens and REAL composer
 * toolbar rules, read out of the installed DSH archive — so what the screenshot
 * shows is what the page shows, in either theme.
 *
 * Run: node test/preview.mjs            (writes test/preview/*.html)
 * Then, for example:
 *   msedge --headless=new --window-size=1280,420 --force-device-scale-factor=2 \
 *     --screenshot=test/preview/composer-light.png file:///D:/deepseek/balance-battery/test/preview/composer-light.html
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const ASAR = process.env.DSH_ASAR ?? 'D:\\deepseekHarness\\resources\\app.asar'
const OUT = here('./preview')

/* ---------- host CSS, straight out of the installed archive ---------- */

/**
 * Read the JS string literal holding one bundled CSS chunk, by marker
 * substring. Escapes are handled: a naive "next quote" cut lands on an escaped
 * quote inside the CSS and truncates the sheet mid-rule.
 */
function cssChunkFromArchive (marker) {
  const text = readFileSync(ASAR).toString('utf8')
  const at = text.indexOf(marker)
  if (at < 0) throw new Error(`archive has no CSS chunk containing ${marker}`)
  let cursor = text.lastIndexOf('"', at) + 1
  let out = ''
  for (; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (char === '\\') {
      const next = text[cursor + 1]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '' : next
      cursor += 1
      continue
    }
    if (char === '"') return out
    out += char
  }
  throw new Error(`unterminated string literal for ${marker}`)
}

let themeCss = ''
let inputBarCss = ''
/** The CSS-module hash of the composer in this build (changes between DSH builds). */
let composerPrefix = 'GRgSLq'
if (existsSync(ASAR)) {
  themeCss = cssChunkFromArchive('--dsw-alias-label-primary:')
  // `_cardWorkspaceTrigger` is unique to the composer's input-bar module.
  inputBarCss = cssChunkFromArchive('_cardWorkspaceTrigger')
  const prefix = inputBarCss.match(/\.([A-Za-z0-9_-]+)_cardWorkspaceTrigger/)
  if (prefix !== null) composerPrefix = prefix[1]
} else {
  console.log(`note: ${ASAR} not found — preview falls back to token-less sheets`)
}

/* ---------- mini React, module table, and page stubs ---------- */

function createFakeReact () {
  const cells = []
  let cursor = 0
  const pending = []
  const api = {
    Fragment: Symbol('Fragment'),
    createElement (type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState (initial) {
      const at = cursor++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], (next) => { cells[at] = typeof next === 'function' ? next(cells[at]) : next }]
    },
    useRef (initial) { const at = cursor++; if (!(at in cells)) cells[at] = { current: initial }; return cells[at] },
    useMemo (compute) { cursor += 1; return compute() },
    useCallback (fn) { cursor += 1; return fn },
    useEffect (fn) { cursor += 1; pending.push(fn); return undefined },
    useLayoutEffect (fn) { cursor += 1; pending.push(fn); return undefined },
    useId () { const at = cursor++; return `r${at}` },
    useSyncExternalStore (subscribe, getSnapshot) { cursor += 1; return getSnapshot() },
  }
  return {
    api,
    begin () { cursor = 0; pending.length = 0 },
    flush () { const queued = pending.splice(0, pending.length); for (const fn of queued) fn() },
    mark: () => cursor,
    rewind: (at) => { cursor = at },
    /** Drop every hook cell: a preview renders a fresh mount, not a re-render. */
    reset () { cells.length = 0 },
  }
}

const noop = () => {}
const listeners = new Map()
/** Style tags the plugin appends through `apply` — the real sheet this preview paints with. */
const appendedStyles = []
let loaded = null
globalThis.window = {
  __ModuleLoader__: { load (definition) { loaded = definition } },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: (type, fn) => listeners.set(`window:${type}`, fn),
  removeEventListener: noop,
}
globalThis.document = {
  visibilityState: 'visible',
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove: noop }),
  head: { append: (tag) => appendedStyles.push(tag) },
  body: {},
  addEventListener: noop,
  removeEventListener: noop,
}

const fakeReact = createFakeReact()
await import(new URL('../client.js', import.meta.url).href)
const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return fakeReact.api
  if (specifier === 'react-dom') return { createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }) }
  throw new Error(`unexpected require(${specifier})`)
})

/* ---------- tree helpers ---------- */

const expanded = new WeakMap()
const flat = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) flat(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.type === fakeReact.api.Fragment) return flat(node.children, out)
  if (typeof node.type === 'function') {
    if (!expanded.has(node)) {
      const mark = fakeReact.mark()
      expanded.set(node, node.type(node.props))
      fakeReact.rewind(mark)
    }
    return flat(expanded.get(node), out)
  }
  if (node.props === undefined && node.children === undefined) return out
  out.push(node)
  flat(node.children, out)
  return out
}
const byClass = (tree, className) => flat(tree).find((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(className))

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
const VOID = new Set(['input', 'br', 'hr', 'img'])
/** React prop names that are not DOM attribute names. */
const ATTRIBUTE_NAMES = { className: 'class', htmlFor: 'for', defaultChecked: 'checked' }
function serialize (node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (node.type === fakeReact.api.Fragment || node.type === 'portal') return serialize(node.children)
  if (typeof node.type === 'function') {
    if (!expanded.has(node)) {
      const mark = fakeReact.mark()
      expanded.set(node, node.type(node.props))
      fakeReact.rewind(mark)
    }
    return serialize(expanded.get(node))
  }
  const props = node.props ?? {}
  const attrs = Object.entries(props)
    .filter(([name, value]) => !['ref', 'children', 'key', 'style'].includes(name)
      && !name.startsWith('on')
      && typeof value !== 'function'
      && value !== undefined && value !== null && value !== false)
    .map(([name, value]) => ` ${ATTRIBUTE_NAMES[name] ?? name}="${escapeHtml(value === true ? 'true' : value)}"`)
    .join('')
  const style = props.style === undefined ? '' : ` style="${Object.entries(props.style).map(([name, value]) => `${name}:${value}`).join(';')}"`
  const open = `<${node.type}${attrs}${style}>`
  if (VOID.has(node.type)) return open
  return `${open}${serialize(node.children)}</${node.type}>`
}

/* ---------- render one gauge in one scripted state ---------- */

const RECT = { left: 500, top: 700, width: 96, height: 28, right: 596, bottom: 728 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Apply the plugin against a scripted account Remote, model directory, and Host
 * balance route replies, then render one gauge.
 * @param script - `state`, `balance`, and optional `route` replies for this preview.
 * @param options - `open` renders the hover readout, `bare` omits the account namespace,
 *   `provider` seeds the model directory's selected provider.
 * @returns the gauge's HTML.
 */
async function renderGauge (script, { open = false, bare = false, provider = 'deepseek-account' } = {}) {
  const dictionary = {}
  const locale = {
    register: (ns, dict) => { dictionary[ns] = dict; return () => {} },
    bind: (ns) => (key, params) => {
      const table = dictionary[ns] ?? {}
      let text = table.zh?.[key] ?? key
      if (params !== undefined) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
      return text
    },
    getSnapshot: () => ({ active: 'zh' }),
  }
  const account = {
    getState: async () => script.state,
    getBalance: async () => script.balance,
  }
  const store = {
    snapshot: { current: { provider, model: 'deepseek-flash', reasoningEffort: 'high' }, groups: [], status: 'ready', error: null },
    subscribe: () => () => {},
    getSnapshot () { return this.snapshot },
  }
  const modelDirectories = { directoryFor: () => ({ store }) }
  const routes = script.route ?? {}
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const key = new URL(String(url), 'http://127.0.0.1:2038').pathname.split('/').pop()
    const reply = routes[key] ?? { status: 404, body: { ok: false, error: 'unknown-provider' } }
    const status = reply.status ?? 200
    return { status, ok: status >= 200 && status < 300, json: async () => reply.body }
  }
  let registration = null
  const slots = { inject: (key, register) => register(), register: (options, component) => { registration = { options, component } } }
  const effects = []
  plugin.apply({
    slots,
    locale,
    remote: bare ? {} : { account },
    get: (name) => (!bare && name === 'modelDirectories' ? modelDirectories : undefined),
    effect: (fn) => { effects.push(fn()) },
  })
  await settle()
  await settle()
  const face = registration.options.inject('session-1')
  fakeReact.reset()
  const render = () => {
    fakeReact.begin()
    const tree = registration.component(face)
    for (const node of flat(tree)) {
      const ref = node.props?.ref
      if (ref === undefined || ref === null) continue
      if (typeof ref === 'function') ref({ getBoundingClientRect: () => RECT })
      else ref.current = { getBoundingClientRect: () => RECT }
    }
    fakeReact.flush()
    return tree
  }
  let tree = render()
  // The fill grows in on a 30ms timer so the CSS transition has a start value.
  await new Promise((resolve) => setTimeout(resolve, 45))
  tree = render()
  if (open) {
    byClass(tree, 'dbb-root').props.onPointerEnter()
    tree = render()
  }
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  globalThis.fetch = realFetch
  capturePluginCss()
  return serialize(tree)
}

/* ---------- scripted states ---------- */
const state = {
  signedIn: { ok: true, value: { status: 'credential-stored', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } } },
  signedOut: { ok: true, value: { status: 'signed-out', attempt: null, links: { topUpUrl: 'https://platform.deepseek.com/top_up' } } },
}
const ready = (balance, bonus) => ({
  ok: true,
  value: {
    status: 'ready',
    value: [{ currency: 'CNY', balance }],
    bonusWallets: bonus === undefined ? [] : [{ currency: 'CNY', balance: bonus }],
  },
})
const kimiRoute = (total, cash, voucher) => ({
  kimi: {
    status: 200,
    body: { ok: true, provider: 'kimi', currency: 'CNY', total, recharge: cash, bonus: voucher, topUpUrl: 'https://platform.kimi.com/console/account' },
  },
})
const deepseekRoute = {
  deepseek: {
    status: 200,
    body: { ok: true, provider: 'deepseek', currency: 'CNY', total: 33.32, recharge: 10.07, bonus: 23.24, topUpUrl: 'https://platform.deepseek.com/top_up' },
  },
}

const STATES = [
  { label: 'DeepSeek 账号 · ¥6.87', provider: 'deepseek-account', script: { state: state.signedIn, balance: ready('6.87') } },
  { label: 'DeepSeek 账号 · 充值 + 赠送 ¥30.99', provider: 'deepseek-account', script: { state: state.signedIn, balance: ready('25.991', '5.00') } },
  { label: 'Kimi · 可用 ¥5.27（现金 0.13 + 代金券 5.13）', provider: 'moonshotai-cn', script: { state: state.signedIn, balance: { ok: true, value: null }, route: kimiRoute(5.26872, 0.13433, 5.1343904) } },
  { label: 'Kimi · 偏低 ¥3.00', provider: 'moonshotai-cn', script: { state: state.signedIn, balance: { ok: true, value: null }, route: kimiRoute(3.0, 0.4, 2.6) } },
  { label: 'Kimi · 告急 ¥1.05', provider: 'moonshotai-cn', script: { state: state.signedIn, balance: { ok: true, value: null }, route: kimiRoute(1.05, 1.05, 0) } },
  { label: 'DeepSeek API · ¥33.32', provider: 'deepseek-official', script: { state: state.signedIn, balance: { ok: true, value: null }, route: deepseekRoute } },
  { label: 'Kimi · 未配置密钥', provider: 'moonshotai-cn', script: { state: state.signedIn, balance: { ok: true, value: null }, route: { kimi: { status: 200, body: { ok: false, provider: 'kimi', error: 'missing-credential', refs: ['MOONSHOTAI_CN_API_KEY'] } } } } },
  { label: '当前供应商无余额接口', provider: 'openai-codex', script: { state: state.signedIn, balance: { ok: true, value: null } } },
  { label: '未登录', provider: 'deepseek-account', script: { state: state.signedOut, balance: { ok: true, value: null } } },
  { label: '读取失败', provider: 'deepseek-account', script: { state: state.signedIn, balance: { ok: true, value: { status: 'failed' } } } },
  { label: '无账号服务', provider: 'deepseek-account', bare: true, script: { state: state.signedIn, balance: ready('6.87') } },
]

/* ---------- pages ---------- */

const PAGE_CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
  'font-family:var(--dsw-font-family,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);padding:28px 32px}',
  '.stage{--dsh-composer-card-max-width:760px;display:flex;flex-direction:column;gap:22px;align-items:flex-start}',
  '.row{display:flex;align-items:center;gap:18px}',
  '.label{width:150px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.pill{height:28px;display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:var(--dsw-radius-sm);',
  'color:var(--dsw-alias-label-secondary);font-size:13px;white-space:nowrap}',
  '.pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.seat{height:28px;display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:13px;white-space:nowrap}',
  '.seat b{font-weight:400;color:var(--dsw-alias-label-primary)}',
  '.seat i{font-style:normal;color:var(--dsw-alias-label-tertiary)}',
  '.send{width:28px;height:28px;border-radius:999px;display:grid;place-items:center;flex:none;',
  'background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted);font-size:14px}',
  /* the readout is positioned against the viewport on the page: place it inline for review */
  '.stage .dbb-tip{position:static;transform:none;left:auto!important;top:auto!important}',
].join('')

/** The plugin's own sheet, captured from the first `apply` (it is the same every time). */
let pluginCss = ''
const capturePluginCss = () => {
  if (pluginCss === '' && appendedStyles.length > 0) pluginCss = appendedStyles[appendedStyles.length - 1].textContent
}

const page = (title, body, dark) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${themeCss}</style>
<style>${inputBarCss}</style>
<style>${pluginCss}</style>
<style>${PAGE_CSS}</style>
</head>
<body${dark ? ' data-ds-dark-theme' : ''}>
${body}
</body></html>
`

/** The composer, rebuilt with the host's own InputBar rules and the real gauge inside. */
function composerHtml (gauge) {
  const cls = (suffix) => `${composerPrefix}_${suffix}`
  return `<div class="stage"><div class="${cls('card')}">
  <div class="${cls('input')}">描述你想要构建的内容，/ 调用指令，@ 文件或对话</div>
  <div class="${cls('row')}">
    <div class="${cls('tools')}">
      <button class="${cls('add')}" aria-label="指令">+</button>
      <div class="${cls('modes')}"><span class="pill">工作区内修改 ⌄</span></div>
      ${gauge}
    </div>
    <div class="${cls('trailing')}">
      <div class="${cls('standardControls')}">
        <span class="seat"><b>DeepSeek-V41-Flash</b><i>High</i></span>
      </div>
      <button class="${cls('primary')}" aria-label="发送">↑</button>
    </div>
  </div>
</div></div>`
}

const outputs = []
for (const dark of [false, true]) {
  const suffix = dark ? 'dark' : 'light'
  const composer = await renderGauge({ state: state.signedIn, balance: ready('6.87') })
  outputs.push([`composer-${suffix}.html`, page('余额电池 · 输入框', composerHtml(composer), dark)])
  if (!dark) {
    const zoom = await renderGauge({ state: state.signedIn, balance: ready('6.87') })
    outputs.push(['zoom-light.html', page('余额电池 · 放大', `<div class="stage" style="zoom:3"><div style="padding:6px">${zoom}</div></div>`, false)])
  }

  const rowHtml = []
  for (const entry of STATES) {
    const gauge = await renderGauge(entry.script, { bare: entry.bare === true, provider: entry.provider })
    rowHtml.push(`<div class="row"><span class="label">${escapeHtml(entry.label)}</span>${gauge}</div>`)
  }
  const openTip = await renderGauge({ state: state.signedIn, balance: ready('6.87') }, { open: true })
  const openTipKimi = await renderGauge(
    { state: state.signedIn, balance: { ok: true, value: null }, route: kimiRoute(5.26872, 0.13433, 5.1343904) },
    { open: true, provider: 'moonshotai-cn' },
  )
  const openTipOut = await renderGauge({ state: state.signedOut, balance: { ok: true, value: null } }, { open: true })
  const statesHtml = `<div class="stage">
${rowHtml.join('\n')}
<div class="row" style="align-items:flex-start"><span class="label">悬浮读数</span><div style="display:flex;gap:18px;flex-wrap:wrap">${openTip}${openTipKimi}${openTipOut}</div></div>
</div>`
  outputs.push([`states-${suffix}.html`, page('余额电池 · 各状态', statesHtml, dark)])
}

mkdirSync(OUT, { recursive: true })
for (const [name, html] of outputs) {
  writeFileSync(`${OUT}/${name}`, html)
  console.log(`wrote test/preview/${name}`)
}
