/**
 * DOM-free smoke test for the `dsh-balance-battery` client bundle.
 *
 * It stubs the page module table (React, react-dom, window.__ModuleLoader__,
 * document, fetch, localStorage), loads the real client.js, runs the real
 * `apply` against a fake client context — a scripted `remote.account`, a
 * scripted `ctx.get('modelDirectories')` store, and scripted Host route
 * replies — and renders the gauge with a single-pass fake React. That covers
 * the parts a screenshot cannot: decimal parsing, wallet choice, the manual
 * source switch (first-run adoption, cycling, chips, persistence), the
 * available-total arithmetic, the ratio thresholds, and every failure branch.
 *
 * Run: node test/balance-smoke.mjs
 */

/* ---------- fake React ---------- */

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
    useRef (initial) {
      const at = cursor++
      if (!(at in cells)) cells[at] = { current: initial }
      return cells[at]
    },
    useMemo (compute) { cursor += 1; return compute() },
    useCallback (fn) { cursor += 1; return fn },
    useEffect (fn) { cursor += 1; pending.push(fn); return undefined },
    useLayoutEffect (fn) { cursor += 1; pending.push(fn); return undefined },
    useId () { const at = cursor++; return `r${at}` },
    useSyncExternalStore (subscribe, getSnapshot) { cursor += 1; return getSnapshot() },
  }
  return {
    api,
    /** Begin a render pass: hook order restarts, effect queue clears. */
    begin () { cursor = 0; pending.length = 0 },
    /** Run the effects the pass collected. */
    flush () {
      const queued = pending.splice(0, pending.length)
      for (const fn of queued) fn()
    },
    /** Hook cursor position, so an expanded child component cannot disturb it. */
    mark: () => cursor,
    rewind: (at) => { cursor = at },
    /** Drop every hook cell: a second mount is not a re-render of the first. */
    reset () { cells.length = 0; cursor = 0; pending.length = 0 },
  }
}

/* ---------- fake page ---------- */

const noop = () => {}
const listeners = new Map()
let appendedStyles = []
let loaded = null
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: { load (definition) { loaded = definition } },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: (type, fn) => { listeners.set(`window:${type}`, fn) },
  removeEventListener: (type) => { listeners.delete(`window:${type}`) },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
    clear: () => storage.clear(),
  },
}
globalThis.document = {
  visibilityState: 'visible',
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove: noop }),
  head: { append: (tag) => appendedStyles.push(tag) },
  body: {},
  addEventListener: (type, fn) => { listeners.set(`document:${type}`, fn) },
  removeEventListener: (type) => { listeners.delete(`document:${type}`) },
}

/* ---------- scripted Host balance routes ---------- */

const PIN_KEY = 'dsh-balance-battery/source'
const routeCalls = []
let networkDown = false
let routeScripts = {
  kimi: {
    status: 200,
    body: {
      ok: true,
      provider: 'kimi',
      ref: 'MOONSHOTAI_CN_API_KEY',
      currency: 'CNY',
      total: 5.26872,
      recharge: 0.13433,
      bonus: 5.1343904,
      topUpUrl: 'https://platform.kimi.com/console/account',
      at: 1_700_000_000_000,
    },
  },
  deepseek: {
    status: 200,
    body: {
      ok: true,
      provider: 'deepseek',
      ref: 'DEEPSEEK_API_KEY',
      currency: 'CNY',
      total: 33.32,
      recharge: 10.07,
      bonus: 23.24,
      topUpUrl: 'https://platform.deepseek.com/top_up',
      at: 1_700_000_000_000,
    },
  },
}
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), 'http://127.0.0.1:2038')
  routeCalls.push(parsed.pathname + parsed.search)
  if (networkDown) throw new Error('offline')
  const key = parsed.pathname.split('/').pop()
  const script = routeScripts[key] ?? { status: 404, body: { ok: false, error: 'unknown-provider' } }
  return {
    status: script.status,
    ok: script.status >= 200 && script.status < 300,
    json: async () => script.body,
  }
}

const fakeReact = createFakeReact()
const requires = {
  react: fakeReact.api,
  'react-dom': { createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }) },
}

await import(new URL('../client.js', import.meta.url).href)

/* ---------- checks ---------- */

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures.push(label); console.log(`  FAIL ${label}${detail === '' ? '' : `  — ${detail}`}`) }
}

