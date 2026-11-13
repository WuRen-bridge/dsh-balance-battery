# Roadmap · 已知短板与改进路线

本文件是 `dsh-balance-battery` 1.2.0 开源时的工程自评：哪些已修、哪些计划中、哪些是有意取舍。
按**影响**排序，不按实现难度。

## P0 · 已修复

- **请求栅栏由 fail-open 改为 fail-closed**（`index.js`）
  - 原先 `connection` 服务缺失时直接放行，任意同源本地页面都能读到余额。
  - 现在缺服务即返回 `403`：宁可拒绝，也不泄露。
  - `test/host-smoke.mjs` 新增用例覆盖该分支。

## P1 · 计划中（结构性）

| 项 | 现状 | 目标 |
|---|---|---|
| 拆分 `client.js`（1310 行） | 内联 CSS + 中英字典 + tracker + channel + 组件同处一文件 | 按职责分模块；`BUBBLE_WIDTH` 与 CSS `width:244px` 的耦合改为单一来源 |
| 英文 README | 只有中文 | 补 `README.en.md`，国际访客可读 |
| 安装说明去本机化 | 硬编码 `D:\deepseekHarness\…`、`D:\deepseek-Plugin development\…`，只给 Windows | 通用路径 + 多平台说明 |
| 满格口径可配置 | `FULL_SCALE` / `FULL_CURRENCY` 写死 ¥10 / CNY，USD 账户比例失真 | 至少按币种取满格；理想做成配置 |

## P2 · 计划中（小项）

- **空钱包不显示 ¥0.00**：`account` 返回 `ready` 但钱包数组为空时，应显示"无余额"而非把 `null` 当 0。
- **气泡角色改为 `dialog` / popover**：`role="tooltip"` 内含按钮与链接不符合规范，屏幕阅读器行为不确定。
- **429 / 限流单独报错**：现在混进通用 `http`。
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

## 已知限制

与 [README.md](README.md) 的「已知限制」一节一致：宿主内部 API 依赖、Kimi 国内站、凭据名硬编码、满格常量等。
