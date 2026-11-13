# dsh-balance-battery · Balance Battery

[![CI](https://github.com/WuRen-bridge/dsh-balance-battery/actions/workflows/ci.yml/badge.svg)](https://github.com/WuRen-bridge/dsh-balance-battery/actions/workflows/ci.yml)

> **DSH-only plugin.** This project leans on **undocumented internal APIs** of DeepSeek Harness — on the browser side `window.__ModuleLoader__`, `ctx.remote.account`, `modelDirectories`; on the host side `ctx.credentials`, `connection.requestRejection`, `webServer`; plus the host's `--dsw-*` theme tokens. None of these is a stable public contract: they can change on a host upgrade and the plugin can break with them. It is not a general-purpose component; it only works inside a matching DeepSeek Harness install. License: MIT — see [LICENSE](LICENSE).

English · [中文](README.md)

A battery in the tool row of the DeepSeek Harness composer: **full = one top-up (¥10)**, and the charge is the **available total of the balance source you pick by hand**. The battery is split into ten cells at **¥1 per cell**, so you can not only read the ratio but also count how many yuan are left. It sits in the empty stretch left of the model pill — right of the permission pill `Workspace write` and left of the model seat `DeepSeek-V41-Flash`.

**You choose what it watches.** Click the battery to cycle the sources (DeepSeek account → DeepSeek API → Kimi → back to account); the hover readout also offers clickable source chips, with the current source highlighted. The choice is stored in the browser and restored on restart; the battery no longer follows the model — switch models freely, it only watches the source you selected. Only the **first** launch adopts the provider the model currently bills to as the initial source (upgrades keep your existing view).

```
Before: [+]  [ Workspace write ⌄ ]                          DeepSeek-V41-Flash  High  [↑]

After:  [+]  [ Workspace write ⌄ ]  DeepSeek account ▮▮▮▮▮▮▮┊▮┊┊┊ ¥33.32   DeepSeek-V41-Flash  High  [↑]
Click:                              DeepSeek API ▮▮▮▮▮┊┊┊┊┊┊┊ ¥5.27  DeepSeek-V41-Flash  High  [↑]
Click again:                        Kimi ▮▮▮┊┊┊┊┊┊┊┊┊ ¥3.10          Kimi-K3.1-Pro      Max   [↑]
```

Hover (or focus with the keyboard) and the readout opens; it carries its own source switcher and shows:

- the source name and its available balance,
- a meter with the percentage of one full cell,
- the full-scale amount,
- the topped-up and granted components (cash and vouchers for Kimi),
- the update time,
- **source chips** and a **Refresh** button,
- a top-up link.

## How to read the battery

| Battery | Meaning |
|---|---|
| Green (≥ 50%) | `available / ¥10 ≥ 50%` — plenty left |
| Yellow (20%–50%) | time to top up |
| Red (< 20%) | running out |
| Grey/empty | signed out / no balance / read failed / no balance API — never fakes a 0 |
| Full green + amount above ¥10 | available beyond one full cell (e.g. ¥33.32): the cell caps at 100%, the readout still shows the real amount |

Ruler: **¥1 per cell**, ten cells, drawn **over** the fill, so both the spent and the remaining part stay countable.
`¥10` is `FULL_SCALE` at the top of `client.js` (with `FULL_CURRENCY = 'CNY'`); to change the unit (say ¥20 per top-up), edit those two constants.

The quantity shown is the **available total**: DeepSeek account = topped up + granted, DeepSeek API key = `total_balance`, Kimi = cash + vouchers. Granted/voucher parts are listed separately in the hover card.

## Switching the source by hand

The model selection is no longer the data source; it is used once, on the **first** launch (and only when the directory is ready and the provider has a balance API, so a half-parsed or interface-less provider is not frozen into a permanent choice). After that:

| Action | Effect |
|---|---|
| Click the battery | cycle: account → API → Kimi → account |
| Readout chips | jump straight to a source; the current one is highlighted |
| `Refresh` in the readout | re-read now (bypasses the host's 20 s cache) |
| Switch the model | battery unchanged — it only follows the source you picked |

The choice lives in `localStorage` (key `dsh-balance-battery/source`); if storage is unavailable it degrades to per-session only.

## Where the numbers come from

In one sentence: **the DeepSeek account goes through the host's existing `account` Remote; the two API-key routes go through this plugin's host-side balance routes.**

### 1) DeepSeek account (`account`)

The account credential and the Platform protocol belong to the host: `dsh-deepseek-account-platform` stores the grant and `dsh-api-account-controller` exposes a safe projection through the `account` Remote namespace — the same one the host's Settings → Account screen reads. This plugin is only a consumer:

```js
const state = await ctx.remote.account.getState()            // { status: 'signed-out' | 'credential-stored', links }
const value = await ctx.remote.account.getBalance(client())  // { status: 'ready', value: Wallet[], bonusWallets } | { status: 'failed' } | null
// Wallet = { currency: 'CNY' | 'USD', balance: '<decimal string>' }
```

The battery = sum of CNY top-up wallets + sum of CNY bonus wallets; `bonusWallets` are also listed separately in the hover card.

### 2) DeepSeek API key (`deepseek`)

The host route `GET /dsh-balance-battery/deepseek` resolves `DEEPSEEK_API_KEY` via `ctx.credentials`, calls `GET https://api.deepseek.com/user/balance`, and normalizes `total_balance` / `topped_up_balance` / `granted_balance` into one response.

### 3) Kimi (`kimi`)

The host route `GET /dsh-balance-battery/kimi` resolves `MOONSHOTAI_CN_API_KEY` (falling back to `MOONSHOT_API_KEY`, then `KIMI_API_KEY`), calls `GET https://api.moonshot.cn/v1/users/me/balance`, takes `available_balance`, and splits out `cash_balance` and `voucher_balance`.

**The key never reaches the browser**: the browser only gets amounts, the credential *name* that was used (e.g. `MOONSHOTAI_CN_API_KEY`) and the top-up link. Both routes pass `connection.requestRejection` (host/origin fence + login), then read the credential; a successful result is cached for 20 s, and the readout's `Refresh` sends `?fresh=1` to bypass it. The response looks like:

```json
{ "ok": true, "provider": "kimi", "ref": "MOONSHOTAI_CN_API_KEY", "currency": "CNY",
  "total": 5.26872, "recharge": 0.13433, "bonus": 5.1343904,
  "topUpUrl": "https://platform.kimi.com/console/account", "at": 1767220411000 }
```

Failures carry stable codes: `missing-credential` (with `refs`), `unauthorized`, `http` (with `status`), `network`, `timeout`, `bad-response`. The client turns these into concrete reasons ("no key found / key rejected / network error") instead of a 0.

## Interaction

| | Notes |
|---|---|
| Placement | `conversation.input.left` is a `list` slot (in the host's composer tool row, after the permission and Plan seats); the plugin registers one entry at `order: 10`. In a stock install the slot is empty, so nothing is covered. |
| Click the battery | cycle the source; if the new source has a cached amount, it shows first and refreshes in the background. |
| Hover / focus | open the readout: source, amount, percentage, full-scale amount, topped-up/granted (cash/vouchers for Kimi), update time, top-up link, **source chips** and a **refresh button**. The card portals to `document.body` and clamps to the viewport so the composer cannot clip it. |
| Refresh button | re-read now (the button shows "Reading…" and is disabled until the read settles; the host route is called with `?fresh=1`). |
| Memory | the manual choice is written to `localStorage` and restored on restart; the first launch adopts the provider the model was on. |
| Auto refresh | the active source every 60 s; once more when `visibilitychange` brings the window forward. Background refreshes do not pulse. |
| Fail loud | a render exception is shown at the seat as `battery render failed: …` instead of being swallowed by the slot; a read failure keeps the last good number and marks the reason in the readout. |

## Install

```powershell
# <DSH_DIR>    = where DeepSeek Harness is installed
# <PLUGIN_DIR> = this repository (the folder holding package.json)
& "<DSH_DIR>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "<PLUGIN_DIR>"

# Then fully quit and restart DeepSeek Harness Desktop (the profile is assembled at process start).
# On the author's machine, for example:
#   & "D:\deepseekHarness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\deepseek-Plugin development\balance-battery"
```

`dsh plugin add` puts the package into the profile's `node_modules` and adds `dsh-balance-battery` to `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`. Locally it is a `link:` dependency, so a `client.js` edit takes effect after restarting the app; **an `index.js` (host route) edit requires a full app restart** — reloading the page is not enough.

## Self-check and visual preview

Three browser-free dev tools (under `test/`, not shipped):

```powershell
# From the repo root (Node 18+; CI uses 22 and 24)
# 1) Client-half smoke: loads the real bundle, runs the real apply, renders the whole component and asserts behavior
node test/balance-smoke.mjs

# 2) Host-half smoke: captures the real registered routes and verifies keys, cache, fence and failure branches with scripted fetch/credentials
node test/host-smoke.mjs

# 3) Visual preview: reads the plugin's real stylesheet plus the host's real theme tokens and composer CSS to build static HTML
#    (without a local DSH install it degrades to a token-less sheet, but still emits HTML)
node test/preview.mjs
#    -> test/preview/{composer,states,zoom}-*.html
```

## Uninstall / rollback

Disable the bundle in the GUI's Plugins page, or:

```powershell
& "<DSH_DIR>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-balance-battery
```

After disabling, the composer tool row returns to its original state (the plugin only adds to an empty slot and changes no host control), and the two host-side balance routes are removed with the plugin.

## Files

| File | Purpose |
|---|---|
| `package.json` | bundle manifest: `dsh.bundle.patch` + `dsh.client` (`platform: web`, `immediately`, `inject` load order) + icon/locale exports. |
| `cordis.patch.yml` | inserts the plugin into the profile's layer stack. |
| `index.js` | host half: registers `/dsh-balance-battery/{deepseek,kimi}` on the local web server, resolves credentials, calls both balance endpoints, short cache + single-flight, with the connection fence first. |
| `client.js` | browser bundle: dictionaries, stylesheet, manual source switching (click-cycle + chips + localStorage memory), three balance channels (account Remote + two host routes), the battery component and the readout. |
| `locale/{en,zh}.json` | title and description shown on the plugin page. |
| `icon.svg` | plugin-page icon (a battery). |
| `test/balance-smoke.mjs` | browser-free smoke test for registration/manual switching/reading/rendering. |
| `test/host-smoke.mjs` | host-route test for credentials, cache, auth and failure branches. |
| `test/preview.mjs` | visual preview generator (real styles + real theme tokens + real composer CSS → screenshot-ready HTML). |
| `test/preview/*.png` | light/dark screenshots of the composer and each state. |

## Key constraints (pitfalls)

**1. `inject` declares only the required host services.**

The browser `ctx` is a guarded proxy: touching **any** host service that is not listed in `inject` throws `cannot get property "…" without inject`. This plugin reads the account projection, so it declares the same as the host's account page:

```js
const inject = ['slots', 'locale', 'remote', 'remote.account'];
```

`modelDirectories` is **deliberately not** in `inject`: it is read lazily via `ctx.get('modelDirectories')`, so a page without the model picker falls back to the DeepSeek account balance instead of losing the cell. The host side is the same: `inject = ['webServer']`, and `connection` / `credentials` are read lazily per request, so a missing one only makes one provider fail.

**2. A slot entry that throws = silent abdication.**

An exception thrown inside a slot entry is not shown to the user; the entry simply disappears and looks like "the plugin is not installed". So the component wraps itself in a fail-loud layer: a render exception shows `battery render failed: …` at the seat.

**3. `height:100%` on a `span` does not work.**

The fill is a `<span>`: a percentage height on an inline box is ignored, so the cell has width but stays invisible. `.dbb-fill` / `.dbb-tipFill` set `display:block` explicitly. This pitfall only shows up in a real render (a screenshot); the smoke test's assertions only see inline styles.

**4. The tick colour must work on both backgrounds.**

The ticks are drawn **over** the fill, so the same line must hold up on the white/dark background and on all three level colours. It uses `color-mix(in srgb, currentColor 26%, transparent)` (follows the theme and text colour), with a preceding `rgba(127,132,140,.5)` declaration as a fallback for engines without `color-mix`.

**5. A `client.js` edit needs a real page reload; an `index.js` edit needs an app restart.**

In a packaged install the client bundle bytes are re-fetched, but an **already-mounted plugin instance still runs the old code**; "takes effect without a reload" only holds in a source checkout with `pnpm run dev:web` running. Host routes are registered at process start, so reloading the page does not re-register them.

**6. The readout must portal.**

The composer card is a `position: relative` stacking context, so an absolutely positioned bubble is clipped/covered by it and the sticky footer; the readout uses `createPortal(..., document.body)` + `position: fixed` + viewport clamping, and keeps a 160 ms grace on pointer leave so the pointer can move into the card to click chips and the top-up link.

**7. API keys stay on the host side.**

The balance routes return amounts, not credentials; neither error logs nor responses contain the key. Both routes must pass `connection.requestRejection` before reading the credential — otherwise any local page could read your balance. The 20 s cache is shared by the 60 s poll and multiple battery instances; `?fresh=1` affects only that one read.

**8. The model directory throws by design; do not "grab it once and keep it".**

`directoryFor(sessionId)` throws `resolved no scope / no binding` before the session scope is ready. Putting "get the directory" and "use the directory" in the same try turns a startup jitter into permanent invisibility (a pitfall the sibling `effort-slider` hit). This plugin's tracker never throws: on failure it backs off and retries. In manual mode the directory is only used to **adopt the initial source once**, so the adoption condition is stricter: the directory is resolved (a real provider id) and the provider has a balance API; otherwise it does not adopt and keeps following the model view until it can.

**9. A missing split amount must not become 0 via `Number(null)`.**

The host route allows `recharge` / `bonus` to be `null` (some providers do not report the split). If the client did `Number(body.recharge)` it would get 0 and the readout would draw "Topped up ¥0.00". Every optional amount goes through `optionalAmount`: `null` / missing / empty stays missing.

## Known limitations

- **Only DeepSeek and Kimi**: other providers (OpenAI, Codex, …) have no balance endpoint wired; the battery shows a grey `No API` and never guesses a number.
- **Kimi is the CN site**: keys for `api.moonshot.cn` / `platform.kimi.com` and the international `api.moonshot.ai` / `platform.kimi.ai` are fully separate; mixing them returns 401.
- **The API-key routes depend on credential names**: DeepSeek uses `DEEPSEEK_API_KEY`; Kimi tries `MOONSHOTAI_CN_API_KEY`, then `MOONSHOT_API_KEY`, then `KIMI_API_KEY`. Renaming an env var requires editing `refs` at the top of `index.js`.
- **`account` needs a login**: when signed out the battery is grey and says "signed out"; switch to `deepseek` (API-key route) instead.
- **The full scale is a constant**: `FULL_SCALE` lives in `client.js` (not a config item — the client half has no row config).
- **The 60 s refresh is not real-time**: a spend can take up to 60 s to show; click `Refresh` in the readout to read now.
- **Two decimals**: providers return floats / decimal strings; the ratio uses the raw value and the readout is shown to two decimals (matching both backends).

The full list of engineering gaps, design trade-offs and improvement plans is in [ROADMAP.md](ROADMAP.md).