console.log('module loader')
check('bundle registers a lazy factory', loaded !== null)
check('factory id equals the package name', loaded?.id === 'dsh-balance-battery', String(loaded?.id))

const plugin = loaded.factory((specifier) => {
  if (specifier in requires) return requires[specifier]
  throw new Error(`unexpected require(${specifier})`)
})
check('module exports inject + apply', typeof plugin.apply === 'function' && Array.isArray(plugin.inject))
check('module-level inject declares every required service', plugin.inject.join(',') === 'slots,locale,remote,remote.account', plugin.inject.join(','))

/* ---------- fake client context ---------- */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const dictionaries = {}
let activeLocale = 'zh'
const locale = {
  register: (ns, dict) => { dictionaries[ns] = dict; return () => { delete dictionaries[ns] } },
  bind: (ns) => (key, params) => {
    const dict = dictionaries[ns] ?? {}
    let text = (dict[activeLocale] ?? dict.zh ?? {})[key] ?? key
    if (params !== undefined) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
    return text
  },
  getSnapshot: () => ({ active: activeLocale }),
}

/** Scripted account Remote namespace. */
let stateReply = { ok: true, value: { status: 'credential-stored', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } } }
let balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '6.8700000000000000' }], bonusWallets: [{ currency: 'CNY', balance: '0E-16' }] } }
const calls = { state: 0, balance: 0, metadata: null }
const account = {
  getState: async () => { calls.state += 1; return stateReply },
  getBalance: async (metadata) => { calls.balance += 1; calls.metadata = metadata; return balanceReply },
}

/** Scripted per-session model directory: the seat's source of truth. */
function createDirectoryStore (provider) {
  return {
    snapshot: { current: { provider, model: 'deepseek-flash', reasoningEffort: 'high' }, groups: [], status: 'ready', error: null },
    listeners: new Set(),
    subscribe (listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) },
    getSnapshot () { return this.snapshot },
    setProvider (next) {
      this.snapshot = { ...this.snapshot, current: { ...this.snapshot.current, provider: next } }
      for (const listener of [...this.listeners]) listener()
    },
  }
}
const directoryStore = createDirectoryStore('deepseek-account')
const modelDirectories = { directoryFor: (sessionId) => (sessionId === 'session-1' ? { store: directoryStore } : null) }

const SEAT_SLOT = 'conversation.input.left'
let registration = null
let injectedKey = null
const slots = {
  inject: (key, register) => { if (key === SEAT_SLOT) injectedKey = key; register() },
  register: (options, component) => { if (options.name === SEAT_SLOT) registration = { options, component }; return () => {} },
}

const effects = []
const ctx = {
  slots,
  locale,
  remote: { account },
  get: (nameOf) => (nameOf === 'modelDirectories' ? modelDirectories : undefined),
  effect: (fn, label) => { effects.push({ label, disposer: fn() }) },
}

console.log('\napply()')
plugin.apply(ctx)
check('style sheet + dictionaries + channel registered as effects', effects.length === 3, effects.map((effect) => effect.label).join(' | '))
check('style sheet is appended with the plugin tag', appendedStyles.length === 1 && appendedStyles[0].dataset.plugin === 'dsh-balance-battery', String(appendedStyles.length))
const css = appendedStyles[0]?.textContent ?? ''
check('style sheet paints the fill from the host level tokens', css.includes('.dbb-fill') && css.includes('--dsw-alias-state-warn-primary') && css.includes('--dsw-alias-state-error-primary'))
check('style sheet caps the bubble with a fixed width matching the clamp constant', css.includes('width:244px'))
check('style sheet draws one ruler tick per unit', css.includes('repeating-linear-gradient') && css.includes('calc(10% - 1px)'), css.slice(css.indexOf('dbb-ticks'), css.indexOf('dbb-ticks') + 200))
check('the cell is long enough to count ten units', css.includes('.dbb-shell{') && css.includes('width:82px'))
check('style sheet gives the provider tag its own quieter type', css.includes('.dbb-brand{') && css.includes('--dsw-alias-label-tertiary'))
check('style sheet styles the manual source chips', css.includes('.dbb-tipChip{') && css.includes('.dbb-tipMenu{'), css.slice(css.indexOf('dbb-tipMenu'), css.indexOf('dbb-tipMenu') + 160))
check('slot inject targets the composer tool row', injectedKey === 'conversation.input.left', String(injectedKey))
const options = registration?.options ?? {}
check('register names the same slot and an id', options.name === 'conversation.input.left' && options.id === 'balance-battery', `${options.name}/${options.id}`)
check('register binds this plugin locale namespace', options.locale === 'balance-battery', String(options.locale))

