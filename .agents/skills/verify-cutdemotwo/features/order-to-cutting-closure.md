# 下单到完工记账全流程闭环

覆盖真实车间主链路：录入需求形成待排需求族 → 带预设门幅直入搭切工作台并配置算法求解 → 选定方案零重算即时扣减待排量 → 在结果中心预览全量 A4 车间派工裁切单 → 按方案新建待检母卷并严守“未质检禁绑卷” → 质检放行后绑实卷并经二次确认弹窗一键完工记账 → 查看母卷空间切割区与原地打开设置弹窗。

## Sub-features

- `FLOW-01`：5 组导航分组文案核验与全路由只读漫游（含窄/宽视口零横向溢出）。
- `FLOW-02`：新建订单（`#/demands`）提交后持久化入 `/api/v2/demand-pool`，预设 1800mm 门幅带入工作台，且 `#/demand-library` 按维度与状态筛选准确。
- `FLOW-03`：搭切工作台（`#/workbench`）保持默认精简布局（流程引导默认收起、开始排版锚定右下底栏），支持切换策略、查看「具体需求概览」、选定方案将 `openTotal` 即时转为 `plannedTotal`（三态守恒）。
- `FLOW-04`：结果管理（`#/results`）支持无截断 A4 车间派工单预览（含 `WO-<schemeId>` 与矢量排料 SVG）；按方案新建母卷必须默认 `PENDING` 且不可绕过质检直接锁定，经质检 `PASSED` 后方可绑定转为 `READY_TO_CUT`。
- `FLOW-05`：一键完工记账必须弹出显式二次确认 `<dialog>`（严禁原生 `window.confirm`），确认后方案转完工、`plannedTotal → completedTotal`，母卷 `/api/rolls/{id}/spatial-map` 与 `#/inventory?roll=<id>` 展示已切割区域。
- `FLOW-06`：原生 `<dialog>` 设置弹窗支持左侧 5 Tab 切换、工艺预设联动、本地持久化与 `Escape` 关闭，且不离开当前路由。

## How to get to it (user POV)

- 订单创建与池化：`新建订单`（`#/demands`）→ `待排订单`（`#/demand-library`）
- 排料与选定：`搭切工作台`（`#/workbench`），支持 2D 虚拟新卷、在库母卷、料头与第 4 种投料源「多料联排」（注：`unified-workflow` 自动化脚本覆盖虚拟新卷链路；外部试排深链 `#/workbench?taskId=&resultId=&draftId=` 见 [`workbench-orchestration-mcp-and-deeplink.md`](./workbench-orchestration-mcp-and-deeplink.md)）
- 绑卷、派工单与完工：`方案与工单`（`#/results`）→ 选定方案 → 打印 A4 派工单 / 新建待检卷 / 绑定合格卷 / 一键完工记账
- 空间消耗复核：`卷料台账`（`#/inventory?roll=<rollId>`）查看已切割空间条
- 系统设置：**左侧导航栏底部** `nav-foot` 的引擎状态胶囊 `#engine-status` 或设置入口

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已通过 `verify-ctl.mjs launch` 启动全新隔离实例且 `doctor` 返回 `HEALTHY`。

- **执行端到端 5 阶段主业务闭环**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script unified-workflow`
  - 可观测结果：退出码 `0`；输出包含 5 个 `PASS:` 阶段且末尾 JSON 为 `"executed": 5, "passed": 5, "failed": 0, "skipped": 0`。
- **交叉核对账本守恒（只读）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs doctor --session "<sessionFile>"`
  - 可观测结果：`ledger_reconciliation_balanced` 为 `true`，`prod_inventory_untouched` 为 `true`。

## Gotchas

- 本脚本会向隔离实例写入新订单、排程方案、母卷与报工记录，因此建议在全新隔离实例上运行，不要在已充满脏状态的同一实例上重复跑导致同名混淆。
- 为保证跨平台无 C++ 原生引擎也能稳定快速完成，脚本会通过设置弹窗仅勾选内置「快速基线 (`JAVA_FAST`)」策略（DOM `id="cfg-strategy-JAVA_FAST"`）再求解；本脚本通过**不等于**原生 C++ `packingsolver` 二进制已验证。
- `unified-workflow` 在 `FLOW-04` 阶段通过后端 API 快速将新建待检卷置为 `PASSED`；如需验证 `#/inspection` 页面质检放行或「多料联排」UI 交互，请另行专项验真。
- 若页面任何地方误调用了 `window.confirm` / `window.alert`，脚本的 `nativeDialogs` 断言会直接失败。
