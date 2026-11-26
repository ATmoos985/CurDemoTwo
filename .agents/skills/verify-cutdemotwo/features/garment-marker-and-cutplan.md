# 服装多门幅唛架对比与订单自动分床

提供纯计算不写库的服装工艺试验台：对比不同门幅下固定方向与 180° 掉头排料利用率、支持同款裁片补空、覆盖全部内置及 DXF 服装版型（含四大件 16 片直链与实算），并在第二 Tab 承接多颜色×多尺码订单自动分床与尺码守恒核对。

## Sub-features

- `GARM-01`：「允许 180° 旋转」复选框鼠标/键盘交互与参数帮助浮层不破坏已选状态。
- `GARM-02`：非法每床套数参数前端拦截禁止提交；提交后支持编辑清空结果与中途停止后续门幅队列。
- `GARM-03`：单门幅失败结果保留可见，且不阻塞后续合法门幅继续计算。
- `GARM-04`：全部内置与 DXF 服装示例正确回填表单并产出齐套排料图，准确对比固定倒顺毛与 180° 掉头利用率及掉头片数。
- `GARM-05`：四大件 16 片直链与按 `130`/`140` 配码实算展示固定与掉头方案及独立报告参考值。
- `GARM-06`：顶栏切换第二 Tab「订单自动分床」（`GarmentCutPlanPanel`）测算颜色×尺码床数与层数守恒，切回第一 Tab 零回归。

## How to get to it (user POV)

- 左侧导航展开 `工艺试验` → 点击 `服装唛架`（`#/garment`）。
- 顶栏 `SegmentedControl` 可在「多门幅唛架对比（默认）」与「订单自动分床」间无损切换。
- 支持通过示例下拉框选择内置或 DXF 版型，也支持直链参数打开四大件示例。

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已启动隔离实例且 `doctor` 返回 `HEALTHY`；本机环境需具备 `playwright/test`（`@playwright/test`），可通过 `doctor` 输出中的 `environment.playwrightTestModule` 确认。

- **执行服装唛架全量 28 项真机测试**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script garment-width`
  - 可观测结果：退出码 `0`；`node --test` 输出全部顶层与子测试通过（失败 0、跳过 0），纯求解接口不写入库存。
- **可选截图取证**：直接运行 `garment-width.cjs` 时可传环境变量 `SCREENSHOT_PATH`、`REFERENCE_SCREENSHOT_PATH`、`FOUR_PIECE_SCREENSHOT_PATH` 将关键排料图保存到 `evidenceDir`。

## Gotchas

- `garment-width.cjs` 第 7 行依赖 `playwright/test`（需要 `expect` 断言库），而另外 3 个脚本仅需 `playwright` / `playwright-core`。若某台机器仅装了 `playwright-core` 未装 `playwright/test`，`verify-ctl.mjs` 会明确报错提示缺失前置，切勿忽略或假报通过。
- 该脚本包含多轮真实异形排样求解，单次全量执行通常需要 1~3 分钟，请勿因短时等待而误判超时。
- 若需单独验证「订单自动分床」API 守恒，可在隔离实例上直接调用只读端点 `POST /api/v2/planning/cut-plan` 并核对尺码总数一致。