const face = options.inject('session-1')
check('injected face carries the shared channel, translator and provider tracker', typeof face.channel?.refresh === 'function' && typeof face.t === 'function' && typeof face.provider?.getSnapshot === 'function')
check('the channel exposes the manual switch surface', typeof face.channel?.select === 'function' && typeof face.channel?.cycle === 'function' && typeof face.channel?.getPin === 'function')
check('the tracker resolves the session provider from the model directory', face.provider.getSnapshot().kind === 'account' && face.provider.getSnapshot().providerId === 'deepseek-account', JSON.stringify(face.provider.getSnapshot()))

/* ---------- render harness ---------- */

const RECT = { left: 500, top: 700, width: 96, height: 28, right: 596, bottom: 728 }
const stubs = new Map()
const stubFor = (className) => {
  if (stubs.has(className)) return stubs.get(className)
  const stub = {
    className,
    getBoundingClientRect: () => RECT,
    contains: () => false,
  }
  stubs.set(className, stub)
  return stub
}
/**
 * Flatten a rendered tree. The plugin's stateless child component (the bubble)
 * arrives as a function-type element with no real renderer behind it, so it is
 * expanded here — once per element, with the hook cursor restored, so expansion
 * cannot disturb the parent's hook cells.
 */
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
const allByClass = (tree, className) => flat(tree).filter((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(className))
const textOf = (tree) => flat(tree).flatMap((node) => node.children.filter((child) => typeof child === 'string')).join('|')
/** The label's visible text: `Brand amount`, independent of DOM nesting. */
const labelText = (tree) => {
  const label = byClass(tree, 'dbb-label')
  if (label === undefined) return ''
  return label.children.map((child) => (typeof child === 'string' ? child : (child.children ?? []).join(''))).join(' ')
}
/** The bubble's source chips: label text per chip. */
const chipsOf = (tip) => allByClass(tip, 'dbb-tipChip').map((chip) => ({
  label: (chip.children ?? []).join(''),
  props: chip.props,
}))

const renderComponent = (component, props) => {
  stubs.clear()
  fakeReact.begin()
  const tree = component(props)
  for (const node of flat(tree)) {
    const ref = node.props?.ref
    if (ref === undefined || ref === null) continue
    const stub = stubFor(node.props.className)
    if (typeof ref === 'function') ref(stub)
    else if (typeof ref === 'object') ref.current = stub
  }
  fakeReact.flush()
  return tree
}
const render = (props = face) => renderComponent(registration.component, props)
/** Render after the 30ms energise delay has fired. */
const renderSettled = async (props = face) => {
  await new Promise((resolve) => setTimeout(resolve, 40))
  return render(props)
}
const fillWidth = (tree) => byClass(tree, 'dbb-fill')?.props.style.width
const gauge = (tree) => byClass(tree, 'dbb-root')

/* ---------- initial read: DeepSeek account (first-run adoption) ---------- */

console.log('\ninitial read — DeepSeek account, ¥6.87 total')
let tree = render()
check('the first paint is an empty cell so the fill can grow', fillWidth(tree) === '0%', String(fillWidth(tree)))
await settle()
check('the first render starts the account read', calls.state === 1 && calls.balance === 1, `${calls.state}/${calls.balance}`)
check('the read carries the account client metadata', calls.metadata?.version === '0.2.0-rc.2' && calls.metadata?.locale === 'zh' && Number.isInteger(calls.metadata?.timezoneOffsetSeconds), JSON.stringify(calls.metadata))
check('the first activation adopts the model source and stores it', storage.get(PIN_KEY) === 'account', String(storage.get(PIN_KEY)))
check('the channel pin reads back the adopted kind', face.channel.getPin() === 'account', String(face.channel.getPin()))
tree = await renderSettled()
const root = gauge(tree)
check('the gauge renders a shell, a body, a nub and a fill', ['dbb-shell', 'dbb-body', 'dbb-nub', 'dbb-fill'].every((name) => byClass(tree, name) !== undefined))
check('the cell carries the per-unit ruler layer', byClass(tree, 'dbb-ticks') !== undefined)
check('the fill is proportional to the balance', fillWidth(tree) === '68.7%', String(fillWidth(tree)))
check('a healthy balance uses the success level', root.props['data-level'] === 'high', String(root.props['data-level']))
check('the gauge names its source for styling/tests', root.props['data-provider'] === 'account', String(root.props['data-provider']))
check('the caption names the account source and the exact amount', labelText(tree) === 'DeepSeek 账号 ¥6.87', labelText(tree))
check('the gauge is a button with the amount in its accessible name', root.type === 'button' && root.props['aria-label'].includes('DeepSeek') && root.props['aria-label'].includes('¥6.87') && root.props['aria-label'].includes('¥10.00'), String(root.props['aria-label']))
check('the accessible name offers switching, not refreshing', root.props['aria-label'].includes('切换'), String(root.props['aria-label']))
check('the gauge reports its phase for styling', root.props['data-phase'] === 'ready' && root.props['data-off'] === 'false')
check('no bubble before hover', byClass(tree, 'dbb-tip') === undefined)

console.log('\nrender — bubble')
root.props.onPointerEnter()
tree = render()
const tip = byClass(tree, 'dbb-tip')
check('hovering opens the readout through a portal', flat(tree).some((node) => node.type === 'portal') && tip !== undefined)
check('the readout is a dialog, not a plain tooltip', tip.props.role === 'dialog', String(tip.props.role))
check('the readout names the source and the full-scale amount', textOf(tip).includes('DeepSeek 账号 可用余额') && textOf(tip).includes('¥10.00'), textOf(tip))
check('the readout shows the percentage of the cell', textOf(tip).includes('69%'), textOf(tip))
check('the readout meter carries the same ruler', byClass(tip, 'dbb-tipTicks') !== undefined)
check('the readout splits the topped-up balance', textOf(tip).includes('充值余额') && textOf(tip).includes('¥6.87'), textOf(tip))
check('the readout hides a zero granted balance', !textOf(tip).includes('赠送余额'), textOf(tip))
check('the readout offers the Platform top-up link', flat(tip).some((node) => node.props.href === 'https://platform.deepseek.com/top_up'))
const chips = chipsOf(tip)
check('the readout offers one chip per source plus refresh', chips.length === 4, JSON.stringify(chips.map((chip) => chip.label)))
check('the chips name all three sources', ['DeepSeek 账号', 'DeepSeek API', 'Kimi'].every((label) => chips.some((chip) => chip.label === label)), JSON.stringify(chips.map((chip) => chip.label)))
check('the current source chip is marked', chips.find((chip) => chip.props['data-current'] === 'true')?.label === 'DeepSeek 账号', JSON.stringify(chips.filter((chip) => chip.props['data-current'] === 'true')))
check('the readout is positioned above the gauge and clamped to the viewport', tip.props['data-placement'] === 'top' && tip.props.style.top === '692px' && tip.props.style.left === '426px', `${tip.props.style.left}/${tip.props.style.top}`)
check('the gauge reports itself expanded while the readout is open', gauge(tree).props['aria-expanded'] === true)
check('the readout uses the same level colour as the cell', tip.props['data-level'] === 'high')

console.log('\nmanual mode — the battery no longer follows the model')
const followedCalls = routeCalls.length
directoryStore.setProvider('moonshotai-cn')
tree = render()
check('the tracker itself follows the model directory', face.provider.getSnapshot().providerId === 'moonshotai-cn', JSON.stringify(face.provider.getSnapshot()))
await settle()
tree = await renderSettled()
check('a pinned battery keeps showing the chosen source', labelText(tree) === 'DeepSeek 账号 ¥6.87', labelText(tree))
check('no Kimi read was started by the model switch', routeCalls.length === followedCalls, `${followedCalls} -> ${routeCalls.length}`)

console.log('\nclick — cycle the source (account → API)')
gauge(tree).props.onClick({ stopPropagation: noop })
tree = render()
check('one click moves to the next source', gauge(tree).props['data-provider'] === 'deepseek', String(gauge(tree).props['data-provider']))
await settle()
tree = await renderSettled()
check('the DeepSeek API-key route is read', routeCalls.includes('/dsh-balance-battery/deepseek'), routeCalls.slice(-4).join(','))
check('the caption shows the API-key total', labelText(tree) === 'DeepSeek API ¥33.32', labelText(tree))
check('an over-full total clamps the cell at 100%', fillWidth(tree) === '100%', String(fillWidth(tree)))
gauge(tree).props.onPointerEnter()
tree = render()
const deepTip = byClass(tree, 'dbb-tip')
check('the DeepSeek readout splits top-ups and grants', textOf(deepTip).includes('充值余额') && textOf(deepTip).includes('¥10.07') && textOf(deepTip).includes('赠送余额') && textOf(deepTip).includes('¥23.24'), textOf(deepTip))
check('the DeepSeek readout caps the percentage', textOf(deepTip).includes('100%'), textOf(deepTip))
const deepChips = chipsOf(deepTip)
check('the API source chip is marked after the cycle', deepChips.find((chip) => chip.props['data-current'] === 'true')?.label === 'DeepSeek API', JSON.stringify(deepChips.filter((chip) => chip.props['data-current'] === 'true')))

console.log('\nchips — the refresh button re-reads the current source')
const apiReads = routeCalls.filter((call) => call.startsWith('/dsh-balance-battery/deepseek')).length
const refreshChip = chipsOf(deepTip).find((chip) => chip.label === '刷新')
if (refreshChip === undefined) throw new Error('refresh chip missing from the readout')
refreshChip.props.onClick({ stopPropagation: noop })
check('the refresh click pulses the cell', gauge(render()).props['data-busy'] === 'true')
await settle()
tree = await renderSettled()
check('the refresh click bypasses the Host cache', routeCalls.filter((call) => call.startsWith('/dsh-balance-battery/deepseek')).length === apiReads + 1 && routeCalls.some((call) => call === '/dsh-balance-battery/deepseek?fresh=1'), routeCalls.slice(-3).join(','))
check('the pulse ends when the read settles', gauge(tree).props['data-busy'] === 'false')

console.log('\nclick — cycle continues through Kimi and wraps')
gauge(tree).props.onClick({ stopPropagation: noop })
await settle()
tree = await renderSettled()
check('cycling reaches Kimi', gauge(tree).props['data-provider'] === 'kimi', String(gauge(tree).props['data-provider']))
check('the Kimi provider asks the Host route', routeCalls.some((call) => call.startsWith('/dsh-balance-battery/kimi')), routeCalls.slice(-4).join(','))
check('the caption switches to Kimi and its spendable total', labelText(tree) === 'Kimi ¥5.27', labelText(tree))
check('the fill follows the Kimi balance', fillWidth(tree) === '52.7%', String(fillWidth(tree)))
check('the Kimi cell keeps the healthy level at 52.7%', gauge(tree).props['data-level'] === 'high', String(gauge(tree).props['data-level']))
gauge(tree).props.onPointerEnter()
tree = render()
const kimiTip = byClass(tree, 'dbb-tip')
check('the Kimi readout splits cash and vouchers', textOf(kimiTip).includes('现金余额') && textOf(kimiTip).includes('¥0.13') && textOf(kimiTip).includes('代金券') && textOf(kimiTip).includes('¥5.13'), textOf(kimiTip))
check('the Kimi readout links to the Kimi console', flat(kimiTip).some((node) => node.props.href === 'https://platform.kimi.com/console/account'))
check('the Kimi readout is titled for Kimi', textOf(kimiTip).includes('Kimi 可用余额'), textOf(kimiTip))
check('the current source chip is marked on Kimi too', chipsOf(kimiTip).find((chip) => chip.props['data-current'] === 'true')?.label === 'Kimi', JSON.stringify(chipsOf(kimiTip).filter((chip) => chip.props['data-current'] === 'true')))
gauge(tree).props.onClick({ stopPropagation: noop })
tree = render()
check('cycling wraps Kimi back to the account source', gauge(tree).props['data-provider'] === 'account', String(gauge(tree).props['data-provider']))
await settle()

console.log('\nmanual mode — model switches stay ignored after cycling')
face.channel.select('kimi')
await settle()
tree = await renderSettled()
check('a picked source can be re-entered from the chips or cycle', labelText(tree) === 'Kimi ¥5.27', labelText(tree))
const kimiCalls = routeCalls.filter((call) => call.startsWith('/dsh-balance-battery/kimi')).length
directoryStore.setProvider('deepseek-account')
tree = render()
await settle()
tree = await renderSettled()
check('the battery stays on the picked source', labelText(tree) === 'Kimi ¥5.27', labelText(tree))
check('no extra Kimi read was started', routeCalls.filter((call) => call.startsWith('/dsh-balance-battery/kimi')).length === kimiCalls, String(kimiCalls))

console.log('\nprovider switch — unsupported provider before any pin')
storage.clear()
const routeCountBefore = routeCalls.length
const unsupportedMount = mountUnsupported()
let unsupportedTree = unsupportedMount.render()
await settle()
unsupportedTree = await unsupportedMount.settled()
check('no balance route is called for an unsupported provider', routeCalls.length === routeCountBefore, `${routeCountBefore} -> ${routeCalls.length}`)
check('the caption says there is no balance API', labelText(unsupportedTree) === '当前供应商 无接口', labelText(unsupportedTree))
check('the empty cell is dimmed', gauge(unsupportedTree).props['data-phase'] === 'unsupported' && gauge(unsupportedTree).props['data-off'] === 'true' && gauge(unsupportedTree).props['data-level'] === 'idle')
gauge(unsupportedTree).props.onPointerEnter()
unsupportedTree = unsupportedMount.render()
check('the readout explains the unsupported provider', textOf(byClass(unsupportedTree, 'dbb-tip')).includes('没有余额接口'), textOf(byClass(unsupportedTree, 'dbb-tip')))
gauge(unsupportedTree).props.onClick({ stopPropagation: noop })
unsupportedTree = unsupportedMount.render()
check('a click still cycles away from an unsupported cell', gauge(unsupportedTree).props['data-provider'] === 'account', String(gauge(unsupportedTree).props['data-provider']))
check('cycling away from unsupported pins the account source', storage.get(PIN_KEY) === 'account', String(storage.get(PIN_KEY)))

console.log('\nmanual choice — a stored choice survives a restart')
storage.set(PIN_KEY, 'kimi')
const pinnedMount = mountFresh('deepseek-account')
pinnedMount.render()
await settle()
const pinnedTree = await pinnedMount.settled()
check('a stored choice is restored on a fresh mount', labelText(pinnedTree) === 'Kimi ¥5.27', labelText(pinnedTree))
check('the restored choice is not replaced by the model source', gauge(pinnedTree).props['data-provider'] === 'kimi', String(gauge(pinnedTree).props['data-provider']))
storage.clear()

console.log('\nback to the account source for the arithmetic checks')
face.channel.select('account')
await settle()

/* ---------- thresholds and arithmetic ---------- */

console.log('\naccount arithmetic — recharge + grants')
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '3.00' }], bonusWallets: [] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('3.00 of 10 sits at the warning level', gauge(tree).props['data-level'] === 'mid', String(gauge(tree).props['data-level']))
check('the fill follows the smaller amount', fillWidth(tree) === '30%', String(fillWidth(tree)))
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '1.50' }], bonusWallets: [] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('1.50 of 10 sits at the low level', gauge(tree).props['data-level'] === 'low', String(gauge(tree).props['data-level']))
gauge(tree).props.onPointerEnter()
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '25.991' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('the caption sums recharge and grants', labelText(tree) === 'DeepSeek 账号 ¥30.99', labelText(tree))
check('an over-full balance clamps the cell at 100%', fillWidth(tree) === '100%', String(fillWidth(tree)))
const tipFull = byClass(tree, 'dbb-tip')
check('the readout shows the granted component', textOf(tipFull).includes('赠送余额') && textOf(tipFull).includes('¥5.00'), textOf(tipFull))
check('the readout still shows the topped-up component', textOf(tipFull).includes('充值余额') && textOf(tipFull).includes('¥25.99'), textOf(tipFull))

