---
routes:
  - garment
---

# 服装多门幅唛架对比与订单自动分床

提供服装工艺试验台：第一 Tab 对比不同门幅下固定方向与 180° 掉头排料利用率、支持同款裁片补空、覆盖全部 18 个内置及 DXF 服装版型（含四大件 16 片直链与实算，纯计算不写库）；第二 Tab 承接单色多尺码（款号 + 颜色 + 尺码矩阵）订单自动分床与尺码守恒核对（分床试算本身纯计算，仅点击右上角「生成待排需求族并转工作台 →」时会写需求池 `POST /api/v2/demand-pool`）。

## Sub-features

- `GARM-01`：「允许 180° 旋转」复选框鼠标/键盘交互与参数帮助浮层不破坏已选状态。
- `GARM-02`：非法每版件数（1–12 件/版）前端拦截禁止提交；提交后支持编辑清空结果与中途停止后续门幅队列。
- `GARM-03`：单门幅失败结果保留可见，且不阻塞后续合法门幅继续计算。
- `GARM-04`：全部内置（10）与 DXF（8）共 18 个服装示例正确回填表单并产出齐套排料图，准确对比固定倒顺毛与 180° 掉头利用率及掉头片数。
- `GARM-05`：四大件 16 片直链（`#/garment/four-piece-130-140`）与按 `130`/`140` 配码实算展示固定与掉头方案及独立报告参考值。
- `GARM-06`：顶栏 `SegmentedControl`（`aria-label="服装唛架功能切换"`）切换第二 Tab「订单自动分床」（`GarmentCutPlanPanel`）测算单色多尺码床数与层数零超裁守恒，切回第一 Tab 保留原示例与表单零回归。
- `GARM-07`：订单自动分床测算完成后点击「生成待排需求族并转工作台 →」，调用 `POST /api/v2/demand-pool` 写入待排需求族（返回 `200` 且 `lines` 非空）并自动跳转 `#/workbench` 载入该需求族，零库存扣减。

## How to get to it (user POV)

- 左侧导航展开 `工艺试验` → 点击 `服装唛架`（`#/garment`）。
- 顶栏 `SegmentedControl` 可在「多门幅唛架对比（默认）」与「订单自动分床」间无损切换。
- 支持通过示例下拉框选择内置或 DXF 版型，也支持直链参数打开四大件示例。

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已启动隔离实例且 `doctor` 返回 `HEALTHY`；运行 `garment-width` 前本机环境需具备 `playwright/test`（`@playwright/test`），可通过 `doctor` 输出中的 `environment.playwrightTestModule` 确认。

- **执行服装唛架对比全量 28 项真机测试（覆盖 `GARM-01..05`）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script garment-width`
  - 可观测结果：退出码 `0`；`node --test` 输出 `tests 28 / pass 28 / fail 0 / skipped 0`，纯求解接口不写入库存。
- **执行第二 Tab 订单自动分床、切回零回归与转需求池写库联动（覆盖 `GARM-06..07`）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script deeplink-and-cutplan`
  - 可观测结果：退出码 `0`；`GARM-06` 与 `GARM-07` 步骤均通过（`[aria-label="尺码守恒核对条"]` 显示「全部尺码精准守恒」，切回第一 Tab 保留 `shirt-three`，点击转工作台写库 `POST /api/v2/demand-pool` 返回 `200` 并跳转 `#/workbench`）。
- **可选截图取证**：直接运行 `garment-width.cjs` 时可传环境变量 `SCREENSHOT_PATH`、`REFERENCE_SCREENSHOT_PATH`、`FOUR_PIECE_SCREENSHOT_PATH` 将关键排料图保存到 `evidenceDir`。

## Gotchas

- `garment-width.cjs` 仅覆盖 `GARM-01..05`，**不包含**第二 Tab「订单自动分床」；验证 `GARM-06..07` 必须配合 `deeplink-and-cutplan` 脚本或直接调用 `POST /api/v2/planning/cut-plan` / `POST /api/v2/demand-pool`。
- `garment-width.cjs` 第 7 行依赖 `playwright/test`（需要 `expect` 断言库），而另外 3 套现役脚本与 `deeplink-and-cutplan` 仅需 `playwright` / `playwright-core`。若缺少 `playwright/test`，`verify-ctl.mjs` 会明确报错提示缺失前置，切勿忽略或假报通过。
- `garment-width` 包含多轮真实异形排样求解，单次全量执行通常需要 2~4 分钟，请勿因短时等待而误判超时。
