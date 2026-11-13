/**
 * `dsh-balance-battery` — browser bundle.
 *
 * What it does
 * ------------
 * Puts one battery into the composer's left tool row — the empty stretch of the
 * footer between the permission pill (`工作区内修改`) and the model seat — where
 * it reports the **available balance of the manually chosen source**. A full
 * battery means one top-up unit (`FULL_SCALE`, ¥10 by default), so the gauge
 * answers "how much of my next ¥10 is left" at a glance:
 *
 *     [+] [ 工作区内修改 ⌄ ]  DeepSeek 账号 ▮▮▮▮▮▮▮┊▮┊┊┊ ¥33.32   DeepSeek-V41-Flash  High  [↑]
 *
 * Clicking the battery cycles through the sources (DeepSeek 账号 → DeepSeek
 * API → Kimi → …) and the hover card offers every source as a chip, so
 * the view follows the user, not the selected model.
 *
 * The number is the *spendable* balance: DeepSeek recharge + granted, Kimi cash
 * + vouchers. The hover readout splits those components, so the gauge can stay
 * comparable while the detail stays honest.
 *
 * Where the numbers come from
 * ---------------------------
 * - `deepseek-account` (DeepSeek 账号) — the shipped `account` Remote
 *   namespace, exactly as before: `getState()` then `getBalance()`. The gauge
 *   sums the normal wallets and the bonus wallets of the chosen currency.
 * - `deepseek-official` (DeepSeek API key) — the Host route
 *   `/dsh-balance-battery/deepseek`, which resolves `DEEPSEEK_API_KEY` through
 *   `ctx.credentials` and calls `GET https://api.deepseek.com/user/balance`.
 * - `moonshotai-cn` (Kimi) — the Host route
 *   `/dsh-balance-battery/kimi`, which resolves `MOONSHOTAI_CN_API_KEY` (with
 *   common aliases) and calls `GET https://api.moonshot.cn/v1/users/me/balance`.
 *
 * The key never reaches this bundle: the Host probes the provider and returns
 * amounts only. A page without the account service still renders the gauge and
 * reports the missing service instead of inventing a number.
 *
 * Which provider is shown
 * -----------------------
 * The source is picked by hand, not by the model. Clicking the battery cycles
 * through the sources and the hover card offers every one as a chip, so the
 * gauge shows exactly the account you want to watch. The choice persists in
 * `localStorage`; the very first paint adopts whatever the composer's model
 * selection bills to (read from the per-session `ModelDirectory` store, the
 * same store the model seat renders from) so an upgrade keeps yesterday's
 * view, and from then on model switches are ignored until a source is picked
 * by hand. When the directory is not ready yet (draft session, scope still
 * binding) the gauge falls back to the account route and re-resolves as soon
 * as the store appears, so a transient timing failure never hides the cell.
 *
 * Deliberate non-dependencies: no Harness Client package is imported (those
 * change without notice, and a plain-JS plugin has no type check). React and
 * react-dom come from the page's frozen module table, and react-dom is optional
 * — without it the bubble renders in place instead of through a portal.
 * Styling uses host `--dsw-*` tokens only; the level colours are the host's own
 * success / warn / error aliases, so the gauge follows the theme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-battery',
  factory(require) {
    const React = require('react');
    /** Portal support is optional: without react-dom the bubble renders in place. */
    let createPortal = null;
    try {
      createPortal = require('react-dom').createPortal;
    } catch (error) {
      createPortal = null;
    }

    const h = React.createElement;
    const useCallback = React.useCallback;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useState = React.useState;
    const useSyncExternalStore = React.useSyncExternalStore;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'balance-battery';
    /** The composer's left tool row: a `list` slot, empty in a stock install. */
    const SLOT = 'conversation.input.left';
    /**
     * One battery's worth: the amount a full cell stands for. This is the
     * user's own top-up unit — they charge ¥10 at a time — so a full battery
     * also reads as "a fresh top-up is still untouched".
     */
    const FULL_SCALE = 10;
    /** Currency the full scale is denominated in. */
    const FULL_CURRENCY = 'CNY';
    /**
     * Width of one cell in percent, so the ruler in the style sheet follows
     * `FULL_SCALE`: one tick per unit, ten ticks for a ¥10 cell.
     */
    const CELL_PERCENT = 100 / FULL_SCALE;
    /** Background re-read cadence while the page is visible. */
    const REFRESH_INTERVAL_MS = 60_000;
    /** Decay of the hover/focus bubble's close timer, in ms (long enough to reach it). */
    const BUBBLE_GRACE_MS = 160;
    /** Bubble width in px; must match `.dbb-tip` so viewport clamping is exact. */
    const BUBBLE_WIDTH = 244;
    /** Offset of the bubble from the gauge, in px. */
    const BUBBLE_GAP = 8;
    /**
     * Client build identity the account Remote methods carry. The Host turns it
     * into Platform's `x-client-version` header; a wrong-looking value changes
     * nothing about the balance, so it is pinned to the build this bundle ships
     * with rather than guessed from the page.
     */
    const CLIENT_VERSION = '0.2.0-rc.2';
    /** Platform's decimal grammar for wallet strings (see the platform provider). */
    const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    /** Host routes serving provider balances the browser cannot fetch itself. */
    const BALANCE_ROUTE = '/dsh-balance-battery';
    /** Provider display names; proper nouns, so they stay out of the dictionaries. */
    const BRAND_DEEPSEEK = 'DeepSeek';
    const BRAND_KIMI = 'Kimi';
    /**
     * Where each kind tops up. The account route replaces this with the link
     * the Host projects (`getState().links.topUpUrl`) when it has one.
     */
    const TOP_UP_URL = {
      deepseek: 'https://platform.deepseek.com/top_up',
      kimi: 'https://platform.kimi.com/console/account',
    };
    /**
     * The manually selectable sources, in click-cycle order. `unsupported` is
     * deliberately absent: it is a state, not a source.
     */
    const KIND_ORDER = ['account', 'deepseek', 'kimi'];
    /** `localStorage` key the manual source choice persists under. */
    const PIN_STORAGE_KEY = 'dsh-balance-battery/source';

    /**
     * Read the persisted manual source. Any storage failure (blocked, quota,
     * sandboxed page) degrades to "never pinned" instead of throwing.
     * @returns a kind from `KIND_ORDER`, or null when nothing is stored.
     */
    function readPinnedKind() {
      try {
        const value = window.localStorage?.getItem?.(PIN_STORAGE_KEY);
        return KIND_ORDER.includes(value) ? value : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * Persist the manual source. Best effort: an unavailable store costs the
     * choice across restarts, nothing more.
     * @param kind - the kind to remember.
     */
    function writePinnedKind(kind) {
      try {
        window.localStorage?.setItem?.(PIN_STORAGE_KEY, kind);
      } catch (error) {
        /* The choice simply stays session-local. */
      }
    }

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'battery.title': '可用余额',
      'battery.full': '满格 {amount}',
      'battery.aria': '{brand} 可用余额 {amount}，满格 {full}，点击切换来源',
      'battery.ariaState': '{brand} 可用余额：{state}，点击切换来源',
      'bubble.title': '{brand} 可用余额',
      'bubble.full': '满格 {amount}',
      'bubble.recharge': '充值余额',
      'bubble.gift': '赠送余额',
      'bubble.cash': '现金余额',
      'bubble.voucher': '代金券',
      'bubble.updated': '更新于 {time}',
      'bubble.hint': '点击电池切换来源；在此可直接选择或刷新',
      'bubble.refreshing': '正在读取…',
      'bubble.topUp': '去 {brand} 充值 →',
      'bubble.balanceUnavailable': '未能读取余额，可在 Platform 查看',
      'menu.title': '余额来源',
      'menu.refresh': '刷新',
      'menu.current': '当前',
      'source.account': 'DeepSeek 账号',
      'source.api': 'DeepSeek API',
      'state.loading': '读取中',
      'state.signedOut': '未登录',
      'state.error': '读取失败',
      'state.unavailable': '不可用',
      'state.unsupported': '无接口',
      'state.signedOutDetail': '当前没有已登录的 DeepSeek 账号，余额只在登录后可见；也可切换到其它余额来源。',
      'state.unavailableDetail': '此页面没有挂载账号服务（remote.account）；也可切换到其它余额来源。',
      'state.unsupportedDetail': '当前模型供应商没有余额接口；点击电池或在下方选择一个来源即可查看。',
      'error.remote': '账号服务返回失败',
      'error.platform': 'Platform 暂时没有返回余额',
      'error.network': '连不上余额接口（网络错误）',
      'error.timeout': '余额接口超时',
      'error.http': '余额接口返回 {status}',
      'error.auth': '余额服务未授权，刷新页面后再试',
      'error.missingKey': '没有找到 {ref}，无法读取 {brand} 余额',
      'error.unauthorized': '{brand} 拒绝了这个 API Key（401）',
      'error.render': '电池渲染失败：{message}',
      'brand.unknown': '当前供应商',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'battery.title': 'Available balance',
      'battery.full': 'Full {amount}',
      'battery.aria': '{brand} available balance {amount}, full at {full}, click to switch source',
      'battery.ariaState': '{brand} available balance: {state}, click to switch source',
      'bubble.title': '{brand} available balance',
      'bubble.full': 'Full {amount}',
      'bubble.recharge': 'Topped up',
      'bubble.gift': 'Granted',
      'bubble.cash': 'Cash',
      'bubble.voucher': 'Vouchers',
      'bubble.updated': 'Updated {time}',
      'bubble.hint': 'Click the battery to cycle; pick a source or refresh here',
      'bubble.refreshing': 'Reading…',
      'bubble.topUp': 'Top up on {brand} →',
      'bubble.balanceUnavailable': 'Balance unavailable — view it on Platform',
      'menu.title': 'Balance source',
      'menu.refresh': 'Refresh',
      'menu.current': 'Current',
      'source.account': 'DeepSeek account',
      'source.api': 'DeepSeek API',
      'state.loading': 'Reading',
      'state.signedOut': 'Signed out',
      'state.error': 'Failed',
      'state.unavailable': 'Unavailable',
      'state.unsupported': 'No API',
      'state.signedOutDetail': 'No DeepSeek account is signed in; the balance is visible after signing in. Another source can be selected instead.',
      'state.unavailableDetail': 'This page mounted no account service (remote.account). Another source can be selected instead.',
      'state.unsupportedDetail': 'The selected provider exposes no balance endpoint; click the battery or pick a source below.',
      'error.remote': 'the account service returned a failure',
      'error.platform': 'the balance endpoint returned no balance',
      'error.network': 'network error reaching the balance endpoint',
      'error.timeout': 'the balance endpoint timed out',
      'error.http': 'the balance endpoint returned {status}',
      'error.auth': 'the balance service is not authorized — refresh the page',
      'error.missingKey': 'no {ref} found — cannot read the {brand} balance',
      'error.unauthorized': '{brand} rejected the API key (401)',
      'error.render': 'battery render failed: {message}',
      'brand.unknown': 'this provider',
    };

    /**
     * Style sheet. Every colour is a host token, so light and dark themes both
     * work; the only local variables are the gauge's own geometry and the level
     * colour picked by `data-level`.
     */
    const CSS = [
      /* --- the gauge ------------------------------------------------------- */
      '.dbb-root{display:flex;align-items:center;gap:7px;min-width:0;height:28px;box-sizing:border-box;',
      'padding:0 8px 0 6px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;font:inherit;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;outline:none;',
      '--dbb-edge:var(--dsw-alias-border-l4);--dbb-void:transparent;--dbb-level:var(--dsw-alias-state-success-primary);',
      /* Tick paint: a mid grey reads on the light body, the dark body, and every
         level colour; the currentColor mix (where supported) follows the theme. */
      '--dbb-tick:rgba(127,132,140,.5);--dbb-tick:color-mix(in srgb,currentColor 26%,transparent)}',
      '.dbb-root:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dbb-root:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dbb-root:disabled{cursor:default}',
      '.dbb-root[data-level=mid]{--dbb-level:var(--dsw-alias-state-warn-primary)}',
      '.dbb-root[data-level=low]{--dbb-level:var(--dsw-alias-state-error-primary)}',
      '.dbb-root[data-level=idle]{--dbb-level:var(--dsw-alias-state-idle-primary);--dbb-void:var(--dsw-alias-bg-module-platform)}',
      '.dbb-root[data-off=true]{--dbb-edge:var(--dsw-alias-border-l3)}',
      /* Ten cells wide: one cell is one `FULL_SCALE` unit, so the ruler below is
         readable at a glance instead of being a bare bar. */
      '.dbb-shell{position:relative;display:block;flex:none;width:82px;height:16px}',
      '.dbb-body{position:absolute;left:0;top:0;right:4.5px;bottom:0;box-sizing:border-box;padding:1.5px;',
      'border:1.5px solid var(--dbb-edge);border-radius:4.5px;background:var(--dbb-void);',
      'transition:border-color .3s ease,background-color .3s ease}',
      '.dbb-nub{position:absolute;right:0;top:50%;width:3px;height:7px;transform:translateY(-50%);',
      'border-radius:0 2px 2px 0;background:var(--dbb-edge);transition:background-color .3s ease}',
      '.dbb-fill{display:block;height:100%;width:0;border-radius:2.5px;background:var(--dbb-level);',
      'transition:width .45s cubic-bezier(.22,.61,.36,1),background-color .3s ease}',
      /* One tick per unit, drawn over the fill so both the spent and the left
         part stay countable: the line ends exactly on each cell boundary. */
      `.dbb-ticks{position:absolute;inset:1.5px;border-radius:2.5px;pointer-events:none;`,
      `background-image:repeating-linear-gradient(to right,transparent 0,transparent calc(${CELL_PERCENT}% - 1px),`,
      `var(--dbb-tick) calc(${CELL_PERCENT}% - 1px),var(--dbb-tick) ${CELL_PERCENT}%)}`,
      '.dbb-label{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;line-height:18px;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;min-width:0}',
      '.dbb-brand{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);letter-spacing:.01em}',
      '.dbb-root:hover .dbb-brand{color:var(--dsw-alias-label-secondary)}',
      '.dbb-root[data-busy=true] .dbb-fill{animation:dbbPulse 1s ease-in-out infinite}',
      '.dbb-root[data-phase="loading"] .dbb-label,.dbb-root[data-busy=true] .dbb-label{color:var(--dsw-alias-label-tertiary)}',
      '@keyframes dbbPulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '@media (prefers-reduced-motion:reduce){.dbb-fill{transition:none}.dbb-root[data-busy=true] .dbb-fill{animation:none}}',
      /* --- the bubble ------------------------------------------------------ */
      '.dbb-tip{position:fixed;z-index:2147483000;width:244px;box-sizing:border-box;display:flex;flex-direction:column;gap:7px;',
      'padding:10px 12px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-specific-tip,var(--dsw-menu-surface-fill,var(--dsw-specific-input-major)));',
      'box-shadow:var(--dsw-elevation-prominent,var(--dsw-elevation-soft));color:var(--dsw-alias-label-primary);',
      'font-size:12px;line-height:18px;text-align:left;white-space:normal;',
      '--dbb-level:var(--dsw-alias-state-success-primary)}',
      '.dbb-tip[data-placement=top]{transform:translateY(-100%)}',
      '.dbb-tip[data-level=mid]{--dbb-level:var(--dsw-alias-state-warn-primary)}',
      '.dbb-tip[data-level=low]{--dbb-level:var(--dsw-alias-state-error-primary)}',
      '.dbb-tip[data-level=idle]{--dbb-level:var(--dsw-alias-state-idle-primary)}',
      '.dbb-tipRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.dbb-tipTitle{color:var(--dsw-alias-label-tertiary)}',
      '.dbb-tipAmount{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dbb-tipAmount[data-alert=true]{color:var(--dsw-alias-state-error-primary)}',
      '.dbb-tipAmount[data-warn=true]{color:var(--dsw-alias-state-warn-primary)}',
      '.dbb-tipMeter{display:flex;align-items:center;gap:8px}',
      '.dbb-tipTrack{position:relative;flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}',
      '.dbb-tipFill{display:block;height:100%;border-radius:2px;background:var(--dbb-level,var(--dsw-alias-state-success-primary))}',
      /* The bubble's meter carries the same ruler as the gauge. */
      '.dbb-tipTicks{position:absolute;inset:0;pointer-events:none;',
      `background-image:repeating-linear-gradient(to right,transparent 0,transparent calc(${CELL_PERCENT}% - 1px),`,
      `var(--dbb-tick,var(--dsw-alias-border-l4)) calc(${CELL_PERCENT}% - 1px),var(--dbb-tick,var(--dsw-alias-border-l4)) ${CELL_PERCENT}%)}`,
      '.dbb-tipPct{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dbb-tipNote{color:var(--dsw-alias-label-tertiary)}',
      '.dbb-tipError{color:var(--dsw-alias-label-error)}',
      '.dbb-tipLink{color:var(--dsw-alias-state-business-primary);text-decoration:none;align-self:flex-start}',
      '.dbb-tipLink:hover{text-decoration:underline}',
      /* --- the source switcher -------------------------------------------- */
      '.dbb-tipMenu{display:flex;flex-wrap:wrap;align-items:center;gap:5px}',
      '.dbb-tipMenuTitle{color:var(--dsw-alias-label-tertiary);margin-right:2px}',
      '.dbb-tipChip{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:11px;line-height:16px;padding:2px 9px;cursor:pointer;white-space:nowrap}',
      '.dbb-tipChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dbb-tipChip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dbb-tipChip[data-current=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);cursor:default}',
      '.dbb-tipChip:disabled{cursor:default;opacity:.6}',
      '.dbb-diag{color:var(--dsw-alias-label-error);font-size:12px;line-height:18px;white-space:nowrap}',
    ].join('');

    /* --------------------------------------------------------------------- *
     * Pure helpers
     * --------------------------------------------------------------------- */

    /**
     * Parse one Platform wallet string.
     * @param value - raw balance string from the account projection.
     * @returns the finite amount, or null when the string is not a decimal.
     */
    function parseAmount(value) {
      if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
      const amount = Number(value);
      return Number.isFinite(amount) ? amount : null;
    }

    /**
     * Parse an optional Host-route amount. A missing split (`null`, absent,
     * empty) must stay missing: `Number(null)` is 0, and a 0 would draw a
     * split row the provider never reported.
     * @param value - raw amount from a Host route body.
     * @returns the finite amount, or null when there is nothing to show.
     */
    function optionalAmount(value) {
      if (value === null || value === undefined || value === '') return null;
      const amount = Number(value);
      return Number.isFinite(amount) ? amount : null;
    }

    /** @param currency - wallet currency code. @returns its display symbol. */
    function currencySymbol(currency) {
      if (currency === 'USD') return '$';
      if (currency === 'CNY') return '¥';
      return `${currency} `;
    }

    /** Render an amount the way Platform's own two-decimal display does. */
    function formatAmount(amount, currency) {
      if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
      return `${currencySymbol(currency)}${amount.toFixed(2)}`;
    }

    /**
     * Pick the wallet the battery stands for: the recharge wallet in
     * `FULL_CURRENCY` when the account has one, otherwise the first wallet in
     * Platform's own order. Several wallets of that currency are summed, so a
     * split balance still reads as one gauge.
     * @param wallets - `value` from a ready balance outcome.
     * @returns the chosen amount/currency, or null without a usable wallet.
     */
    function pickWallet(wallets) {
      if (!Array.isArray(wallets)) return null;
      const usable = wallets
        .map((wallet) => ({ currency: wallet?.currency, amount: parseAmount(wallet?.balance) }))
        .filter((wallet) => wallet.amount !== null);
      if (usable.length === 0) return null;
      const preferred = usable.filter((wallet) => wallet.currency === FULL_CURRENCY);
      const chosen = preferred.length > 0 ? preferred : usable;
      return chosen.reduce(
        (total, wallet) => ({ currency: total.currency ?? wallet.currency, amount: total.amount + wallet.amount }),
        { currency: null, amount: 0 },
      );
    }

    /**
     * Classify a fill ratio into the gauge's level, which selects the colour.
     * @param ratio - clamped balance/full-scale ratio.
     * @returns the level name used by `data-level`.
     */
    function levelOf(ratio) {
      if (ratio < 0.2) return 'low';
      if (ratio < 0.5) return 'mid';
      return 'high';
    }

    /**
     * Map a model-directory provider id to the balance source it bills to.
     *
     * `deepseek-account` is the signed-in account projection; every other
     * DeepSeek route (`deepseek-official`, …) uses the API key; Moonshot's
     * routes carry either brand name. Anything else has no balance endpoint.
     * This only ever seeds the first manual choice — the shown source itself
     * is picked by hand.
     * @param providerId - `current.provider` from the model directory.
     * @returns one of the channel kinds.
     */
    function providerKind(providerId) {
      const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
      if (id === '') return 'account';
      if (id === 'deepseek-account') return 'account';
      if (id.indexOf('deepseek') === 0) return 'deepseek';
      if (id.indexOf('moonshot') !== -1 || id.indexOf('kimi') !== -1) return 'kimi';
      return 'unsupported';
    }

    /**
     * Display name of one source. The two DeepSeek routes are named apart so
     * a manually switched gauge always says exactly which balance it shows.
     * @param kind - channel kind. @param t - dictionary-bound translator.
     * @returns the source's display name.
     */
    function kindLabel(kind, t) {
      if (kind === 'kimi') return BRAND_KIMI;
      if (kind === 'account') return t('source.account');
      if (kind === 'deepseek') return t('source.api');
      return t('brand.unknown');
    }

    /** @param kind - channel kind. @returns the provider's display name. */
    function brandOf(kind, t) {
      return kindLabel(kind, t);
    }

    /** @param kind - channel kind. @returns the parsed amount-part labels. */
    function partsOf(kind) {
      return kind === 'kimi'
        ? { recharge: 'bubble.cash', bonus: 'bubble.voucher' }
        : { recharge: 'bubble.recharge', bonus: 'bubble.gift' };
    }

    /**
     * Build the account-call identity the Host turns into Platform headers.
     * @param ctx - client context, read for the language in effect at call time.
     */
    function clientMetadata(ctx) {
      let locale = 'zh';
      try {
        locale = ctx.locale.getSnapshot().active ?? 'zh';
      } catch (error) {
        /* A scope without a readable locale still answers: Platform reduces it anyway. */
      }
      return {
        version: CLIENT_VERSION,
        locale,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
    }

    /* --------------------------------------------------------------------- *
     * Provider tracker: which balance does the selected model bill to?
     * --------------------------------------------------------------------- */

    /** Immutable fallback snapshot, so React's Object.is comparison stays calm. */
    const FALLBACK_PROVIDER = Object.freeze({ kind: 'account', providerId: null });

    /**
     * Follow one session's model selection.
     *
     * The directory store is the same object the composer's model seat reads,
     * so a switch made there is visible here without a second source of truth.
     * Resolution is lazy and self-healing: `directoryFor` throws while the
     * session scope is still binding, so failures schedule a bounded backoff
     * instead of leaving the battery permanently stuck on the fallback.
     *
     * @param ctx - client plugin context (`ctx.get('modelDirectories')`).
     * @param sessionId - the session the slot is rendering for.
     * @returns `{ subscribe, getSnapshot, dispose }`.
     */
    function createProviderTracker(ctx, sessionId) {
      let stopped = false;
      let published = FALLBACK_PROVIDER;
      let store = null;
      let unsubscribe = null;
      let timer = null;
      let attempts = 0;
      let lastDirectory = null;
      const listeners = new Set();

      const notify = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            /* A subscriber's own failure is not ours. */
          }
        }
      };

      const publish = (providerId) => {
        const kind = providerKind(providerId);
        if (published.kind === kind && published.providerId === providerId) return;
        published = { kind, providerId };
        notify();
      };

      const readStore = () => {
        if (stopped) return;
        if (store === null) return;
        let current = null;
        try {
          current = store.getSnapshot()?.current ?? null;
        } catch (error) {
          return;
        }
        publish(typeof current?.provider === 'string' ? current.provider : null);
      };

      const resolveDirectory = () => {
        if (stopped || typeof sessionId !== 'string' || sessionId === '') return null;
        try {
          const directories = typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined;
          if (directories === undefined || directories === null || typeof directories.directoryFor !== 'function') return null;
          const directory = directories.directoryFor(sessionId);
          if (directory === null || directory === undefined) return null;
          const candidate = directory.store;
          if (candidate === null || candidate === undefined || typeof candidate.getSnapshot !== 'function') return null;
          lastDirectory = directory;
          return candidate;
        } catch (error) {
          return null;
        }
      };

      const scheduleRetry = () => {
        if (stopped || timer !== null || attempts >= 8) return;
        attempts += 1;
        timer = setTimeout(() => {
          timer = null;
          attach();
        }, Math.min(2500, 120 * attempts * attempts));
      };

      const attach = () => {
        if (stopped || store !== null) return;
        const candidate = resolveDirectory();
        if (candidate === null) {
          scheduleRetry();
          return;
        }
        store = candidate;
        try {
          unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(readStore) : null;
        } catch (error) {
          unsubscribe = null;
        }
        readStore();
      };

      const subscribe = (listener) => {
        listeners.add(listener);
        attach();
        readStore();
        return () => listeners.delete(listener);
      };

      attach();

      return {
        subscribe,
        getSnapshot: () => published,
        dispose: () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          try {
            if (typeof unsubscribe === 'function') unsubscribe();
          } catch (error) {
            /* Host cleanup is best effort. */
          }
          unsubscribe = null;
          store = null;
          listeners.clear();
        },
        /** Exposed for diagnostics/tests: the directory last resolved, if any. */
        directory: () => lastDirectory,
      };
    }

    /* --------------------------------------------------------------------- *
     * Balance channel: one reader per provider kind, shared by every battery
     * --------------------------------------------------------------------- */

    /** @param kind - channel kind. @returns the snapshot before the first read. */
    function initialSnapshot(kind) {
      return {
        kind,
        phase: 'loading',
        amount: null,
        currency: FULL_CURRENCY,
        recharge: null,
        bonus: null,
        updatedAt: null,
        error: null,
        topUpUrl: TOP_UP_URL[kind] ?? null,
        busy: false,
        stale: false,
      };
    }

    /**
     * Create the shared balance reader.
     *
     * One snapshot exists per provider kind, so switching the model back and
     * forth shows the last known number immediately and refreshes it in the
     * background. Reads are single-flight per kind: a click during a timer read
     * joins that read instead of racing it.
     *
     * @param ctx - client plugin context.
     * @param t - dictionary-bound translator.
     * @returns the channel: `subscribe`, `getSnapshot`, `activate`, `refresh`, `start`, `stop`.
     */
    function createChannel(ctx, t) {
      /** @type {Map<string, ReturnType<typeof initialSnapshot>>} */
      const snapshots = new Map([
        ['account', initialSnapshot('account')],
        ['deepseek', initialSnapshot('deepseek')],
        ['kimi', initialSnapshot('kimi')],
        ['unsupported', initialSnapshot('unsupported')],
      ]);
      const listeners = new Set();
      const inflight = new Map();
      let active = null;
      let timer = null;
      let stopped = false;
      /**
       * The manually chosen source. Null until the first choice: the very
       * first activation adopts the model's source so an upgrade keeps the
       * old view, and every later choice comes from the user alone.
       */
      let pinned = readPinnedKind();

      /** Fan a pin change out to the subscribed components. */
      const publishPin = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            /* A subscriber's own failure is not ours. */
          }
        }
      };

      const publish = (kind, patch) => {
        const previous = snapshots.get(kind);
        if (previous === undefined) return;
        snapshots.set(kind, { ...previous, ...patch });
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            /* A subscriber's own failure is not ours. */
          }
        }
      };

      /** @returns the account Remote namespace, or null when this page has none. */
      const remote = () => {
        const account = ctx.remote?.account;
        return account !== undefined && typeof account.getState === 'function' ? account : null;
      };

      /** One full read through the signed-in account projection. */
      const readAccount = async () => {
        const account = remote();
        if (account === null) return { phase: 'unavailable', amount: null, recharge: null, bonus: null, error: null };
        const state = await account.getState();
        if (!state?.ok) return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.remote') };
        const view = state.value ?? {};
        const topUpUrl = typeof view?.links?.topUpUrl === 'string' ? view.links.topUpUrl : undefined;
        if (view.status !== 'credential-stored') {
          return { phase: 'signed-out', amount: null, recharge: null, bonus: null, error: null, topUpUrl };
        }
        const result = await account.getBalance(clientMetadata(ctx));
        if (!result?.ok) return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.remote'), topUpUrl };
        const value = result.value;
        // The grant disappeared between the two calls (sign-out, or a rejected token).
        if (value === null || value === undefined) {
          return { phase: 'signed-out', amount: null, recharge: null, bonus: null, error: null, topUpUrl };
        }
        if (value.status !== 'ready') {
          return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.platform'), topUpUrl };
        }
        const wallet = pickWallet(value.value);
        const currency = wallet?.currency ?? FULL_CURRENCY;
        const bonus = pickWallet(
          Array.isArray(value.bonusWallets)
            ? value.bonusWallets.filter((row) => row?.currency === currency)
            : [],
        );
        const recharge = wallet?.amount ?? 0;
        const bonusAmount = bonus?.amount ?? 0;
        return {
          phase: 'ready',
          amount: recharge + bonusAmount,
          currency,
          recharge,
          bonus: bonusAmount,
          error: null,
          topUpUrl,
        };
      };

      /** One read through a Host route (`deepseek` or `kimi`). */
      const readRoute = async (kind, fresh) => {
        const url = `${BALANCE_ROUTE}/${kind}${fresh === true ? '?fresh=1' : ''}`;
        let response;
        let body = null;
        try {
          response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          });
        } catch (error) {
          return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.network') };
        }
        try {
          body = await response.json();
        } catch (error) {
          body = null;
        }
        if (response.status === 401 || response.status === 403) {
          return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.auth') };
        }
        if (!response.ok) {
          return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.http', { status: response.status }) };
        }
        if (body === null || body.ok !== true) {
          const code = body?.error;
          if (code === 'missing-credential') {
            const ref = Array.isArray(body?.refs) && body.refs.length > 0 ? body.refs[0] : 'API key';
            return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.missingKey', { ref, brand: brandOf(kind, t) }) };
          }
          if (code === 'unauthorized') {
            return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.unauthorized', { brand: brandOf(kind, t) }) };
          }
          if (code === 'timeout') return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.timeout') };
          if (code === 'network') return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.network') };
          return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.platform') };
        }
        const total = Number(body.total);
        if (!Number.isFinite(total)) {
          return { phase: 'error', amount: null, recharge: null, bonus: null, error: t('error.platform') };
        }
        return {
          phase: 'ready',
          amount: total,
          currency: body.currency === 'USD' ? 'USD' : 'CNY',
          recharge: optionalAmount(body.recharge),
          bonus: optionalAmount(body.bonus),
          error: null,
          topUpUrl: typeof body.topUpUrl === 'string' ? body.topUpUrl : undefined,
        };
      };

      /**
       * Read one provider and publish the outcome.
       * @param kind - channel kind.
       * @param options - `silent` skips the busy pulse, `fresh` bypasses the Host cache.
       * @returns settlement of this or the already-running read.
       */
      const refresh = (kind, options = {}) => {
        const { silent = false, fresh = false } = options;
        if (stopped) return Promise.resolve();
        const running = inflight.get(kind);
        if (running !== undefined) return running;
        if (silent !== true) publish(kind, { busy: true });
        const run = (async () => {
          let next;
          if (kind === 'unsupported') {
            next = { phase: 'unsupported', amount: null, recharge: null, bonus: null, error: null };
          } else if (kind === 'account') {
            next = await readAccount();
          } else {
            next = await readRoute(kind, fresh);
          }
          // A failed read keeps the last good number on screen: the gauge is a
          // glance, and blanking it on a transient network error is worse than
          // showing a stale amount with its timestamp.
          const previous = snapshots.get(kind);
          const keepAmount = next.phase === 'error' && previous.phase === 'ready';
          publish(kind, {
            ...next,
            ...(keepAmount
              ? {
                  phase: 'ready',
                  amount: previous.amount,
                  currency: previous.currency,
                  recharge: previous.recharge,
                  bonus: previous.bonus,
                  topUpUrl: previous.topUpUrl,
                }
              : {}),
            stale: keepAmount,
            updatedAt: keepAmount ? previous.updatedAt : Date.now(),
            busy: false,
          });
        })()
          .catch((error) => {
            console.error('[dsh-balance-battery] balance read failed', error);
            const previous = snapshots.get(kind);
            publish(kind, {
              phase: previous.phase === 'ready' ? 'ready' : 'error',
              error: String(error?.message ?? error).slice(0, 160),
              updatedAt: previous.updatedAt ?? Date.now(),
              busy: false,
            });
          })
          .finally(() => {
            inflight.delete(kind);
          });
        inflight.set(kind, run);
        return run;
      };

      /**
       * Point the channel at one source.
       * A cached ready snapshot stays on screen while the background refresh runs.
       * @param kind - channel kind.
       */
      const activate = (kind) => {
        if (stopped) return;
        const next = snapshots.has(kind) ? kind : 'unsupported';
        if (active === next) return;
        active = next;
        const snapshot = snapshots.get(next);
        refresh(next, { silent: snapshot.phase === 'ready' });
      };

      /**
       * Seed the manual source from the model selection, once, then ignore
       * the model. Adoption waits for a resolved directory (a real provider
       * id) and a supported kind, so a half-ready scope or a provider without
       * a balance API never freezes the choice; until then the model's view
       * stays warm exactly like the old follow-the-model behaviour.
       * @param kind - kind derived from the model directory.
       * @param providerId - the raw provider id behind that kind.
       */
      const activateFromModel = (kind, providerId) => {
        if (stopped) return;
        if (pinned !== null) {
          activate(pinned);
          return;
        }
        if (typeof providerId === 'string' && providerId !== '' && KIND_ORDER.includes(kind)) {
          pinned = kind;
          writePinnedKind(kind);
          publishPin();
          activate(kind);
          return;
        }
        activate(kind);
      };

      /**
       * Show one source from now on: the manual switch behind the click
       * cycle and the hover card chips. The choice persists across restarts.
       * @param kind - one of `KIND_ORDER`.
       */
      const select = (kind) => {
        if (stopped || !KIND_ORDER.includes(kind)) return;
        const changed = pinned !== kind;
        pinned = kind;
        if (changed) {
          writePinnedKind(kind);
          publishPin();
        }
        activate(kind);
      };

      /** Step to the next source in `KIND_ORDER` — the click on the battery. */
      const cycle = () => {
        const at = KIND_ORDER.indexOf(pinned);
        select(KIND_ORDER[(at + 1) % KIND_ORDER.length]);
      };

      /** Re-read when the page becomes visible again — the common case for a desktop app. */
      const onVisibility = () => {
        if (document.visibilityState !== 'hidden' && active !== null) refresh(active, { silent: true });
      };

      const start = () => {
        timer = setInterval(() => {
          if (document.visibilityState !== 'hidden' && active !== null) refresh(active, { silent: true });
        }, REFRESH_INTERVAL_MS);
        document.addEventListener('visibilitychange', onVisibility);
      };

      const stop = () => {
        stopped = true;
        if (timer !== null) clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVisibility);
        listeners.clear();
      };

      return {
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot: (kind) => snapshots.get(snapshots.has(kind) ? kind : 'unsupported'),
        /** The manually chosen source, or null before the first choice. */
        getPin: () => pinned,
        activateFromModel,
        select,
        cycle,
        refresh,
        start,
        stop,
      };
    }

    /* --------------------------------------------------------------------- *
     * The gauge
     * --------------------------------------------------------------------- */

    /** One-line state word for the label / accessible name. */
    function stateText(t, snapshot) {
      if (snapshot.phase === 'ready') return formatAmount(snapshot.amount, snapshot.currency);
      if (snapshot.phase === 'loading') return t('state.loading');
      if (snapshot.phase === 'signed-out') return t('state.signedOut');
      if (snapshot.phase === 'unavailable') return t('state.unavailable');
      if (snapshot.phase === 'unsupported') return t('state.unsupported');
      return t('state.error');
    }

    /**
     * The battery cells: shell, body, fill, and the per-unit ruler drawn over
     * the fill so the spent and the remaining units both stay countable.
     */
    function Battery(fillRatio) {
      return h('span', { className: 'dbb-shell', key: 'shell', 'aria-hidden': true }, [
        h('span', { className: 'dbb-body', key: 'body' }, [
          h('span', {
            className: 'dbb-fill',
            key: 'fill',
            style: { width: `${Math.round(fillRatio * 1000) / 10}%` },
          }),
          h('span', { className: 'dbb-ticks', key: 'ticks' }),
        ]),
        h('span', { className: 'dbb-nub', key: 'nub' }),
      ]);
    }

    /** The hover/focus readout: amounts, the source switcher, and the top-up link. */
    function Bubble({ snapshot, t, brand, kind, channel, style, placement, level, onEnter, onLeave }) {
      const ratio = snapshot.amount === null ? 0 : Math.max(0, Math.min(1, snapshot.amount / FULL_SCALE));
      const full = formatAmount(FULL_SCALE, FULL_CURRENCY);
      const parts = partsOf(snapshot.kind);
      const rows = [];
      rows.push(h('div', { className: 'dbb-tipRow', key: 'head' }, [
        h('span', { className: 'dbb-tipTitle', key: 'title' }, t('bubble.title', { brand })),
        h('span', {
          className: 'dbb-tipAmount',
          key: 'amount',
          'data-warn': snapshot.phase === 'ready' && ratio < 0.5 && ratio >= 0.2 ? 'true' : undefined,
          'data-alert': snapshot.phase === 'ready' && ratio < 0.2 ? 'true' : undefined,
        }, stateText(t, snapshot)),
      ]));
      if (snapshot.phase === 'ready') {
        rows.push(h('div', { className: 'dbb-tipMeter', key: 'meter' }, [
          h('span', { className: 'dbb-tipTrack', key: 'track' }, [
            h('span', {
              className: 'dbb-tipFill',
              key: 'fill',
              style: { width: `${Math.round(ratio * 1000) / 10}%` },
            }),
            h('span', { className: 'dbb-tipTicks', key: 'ticks' }),
          ]),
          h('span', { className: 'dbb-tipPct', key: 'pct' }, `${Math.round(ratio * 100)}%`),
        ]));
        rows.push(h('div', { className: 'dbb-tipNote', key: 'full' }, t('bubble.full', { amount: full })));
        if (snapshot.recharge !== null) {
          rows.push(h('div', { className: 'dbb-tipRow', key: 'recharge' }, [
            h('span', { className: 'dbb-tipTitle', key: 'label' }, t(parts.recharge)),
            h('span', { key: 'value' }, formatAmount(snapshot.recharge, snapshot.currency)),
          ]));
        }
        if (snapshot.bonus !== null && snapshot.bonus > 0) {
          rows.push(h('div', { className: 'dbb-tipRow', key: 'bonus' }, [
            h('span', { className: 'dbb-tipTitle', key: 'label' }, t(parts.bonus)),
            h('span', { key: 'value' }, formatAmount(snapshot.bonus, snapshot.currency)),
          ]));
        }
        rows.push(h('div', { className: 'dbb-tipNote', key: 'updated' }, snapshot.busy === true
          ? t('bubble.refreshing')
          : t('bubble.updated', { time: new Date(snapshot.updatedAt ?? Date.now()).toLocaleTimeString() })));
      } else if (snapshot.phase === 'signed-out') {
        rows.push(h('div', { className: 'dbb-tipNote', key: 'why' }, t('state.signedOutDetail')));
      } else if (snapshot.phase === 'unavailable') {
        rows.push(h('div', { className: 'dbb-tipNote', key: 'why' }, t('state.unavailableDetail')));
      } else if (snapshot.phase === 'unsupported') {
        rows.push(h('div', { className: 'dbb-tipNote', key: 'why' }, t('state.unsupportedDetail')));
      } else if (snapshot.phase === 'loading') {
        rows.push(h('div', { className: 'dbb-tipNote', key: 'why' }, t('bubble.refreshing')));
      }
      if (snapshot.phase === 'error') {
        rows.push(h('div', { className: 'dbb-tipError', key: 'error' }, `${t('state.error')}：${snapshot.error ?? ''}`));
      }
      if (snapshot.phase === 'ready' && snapshot.error !== null) {
        rows.push(h('div', { className: 'dbb-tipError', key: 'stale' }, snapshot.error));
      }
      // The manual source switcher: one chip per source, the current one
      // marked, plus an explicit refresh so a click on the battery itself can
      // stay reserved for cycling.
      rows.push(h('div', { className: 'dbb-tipMenu', key: 'menu' }, [
        h('span', { className: 'dbb-tipMenuTitle', key: 'menuTitle' }, t('menu.title')),
        ...KIND_ORDER.map((entry) => h('button', {
          className: 'dbb-tipChip',
          key: entry,
          type: 'button',
          'data-current': entry === kind ? 'true' : undefined,
          'aria-pressed': entry === kind ? 'true' : 'false',
          title: entry === kind ? t('menu.current') : undefined,
          onClick: (event) => {
            event.stopPropagation();
            channel.select(entry);
          },
        }, kindLabel(entry, t))),
        h('button', {
          className: 'dbb-tipChip dbb-tipRefresh',
          key: 'refresh',
          type: 'button',
          disabled: snapshot.busy === true,
          onClick: (event) => {
            event.stopPropagation();
            channel.refresh(kind, { fresh: true });
          },
        }, snapshot.busy === true ? t('bubble.refreshing') : t('menu.refresh')),
      ]));
      if (typeof snapshot.topUpUrl === 'string' && snapshot.topUpUrl !== '') {
        rows.push(h('a', {
          className: 'dbb-tipLink',
          key: 'topUp',
          href: snapshot.topUpUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          onClick: (event) => event.stopPropagation(),
        }, t('bubble.topUp', { brand })));
      }
      rows.push(h('div', { className: 'dbb-tipNote', key: 'hint' }, t('bubble.hint')));
      return h('div', {
        className: 'dbb-tip',
        role: 'tooltip',
        'data-placement': placement,
        'data-level': level,
        style,
        onPointerEnter: onEnter,
        onPointerLeave: onLeave,
        // Keyboard reaches the bubble's own link: the anchor's blur has already
        // scheduled a close, so taking focus inside cancels that timer.
        onFocus: onEnter,
        onBlur: onLeave,
      }, rows);
    }

    /**
     * The registered component: fail-loud wrapper around the body, so a render
     * exception shows up in the composer instead of silently abdicating the
     * slot entry (a slot body that throws is swallowed by the renderer).
     */
    function BalanceBattery(props) {
      try {
        return BatteryBody(props);
      } catch (error) {
        console.error('[dsh-balance-battery] battery render failed', error);
        const t = props.t ?? ((key, params) => (params === undefined ? key : `${key}`));
        return h('span', { className: 'dbb-diag' }, t('error.render', { message: String(error?.message ?? error).slice(0, 120) }));
      }
    }

    /** The gauge body: manual source state, store subscription, tooltip placement, click-to-cycle. */
    function BatteryBody(props) {
      const channel = props.channel;
      const tracker = props.provider;
      const t = props.t;
      const tracked = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
      const pinned = useSyncExternalStore(channel.subscribe, channel.getPin);
      /** The shown source: the manual pick, or the model's until the first pick lands. */
      const kind = pinned === null ? tracked.kind : pinned;
      const readSnapshot = useCallback(() => channel.getSnapshot(kind), [channel, kind]);
      const snapshot = useSyncExternalStore(channel.subscribe, readSnapshot);
      const rootRef = useRef(null);
      const closeTimer = useRef(null);
      const [tip, setTip] = useState(null);
      /** Deferred so the first paint shows an empty cell and the fill animates in. */
      const [energized, setEnergized] = useState(false);

      useEffect(() => {
        const timer = setTimeout(() => setEnergized(true), 30);
        return () => clearTimeout(timer);
      }, []);

      useEffect(() => {
        channel.activateFromModel(tracked.kind, tracked.providerId);
      }, [channel, tracked.kind, tracked.providerId]);

      useEffect(() => () => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      }, []);

      const ratio = snapshot.amount === null ? 0 : Math.max(0, Math.min(1, snapshot.amount / FULL_SCALE));
      const fillRatio = energized ? ratio : 0;
      const level = snapshot.phase === 'ready' ? levelOf(ratio) : 'idle';
      const full = formatAmount(FULL_SCALE, FULL_CURRENCY);
      const amountText = stateText(t, snapshot);
      const brand = brandOf(kind, t);

      const cancelClose = useCallback(() => {
        if (closeTimer.current !== null) {
          clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
      }, []);

      const open = useCallback(() => {
        cancelClose();
        const element = rootRef.current;
        if (element === null || typeof element.getBoundingClientRect !== 'function') return;
        const rect = element.getBoundingClientRect();
        const width = window.innerWidth;
        const left = Math.max(8, Math.min(rect.left + rect.width / 2 - BUBBLE_WIDTH / 2, width - BUBBLE_WIDTH - 8));
        // The composer sits at the bottom of the window: above is the default,
        // and only a composer pushed to the very top flips the bubble below.
        const placement = rect.top > 150 ? 'top' : 'bottom';
        const top = placement === 'top' ? rect.top - BUBBLE_GAP : rect.bottom + BUBBLE_GAP;
        setTip({ left, top, placement });
      }, [cancelClose]);

      const close = useCallback(() => {
        cancelClose();
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null;
          setTip(null);
        }, BUBBLE_GRACE_MS);
      }, [cancelClose]);

      const closeNow = useCallback(() => {
        cancelClose();
        setTip(null);
      }, [cancelClose]);

      useEffect(() => {
        if (tip === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeNow();
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', closeNow);
        window.addEventListener('scroll', closeNow, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('resize', closeNow);
          window.removeEventListener('scroll', closeNow, true);
        };
      }, [tip, closeNow]);

      const onClick = useCallback((event) => {
        // The composer card itself is a workspace trigger in its hero state:
        // keep a click on the gauge from reaching that handler.
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
        channel.cycle();
      }, [channel]);

      const off = snapshot.phase !== 'ready';
      const label = snapshot.phase === 'ready'
        ? t('battery.aria', { brand, amount: amountText, full })
        : t('battery.ariaState', { brand, state: amountText });

      const root = h('button', {
        ref: rootRef,
        type: 'button',
        className: 'dbb-root',
        'data-level': level,
        'data-phase': snapshot.phase,
        'data-provider': kind,
        'data-busy': snapshot.busy === true ? 'true' : 'false',
        'data-off': off ? 'true' : 'false',
        'aria-label': label,
        'aria-expanded': tip !== null,
        onPointerEnter: open,
        onPointerLeave: close,
        onFocus: open,
        onBlur: close,
        onClick,
      }, [
        Battery(fillRatio),
        h('span', { className: 'dbb-label', key: 'label' }, [
          h('span', { className: 'dbb-brand', key: 'brand' }, brand),
          h('span', { key: 'amount' }, amountText),
        ]),
      ]);

      if (tip === null) return root;
      const bubble = h(Bubble, {
        key: 'bubble',
        snapshot,
        t,
        brand,
        kind,
        channel,
        level,
        placement: tip.placement,
        style: { left: `${tip.left}px`, top: `${tip.top}px` },
        onEnter: cancelClose,
        onLeave: close,
      });
      // Without react-dom there is no portal, so the bubble renders in place,
      // positioned against the viewport: position:fixed keeps it near the gauge.
      if (createPortal === null) return h(React.Fragment, null, root, bubble);
      return h(React.Fragment, null, root, createPortal(bubble, document.body));
    }

    /**
     * Required services. The client context is a guarded proxy: every service
     * this plugin reaches must be declared here or the access throws
     * `cannot get property "…" without inject`. `remote.account` is the shipped
     * account namespace the DeepSeek balance is read through — the same
     * declaration the shipped account settings screen uses. `modelDirectories`
     * is read through `ctx.get` (optional): a page without it still shows the
     * DeepSeek account balance instead of losing the gauge.
     */
    const inject = ['slots', 'locale', 'remote', 'remote.account'];

    /**
     * Client plugin body: publish the dictionaries and style sheet, open the
     * shared balance channel, and claim the composer's left tool row.
     * @param ctx - root client context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tagId = 'dsh-balance-battery/client.css';
        const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`);
        if (existing !== null) existing.remove();
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-balance-battery';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.append(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-balance-battery: styles');

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-balance-battery: dictionaries');

      const t = ctx.locale.bind(NS);
      const channel = createChannel(ctx, t);
      /** One tracker per session: the slot renders the same session repeatedly. */
      const trackers = new Map();
      const trackerFor = (sessionId) => {
        const key = typeof sessionId === 'string' ? sessionId : '';
        let tracker = trackers.get(key);
        if (tracker === undefined) {
          tracker = createProviderTracker(ctx, key);
          trackers.set(key, tracker);
        }
        return tracker;
      };

      ctx.effect(() => {
        channel.start();
        return () => {
          channel.stop();
          for (const tracker of trackers.values()) tracker.dispose();
          trackers.clear();
        };
      }, 'dsh-balance-battery: balance channel');

      try {
        ctx.slots.inject(SLOT, () => {
          try {
            ctx.slots.register({
              name: SLOT,
              id: 'balance-battery',
              order: 10,
              locale: NS,
              registrant: 'dsh-balance-battery',
              inject: (sessionId) => ({ channel, t, provider: trackerFor(sessionId) }),
            }, BalanceBattery);
          } catch (error) {
            console.error('[dsh-balance-battery] battery register failed', error);
          }
        });
      } catch (error) {
        console.error('[dsh-balance-battery] slots.inject failed', error);
      }
    }

    return { inject, apply };
  },
});