console.log('\naccount arithmetic — wallet choice and parsing')
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '2.00' }, { currency: 'CNY', balance: '0E-16' }, { currency: 'USD', balance: '9.00' }], bonusWallets: [{ currency: 'USD', balance: '3.00' }] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('CNY wallets are summed and USD is ignored for the ¥ cell', labelText(tree) === 'DeepSeek 账号 ¥2.00', labelText(tree))
check('a granted balance in another currency is ignored', byClass(tree, 'dbb-tip') === undefined || !textOf(byClass(tree, 'dbb-tip')).includes('$3.00'))
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'USD', balance: '4.5' }], bonusWallets: [] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('a USD-only account falls back to its own symbol', labelText(tree) === 'DeepSeek 账号 $4.50', labelText(tree))
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: 'not-a-number' }], bonusWallets: [] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('a malformed decimal is refused as no-balance rather than shown as 0', labelText(tree) === 'DeepSeek 账号 无余额' && gauge(tree).props['data-phase'] === 'empty', labelText(tree))
balanceReply = { ok: true, value: { status: 'ready', value: [], bonusWallets: [] } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('an empty wallet list is no-balance, not ¥0.00', labelText(tree) === 'DeepSeek 账号 无余额' && gauge(tree).props['data-phase'] === 'empty' && gauge(tree).props['data-off'] === 'true', labelText(tree))
gauge(tree).props.onPointerEnter()
tree = render()
check('the readout explains the empty wallet list', textOf(byClass(tree, 'dbb-tip')).includes('没有返回任何可用余额'), textOf(byClass(tree, 'dbb-tip')))

/* ---------- failure branches ---------- */

console.log('\nstate — signed out')
stateReply = { ok: true, value: { status: 'signed-out', attempt: null, links: { topUpUrl: 'https://platform.deepseek.com/top_up' } } }
balanceReply = { ok: true, value: null }
const beforeSignedOut = calls.balance
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('a signed-out account reads state only, never the balance', calls.balance === beforeSignedOut, `${beforeSignedOut} -> ${calls.balance}`)
check('the caption says so instead of showing a zero', labelText(tree) === 'DeepSeek 账号 未登录', labelText(tree))
check('the empty cell is dimmed', gauge(tree).props['data-phase'] === 'signed-out' && gauge(tree).props['data-off'] === 'true')
gauge(tree).props.onPointerEnter()
tree = render()
check('the readout explains why', textOf(byClass(tree, 'dbb-tip')).includes('未登录'), textOf(byClass(tree, 'dbb-tip')))
check('the readout still offers the Platform page when the Host supplies one', flat(byClass(tree, 'dbb-tip')).some((node) => node.props.href === 'https://platform.deepseek.com/top_up'))

console.log('\nstate — Platform failures')
stateReply = { ok: true, value: { status: 'credential-stored', links: { topUpUrl: 'https://platform.deepseek.com/top_up' } } }
balanceReply = { ok: true, value: { status: 'failed' } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('a failed Platform read is not a zero balance', labelText(tree) === 'DeepSeek 账号 读取失败', labelText(tree))
balanceReply = { ok: false, error: { code: 'REMOTE_ERROR', message: 'boom' } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('a Remote failure keeps the same explicit caption', labelText(tree) === 'DeepSeek 账号 读取失败', labelText(tree))
gauge(tree).props.onPointerEnter()
check('the readout carries the failure text', textOf(byClass(render(), 'dbb-tip')).includes('读取失败'), textOf(byClass(render(), 'dbb-tip')))

console.log('\nstate — a good number survives a transient failure')
balanceReply = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '8.10' }], bonusWallets: [] } }
face.channel.refresh('account')
await settle()
await renderSettled()
balanceReply = { ok: false, error: { code: 'TIMEOUT', message: 'slow' } }
face.channel.refresh('account')
await settle()
tree = await renderSettled()
check('the last good amount stays on the gauge', labelText(tree) === 'DeepSeek 账号 ¥8.10', labelText(tree))
check('its fill is preserved too', fillWidth(tree) === '81%', String(fillWidth(tree)))

