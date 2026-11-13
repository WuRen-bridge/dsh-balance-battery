# Roadmap · 已知短板与改进路线

本文件是 `dsh-balance-battery` 1.2.0 开源时的工程自评：哪些已修、哪些计划中、哪些是有意取舍。
按**影响**排序，不按实现难度。

## 已修复

- **请求栅栏由 fail-open 改为 fail-closed**（`index.js`）
  - 原先 `connection` 服务缺失时直接放行，任意同源本地页面都能读到余额。
  - 现在缺服务即返回 `403`：宁可拒绝，也不泄露。
  - `test/host-smoke.mjs` 新增用例覆盖该分支。
- **空钱包 / 不可解析余额不再显示 ¥0.00**（`client.js`）
  - `account` 返回 `ready` 但钱包列表为空（或全部不可解析）时，进入新的 `empty` 相位，显示「无余额」并灰显，而不是把 `null` 当 0。
  - `test/balance-smoke.mjs` 覆盖空钱包与恶意小数两个分支。
- **429 / 限流单独报错**（`index.js` + `client.js`）
  - Host 侧遇到 `429` 返回 `rate-limited`（附 `status`），客户端提示「余额接口被限流（429）」，不再混进通用 `http`。
- **气泡角色改为 `dialog`**（`client.js`）
  - `role="tooltip"` → `role="dialog"` 并补 `aria-label`：气泡内含按钮与链接，按规范应是对话框而非纯提示。
- **英文 README 成为默认**：`README.md` 为英文，中文在 `README.zh.md`（顶部有语言切换）；安装 / 自检 / 卸载命令去本机化。
- **Kimi 支持国际站**（`index.js`）：`.cn` 被拒（401/403）或不可达（network/timeout）时，自动重试 `api.moonshot.ai`，并识别 `MOONSHOTAI_API_KEY` 别名。
- **满格金额与刷新间隔可配置**（`client.js`）：读数卡新增「设置」，满格金额与刷新间隔（秒，0 = 关闭）存 `localStorage`；默认 ¥10 / 60 秒，USD 账户按同一设置显示 `$`。

## P1 · 计划中（结构性）

| 项 | 现状 | 目标 |
|---|---|---|
| 拆分 `client.js`（~1320 行） | 内联 CSS + 中英字典 + tracker + channel + 组件同处一文件（已有分区索引） | 按职责分模块；需引入打包器（esbuild），会破坏"改完重启即生效"的开发流。触发条件：文件 > ~2000 行、或接 3 家以上供应商 |

## P2 · 计划中（小项）

- **`?fresh=1` 限频**：同源脚本可反复刷、绕过 20s 缓存并消耗供应商额度。
- **补 CHANGELOG / CONTRIBUTING / issue 模板 / tag 发版**。
- **触屏可达性**：读数卡的来源芯片 / 刷新依赖 hover，纯触屏够不到。
- **消除测试重复**：`balance-smoke.mjs` 与 `preview.mjs` 各有一份假 React。
- **视觉回归**：CI 只跑 smoke，测不到真实 DOM / 宿主集成（`height:100%` 那个坑靠截图才发现）。

## 有意为之（不是 bug）

- **只接 DeepSeek + Kimi**：其它供应商没有余额接口，灰显"无接口"而不猜数字。
- **60 秒轮询**：不实时，但避免频繁打接口；点刷新可即时。
- **读失败保留上次好数字**：电池仍显示旧值（读数卡标 stale），是"一眼可读"与"绝不显示 0"之间的取舍。
- **`private: true`、不上 npm**：只走 GitHub 源码分发。
- **单文件、纯 JS、无构建**：可直接作为宿主客户端 bundle 加载，代价是维护成本。
- **Windows 优先**：安装 / 卸载只给 Windows PowerShell 的写法——目标用户是 DSH Desktop 的 Windows 用户，不为 macOS / Linux 做投机性适配。

## 已知限制

与 [README.zh.md](README.zh.md) 的「已知限制」一节一致：宿主内部 API 依赖、Kimi 两站、凭据名硬编码、满格常量表等。
