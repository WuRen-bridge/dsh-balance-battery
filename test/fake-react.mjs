/**
 * A tiny React stand-in shared by `balance-smoke.mjs` and `preview.mjs`.
 *
 * It implements just the hooks the plugin uses, with a single-pass renderer:
 * `begin()` resets the hook cursor for the next pass, `flush()` runs the
 * effects that pass collected, and `reset()` drops every cell for a fresh
 * mount. One copy here means a hook-behaviour fix lands in both tools.
 */

/**
 * Create one fake React instance plus its render-pass controls.
 * @returns `{ api, begin, flush, mark, rewind, reset }`.
 */
export function createFakeReact () {
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