console.log('\nlanguage')
activeLocale = 'en'
tree = await renderSettled()
check('the caption is locale-neutral', labelText(tree) === 'DeepSeek account ¥8.10', labelText(tree))
gauge(tree).props.onPointerEnter()
check('the readout follows the active language', textOf(byClass(render(), 'dbb-tip')).includes('available balance'), textOf(byClass(render(), 'dbb-tip')))
check('the source chips follow the active language', chipsOf(byClass(render(), 'dbb-tip')).some((chip) => chip.label === 'DeepSeek API'), JSON.stringify(chipsOf(byClass(render(), 'dbb-tip')).map((chip) => chip.label)))
check('the accessible name follows the active language', gauge(render()).props['aria-label'].startsWith('DeepSeek account available balance'), String(gauge(render()).props['aria-label']))
activeLocale = 'zh'

/* ---------- fresh mounts: cold-start failures and a bare page ---------- */

/**
 * Mount a second plugin instance with its own channel and provider.
 * The main instance above keeps running; a fresh mount is how a cold page
 * (nothing cached) is modelled.
 */
function mountFresh (provider, { remote = { account }, directories = true } = {}) {
  const store = createDirectoryStore(provider)
  let localRegistration = null
  const localEffects = []
  const localCtx = {
    slots: {
      inject: (key, register) => { if (key === SEAT_SLOT) register() },
      register: (opts, component) => { if (opts.name === SEAT_SLOT) localRegistration = { options: opts, component } },
    },
    locale,
    remote,
    get: (nameOf) => (directories && nameOf === 'modelDirectories' ? { directoryFor: () => ({ store }) } : undefined),
    effect: (fn, label) => localEffects.push({ label, disposer: fn() }),
  }
  plugin.apply(localCtx)
  const localFace = localRegistration.options.inject('session-fresh')
  fakeReact.reset()
  return {
    face: localFace,
    store,
    effects: localEffects,
    render: () => renderComponent(localRegistration.component, localFace),
    settled: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return renderComponent(localRegistration.component, localFace)
    },
  }
}

