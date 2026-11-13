# dsh-balance-battery · 余额电池

[![CI](https://github.com/WuRen-bridge/dsh-balance-battery/actions/workflows/ci.yml/badge.svg)](https://github.com/WuRen-bridge/dsh-balance-battery/actions/workflows/ci.yml)

中文 · [English](README.md)

> **DSH 专用插件**：本项目深度依赖 DeepSeek Harness 的**未公开内部 API**——浏览器侧的
> `window.__ModuleLoader__`、`ctx.remote.account`、`modelDirectories`，Host 侧的
> `ctx.credentials`、`connection.requestRejection`、`webServer`，以及宿主 `--dsw-*` 主题 token。
> 这些都不是稳定公开契约，可能随宿主升级而变动，插件也可能随之失效。它不是通用组件，只适用于安装了对应版本
> DeepSeek Harness 的环境。协议：MIT，见 [LICENSE](LICENSE)。

在 DeepSeek Harness 输入框的工具行里放一节电池：**满格 = 一次充值的钱（¥10）**，
电量是**你手动选定的余额来源**的可用总余额。电池按 **¥1 一格**切成 10 格刻度，所以除了看比例，还能直接数出"还剩几块钱"。
位置就是模型胶囊左边那段空白 —— 权限胶囊 `工作区内修改` 的右边、模型席位 `DeepSeek-V41-Flash` 的左边。

**看哪个自己选**：点一下电池就循环切换来源（DeepSeek 账号 → DeepSeek API → Kimi → 回到账号），
悬停读数卡里也有来源芯片可以直接点选，当前来源会高亮标出。选择记在浏览器本地，重启后还原；
不再跟着模型走 —— 模型随便切，电池只看你指定的那一家。只有**第一次**启动会沿用当前模型所走的供应商作为初始来源（升级不改变你原来的视角）。

```
之前： [+]  [ 工作区内修改 ⌄ ]                              DeepSeek-V41-Flash  High  [↑]

之后： [+]  [ 工作区内修改 ⌄ ]  DeepSeek 账号 ▮▮▮▮▮▮▮┊▮┊┊┊ ¥33.32   DeepSeek-V41-Flash  High  [↑]
点一下：                        DeepSeek API ▮▮▮▮▮┊┊┊┊┊┊┊ ¥5.27  DeepSeek-V41-Flash  High  [↑]
再点一下：                      Kimi ▮▮▮┊┊┊┊┊┊┊┊┊ ¥3.10          Kimi-K3.1-Pro      Max   [↑]
```

鼠标移上去（或键盘聚焦）—— 读数卡自带来源切换：

```
        ┌────────────────────────────────────────────┐
        │ DeepSeek 账号 可用余额               ¥33.32 │
        │ ████████████████████████ 100%               │
        │ 满格 ¥10.00                                 │
        │ 充值余额                              ¥10.07 │
        │ 赠送余额                              ¥23.24 │
        │ 更新于 22:33:31                             │
        │ 余额来源  [DeepSeek 账号] [DeepSeek API]     │
        │           [Kimi] [刷新]                     │
        │ 去 DeepSeek 充值 →                          │
        │ 点击电池切换来源；在此可直接选择或刷新        │
        └────────────────────────────────────────────┘
```

## 电量怎么读

| 电池 | 含义 |
|---|---|
| 绿（≥ 50%） | `可用余额 / ¥10 ≥ 50%`，还能跑不少 |
| 黄（20% ~ 50%） | 该准备充值了 |
| 红（< 20%） | 快见底 |
| 灰空 | 未登录 / 无余额 / 读取失败 / 没有余额接口 —— 不会假装成 0 元 |
| 满格绿 + 金额大于 ¥10 | 可用余额超过一个满格（例如 ¥33.32）：电池封顶 100%，读数仍是真实金额 |

刻度：**¥1 一格**，共 10 格，刻度线画在填充**之上**，所以花掉的部分和剩下的部分都数得清。
`¥10` 是 `client.js` 顶部的常量 `FULL_SCALE`（配套 `FULL_CURRENCY = 'CNY'`）：想换成别的口径（比如 ¥20 一充），改这两个常量即可。

口径是**可用总余额**：DeepSeek 账号 = 充值 + 赠送，DeepSeek API Key = `total_balance`，
Kimi = 现金 + 代金券。赠予/代金券部分在悬停卡里单独列出。

## 手动切换来源

模型选择不再是数据源，只在**第一次**启动时被沿用一次（而且仅当目录已就绪、供应商有余额接口时才沿用，
避免把"还没解析完"或"无接口"冻成永久选择）。之后：

| 动作 | 效果 |
|---|---|
| 点电池 | 循环切换：账号 → API → Kimi → 账号 |
| 读数卡芯片 | 直接跳到指定来源，当前来源高亮 |
| 读数卡 `刷新` | 立即重读当前来源（绕过 Host 20 秒缓存） |
| 切换模型 | 电池不变 —— 它只认你选的来源 |

选择存在 `localStorage`（键 `dsh-balance-battery/source`），存储不可用时退化为仅本次会话有效。

## 数字从哪来

三句话：**DeepSeek 账号走宿主已有的 account Remote；两个 API Key 路线走本插件 Host 侧的余额路由。**

### 1) DeepSeek 账号（`account`）

账号凭据与 Platform 协议由宿主自身拥有：`dsh-deepseek-account-platform` 保存 grant，`dsh-api-account-controller`
通过 Remote 命名空间 `account` 暴露安全投影 —— 也就是宿主「设置 → 账号」页读的那套。本插件只是它的消费者：

```js
const state = await ctx.remote.account.getState()            // { status: 'signed-out' | 'credential-stored', links }
const value = await ctx.remote.account.getBalance(client())  // { status: 'ready', value: Wallet[], bonusWallets } | { status: 'failed' } | null
// Wallet = { currency: 'CNY' | 'USD', balance: '<十进制字符串>' }
```

电池 = CNY 充值钱包之和 + CNY 赠送钱包之和；`bonusWallets`（赠送金额）同时单独列在悬停卡里。

### 2) DeepSeek API Key（`deepseek`）

宿主路由 `GET /dsh-balance-battery/deepseek` 用 `ctx.credentials` 解析 `DEEPSEEK_API_KEY`，
调用 `GET https://api.deepseek.com/user/balance`，然后把 `total_balance` / `topped_up_balance` / `granted_balance` 归一成同一个响应。

### 3) Kimi（`kimi`）

宿主路由 `GET /dsh-balance-battery/kimi` 解析 `MOONSHOTAI_CN_API_KEY`（找不到时依次试 `MOONSHOT_API_KEY`、`KIMI_API_KEY`），
调用 `GET https://api.moonshot.cn/v1/users/me/balance`，取 `available_balance`，并拆出 `cash_balance` 与 `voucher_balance`。

**密钥永远不进浏览器**：浏览器只拿到金额、被使用的凭据名（例如 `MOONSHOTAI_CN_API_KEY`）和充值链接。
两条路由都先过 `connection.requestRejection`（Host/Origin 栅栏 + 登录态），再读凭据；成功结果缓存 20 秒，
点读数卡的 `刷新` 发 `?fresh=1` 绕过缓存。响应形如：

```json
{ "ok": true, "provider": "kimi", "ref": "MOONSHOTAI_CN_API_KEY", "currency": "CNY",
  "total": 5.26872, "recharge": 0.13433, "bonus": 5.1343904,
  "topUpUrl": "https://platform.kimi.com/console/account", "at": 1767220411000 }
```

失败也带稳定的错误码：`missing-credential`（附 `refs`）、`unauthorized`、`http`（附 `status`）、
`network`、`timeout`、`bad-response`。客户端据此给出"没找到密钥 / 密钥被拒 / 网络错误"等具体原因，而不是一个 0。

## 交互

| | 说明 |
|---|---|
| 摆放 | `conversation.input.left` 是一个 `list` 插槽（宿主输入框工具行中，权限席位与 Plan 席位之后），本插件注册 `order: 10` 的一个条目；该插槽在原生安装下本来是空的，所以不遮蔽任何东西。 |
| 点电池 | 循环切换来源；切换后若该来源有缓存金额先显示，再后台刷新。 |
| 悬停 / 聚焦 | 打开读数卡：来源、金额、百分比、满格金额、充值/赠送（Kimi 为现金/代金券）、更新时间、充值链接、**来源芯片**与**刷新按钮**。卡片 portal 到 `document.body` 并用视口钳位，不会被输入框裁掉。 |
| 点击刷新按钮 | 立即重读当前来源（按钮显示"正在读取…"并禁用，直到这次读取结束；Host 路由被 `?fresh=1` 绕过缓存）。 |
| 记忆 | 手动选择写进 `localStorage`，重启还原；首次启动沿用当时模型所走的供应商。 |
| 自动刷新 | 激活来源每 60 秒一次；窗口 `visibilitychange` 回到前台时再读一次。后台刷新不脉动。 |
| 失败明说 | 渲染异常会在席位位置显示 `battery render failed: …`，而不是被插槽静默吞掉；读取失败会保留上一次的好数字并在读数卡里标注原因。 |

## 安装

本插件按 **Windows 优先** 设计：以下命令假定 Windows PowerShell。

```powershell
# <DSH 安装目录> = DeepSeek Harness 的安装位置
# <插件目录>     = 本仓库目录（含 package.json 的那个）
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "<插件目录>"

# 然后完全退出并重启 DeepSeek Harness Desktop（进程启动时才组装 profile）
# 作者本机示例（把两个路径换成你自己的即可）：
#   & "D:\deepseekHarness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\deepseek-Plugin development\balance-battery"
```

`dsh plugin add` 会把包装进 profile 的 `node_modules`，并把 `dsh-balance-battery` 写进
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。本机是 `link:` 依赖，
改完 `client.js` 重启应用即可生效；**改完 `index.js`（Host 路由）必须重启应用**，刷新页面不够。

## 自检与外观预览

三个不依赖浏览器的开发工具（`test/` 下，不随包发布）：

```powershell
# 在仓库根目录执行（需要 Node 18+；CI 用 22 / 24）
# 1) 浏览器半侧冒烟：加载真实 bundle、跑真实 apply、渲染整个组件并断言行为
node test/balance-smoke.mjs

# 2) Host 半侧冒烟：捕获真实注册的路由，用脚本化的 fetch/凭据验证密钥、缓存、栅栏与失败分支
node test/host-smoke.mjs

# 3) 外观预览：抓取插件真实样式表 + 宿主真实主题 token 与输入框真实 CSS，拼出静态 HTML
#    （本机没装 DSH 时会退化为无 token 的样式表，仍能生成 HTML）
node test/preview.mjs
#    -> test/preview/{composer,states,zoom}-*.html
```

## 卸载 / 回退

在 GUI 的「插件」页里禁用该 bundle，或者：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-balance-battery
```

禁用后输入框工具行立刻恢复原样（本插件只往空插槽里加东西，没有改动宿主任何控件），
Host 侧注册的两条余额路由也会随插件卸载一起移除。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（`platform: web`、`immediately`、`inject` 声明加载顺序）+ 图标/本地化资源导出。 |
| `cordis.patch.yml` | 把本插件插入 profile 的 layer 栈。 |
| `index.js` | Host 半边：在本地 web server 上注册 `/dsh-balance-battery/{deepseek,kimi}`，解析凭据、调用两家余额接口、短缓存 + 单飞，并先过连接栅栏。 |
| `client.js` | 浏览器 bundle：字典、样式表、手动来源切换（点击循环 + 芯片点选 + localStorage 记忆）、三条余额读取通道（账号 Remote + 两条 Host 路由）、电池组件、读数卡。 |
| `locale/{en,zh}.json` | 插件页显示的标题与描述。 |
| `icon.svg` | 插件页图标（一节电池）。 |
| `test/balance-smoke.mjs` | 无浏览器依赖的注册/手动切换/读取/渲染冒烟测试。 |
| `test/host-smoke.mjs` | Host 路由的凭据、缓存、鉴权与失败分支测试。 |
| `test/preview.mjs` | 外观预览生成器（真样式 + 真主题 token + 真输入框 CSS → 可截图的 HTML）。 |
| `test/preview/*.png` | 明暗两套主题下的输入框实景与各状态对照图。 |

## 关键约束（踩坑记录）

**1. `inject` 只声明必需的宿主服务。**

浏览器 `ctx` 是一个受守卫的代理：从本插件出发访问到的**任何**宿主服务，只要不在 `inject` 里声明，就会抛
`cannot get property "…" without inject`。本插件读账号投影，所以声明与宿主账号页一致：

```js
const inject = ['slots', 'locale', 'remote', 'remote.account'];
```

`modelDirectories` **刻意不放进 inject**：它通过 `ctx.get('modelDirectories')` 懒取，页面没有模型选择插件时
电池退回 DeepSeek 账号余额，而不是整块消失。Host 侧同理：`inject = ['webServer']`，
`connection` 与 `credentials` 都在请求时懒取，缺了也只会让某个供应商报错。

**2. 插槽条目渲染抛异常 = 静默退让。**

slot 条目里抛出的异常不会显示给用户，条目直接消失、看起来像"插件没装"。所以组件套了一层 fail-loud：
渲染异常时在席位位置显示 `battery render failed: …`。

**3. `span` 上的 `height:100%` 不会生效。**

电池的填充条是 `<span>`：inline 盒子的高度百分比被忽略，于是"有宽度却看不见"。`.dbb-fill` / `.dbb-tipFill`
都显式 `display:block`。这个坑只有真渲染出来（截图）才发现，冒烟测试的断言看到的是内联样式。

**4. 刻度线要用"两种底色上都成立"的颜色。**

刻度叠在填充**上面**，同一根线既要压得住白/深色底、又要压得住绿/黄/红三档填充，所以用
`color-mix(in srgb, currentColor 26%, transparent)`（跟随主题与文字色），并保留一条
`rgba(127,132,140,.5)` 的前置声明给不支持 `color-mix` 的环境兜底。

**5. 改完 `client.js` 需要真正重新加载页面；改完 `index.js` 必须重启应用。**

打包安装版里客户端插件的字节会被自动重新抓取，但**已经挂载的插件实例仍跑旧代码**；
「无需刷新即生效」只在源码 checkout 且 `pnpm run dev:web` 在跑时成立。Host 路由是进程启动时注册的，刷新页面不会重注册。

**6. 读数卡要 portal。**

输入框所在的卡片是 `position: relative` 的层叠上下文，绝对定位的气泡会被它和粘性底栏裁掉/压住；
读数卡用 `createPortal(..., document.body)` + `position: fixed` + 视口钳位，并在指针离开时留 160ms 宽限，
这样指针可以移进卡片点芯片和充值链接。

**7. API Key 只能留在 Host 侧。**

余额路由返回的是金额，不是凭据；错误日志与响应都不含密钥。两条路由必须先过 `connection.requestRejection`
再读凭据，否则任意本地页面都能读到你的余额。20 秒缓存是给 60 秒轮询和多个电池实例共用的，
`?fresh=1` 只影响这一次读取。

**8. 模型目录会按设计抛错，不能"抓一次揣着用"。**

`directoryFor(sessionId)` 在会话作用域就绪前会抛 `resolved no scope / no binding`。
把"取目录"和"用目录"塞进同一个 try，会把一次启动期抖动放大成永久隐身（这是同工作区 effort-slider 踩过的坑）。
本插件的跟踪器永不抛错：失败就退避重试。手动模式下目录只用来**沿用一次**初始来源，
所以沿用条件更严格：目录已解析（拿到真实 provider id）且供应商有余额接口，否则不沿用、继续跟随模型视图直到可以为止。

**9. 缺失的拆分金额不能被 `Number(null)` 变成 0。**

Host 路由允许 `recharge` / `bonus` 为 `null`（比如某家不报充值拆分），客户端若直接 `Number(body.recharge)` 会得到 0，
读数卡就会画出一行"充值余额 ¥0.00"。所有可选金额都走 `optionalAmount`：`null` / 缺字段 / 空串保持缺失。

## 已知限制

- **只覆盖 DeepSeek 与 Kimi**：其它供应商（OpenAI、Codex 等）没有接余额接口，电池显示灰色的 `无接口`，不猜数字。
- **Kimi 两站 Key 独立**：优先 `api.moonshot.cn`，被拒（401/403）或不可达时自动回退 `api.moonshot.ai`；两站的 Key 与充值页（`platform.kimi.com` / `platform.kimi.ai`）互不通用。
- **API Key 路线依赖凭据名**：DeepSeek 用 `DEEPSEEK_API_KEY`；Kimi 依次尝试 `MOONSHOTAI_CN_API_KEY`、`MOONSHOTAI_API_KEY`、`MOONSHOT_API_KEY`、`KIMI_API_KEY`。
  改名或换环境变量需要改 `index.js` 顶部的 `refs`。
- **`account` 依赖登录**：账号未登录时电池是灰空并写明「未登录」；这时可切到 `deepseek`（API Key 路线）。
- **满格按币种是常量表**：`FULL_SCALE_BY_CURRENCY`（CNY 10 / USD 10）写在 `client.js` 里，不做成配置项。
- **60 秒刷新并不实时**：花钱后最多 60 秒才更新，想立刻看就点读数卡里的 `刷新`。
- **金额显示两位小数**：Provider 返回浮点/十进制字符串，电池比例用原值，读数按两位显示（与两家后台一致）。

工程短板、设计取舍与改进路线的完整清单见 [ROADMAP.md](ROADMAP.md)。