/** A mount whose model directory points at a provider without a balance API. */
function mountUnsupported () {
  return mountFresh('openai-codex')
}

console.log('\nstate — Kimi cold read failures')
storage.clear()
routeScripts.kimi = { status: 200, body: { ok: false, provider: 'kimi', error: 'missing-credential', refs: ['MOONSHOTAI_CN_API_KEY'] } }
const kimiMount = mountFresh('moonshotai-cn')
let kimiTree = kimiMount.render()
await settle()
kimiTree = await kimiMount.settled()
check('a missing Kimi key is a failed read, not a zero', labelText(kimiTree) === 'Kimi 读取失败', labelText(kimiTree))
gauge(kimiTree).props.onPointerEnter()
kimiTree = kimiMount.render()
check('the readout names the credential that is missing', textOf(byClass(kimiTree, 'dbb-tip')).includes('MOONSHOTAI_CN_API_KEY'), textOf(byClass(kimiTree, 'dbb-tip')))
routeScripts.kimi = { status: 200, body: { ok: false, provider: 'kimi', error: 'unauthorized' } }
kimiMount.face.channel.refresh('kimi')
await settle()
kimiTree = await kimiMount.settled()
gauge(kimiTree).props.onPointerEnter()
kimiTree = kimiMount.render()
check('a rejected Kimi key says so', textOf(byClass(kimiTree, 'dbb-tip')).includes('401'), textOf(byClass(kimiTree, 'dbb-tip')))
routeScripts.kimi = { status: 200, body: { ok: false, provider: 'kimi', error: 'rate-limited' } }
kimiMount.face.channel.refresh('kimi')
await settle()
kimiTree = await kimiMount.settled()
gauge(kimiTree).props.onPointerEnter()
kimiTree = kimiMount.render()
check('a rate-limited Kimi read says so', textOf(byClass(kimiTree, 'dbb-tip')).includes('限流'), textOf(byClass(kimiTree, 'dbb-tip')))
networkDown = true
kimiMount.face.channel.refresh('kimi')
await settle()
kimiTree = await kimiMount.settled()
check('an offline Kimi look stays failed', labelText(kimiTree) === 'Kimi 读取失败', labelText(kimiTree))
networkDown = false
routeScripts.kimi = {
  status: 200,
  body: { ok: true, provider: 'kimi', currency: 'CNY', total: 2.5, recharge: null, bonus: null, topUpUrl: 'https://platform.kimi.com/console/account' },
}
kimiMount.face.channel.refresh('kimi')
await settle()
kimiTree = await kimiMount.settled()
check('a recovered Kimi read shows the number again', labelText(kimiTree) === 'Kimi ¥2.50', labelText(kimiTree))

console.log('\nstate — no account service')
storage.clear()
const bareMount = mountFresh('deepseek-account', { remote: {}, directories: false })
bareMount.render()
await settle()
const bareTree = await bareMount.settled()
check('a page without remote.account still registers a gauge', bareTree !== null)
check('it reports the missing service instead of guessing a balance', labelText(bareTree) === 'DeepSeek 账号 不可用', labelText(bareTree))

console.log('\ndictionaries')
const zhKeys = Object.keys(dictionaries['balance-battery'].zh).sort()
const enKeys = Object.keys(dictionaries['balance-battery'].en).sort()
check('en covers the zh key set exactly', zhKeys.join(',') === enKeys.join(','), `${zhKeys.length} vs ${enKeys.length}`)
check('no dictionary value is left empty', Object.values(dictionaries['balance-battery'].zh).every((value) => typeof value === 'string' && value.length > 0))

/* ---------- teardown ---------- */

for (const effect of effects) effect.disposer?.()
for (const effect of unsupportedMount.effects) effect.disposer?.()
for (const effect of pinnedMount.effects) effect.disposer?.()
for (const effect of kimiMount.effects) effect.disposer?.()
for (const effect of bareMount.effects) effect.disposer?.()

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
