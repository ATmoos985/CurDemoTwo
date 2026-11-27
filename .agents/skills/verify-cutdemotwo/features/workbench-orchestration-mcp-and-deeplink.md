---
routes:
  - workbench
  - slitting
---

# 工作台编排求解、1D 分条排产、25 工具工业 MCP 与草案收件箱闭环

验证阶段一（`542fa5c..c6c5a94`）与路线 A 阶段二新增的外部 Harness 协同与工作台闭环：后端 `/api/v2/workbench/**` 9 端点无环编排求解、多母卷连续接力批量草案、草案列表/确认/作废与滚动清理（File `.drafts/` 与 MySQL V12）→ `integrations/mcp` 25 工具四开关权限隔离、零依赖 PNG 蓝图预览与显式故障回报 → 浏览器打开 `#/workbench?taskId=...&resultId=...` / `&draftId=...` 深链或在工作台「待审草案」收件箱抽屉按批组浏览、预览、作废与「选定此方案」联动确认落库。

## Sub-features

- `WB-01`：`POST /api/v2/workbench/tasks/{taskId}/plan-jobs` 按任务待排余量自动装配 2D（矩形直刀外扩/异形带孔）或 1D 求解作业，严格 `422 MATERIAL_NOT_READY` 拦截未放行 `PENDING` 卷、报废卷或不可用料头。
- `WB-02`：`GET /api/v2/workbench/tasks/{taskId}/result-comparison` 返回逐规格应排/已排/缺件与同口径物理占长对比，条件不同或未双齐套时抑制节省量。
- `WB-03`：`POST/GET /api/v2/workbench/drafts` 持久化待人工确认草案（`status="PENDING_CONFIRMATION"`、`requiresHumanConfirmation=true`、`inventoryMutated=false`），支持 TTL `EXPIRED` 与库存/任务 revision 漂移 `stale=true` 动态探测，且不写入或扣减实物库存。
- `WB-04`：草案阶段二闭环与定时清理：`GET /api/v2/workbench/drafts` 倒序分页过滤（含全局 `pendingCount`）、`POST /api/v2/workbench/drafts/{draftId}/confirm` & `/discard` 原子 CAS 跃迁（非待确认/过期返回 `409`）、`POST /api/v2/schemes/confirm` 传 `draftId` 联动回写 `CONFIRMED` 及 `@Scheduled` 滚动过期标态与物理清理。
- `WB-05`：多料头接力 + 多母卷连续接力批量草案：`POST /api/v2/planning/multi-material`（`continueAcrossRolls=true` 跳过去重并跨卷连续接力）与 `POST /api/v2/workbench/multi-material-drafts` 经 `OptimizationService` 同步归档生成 `resultId` 及共享 `batchGroupId` 草案组，零锁扣实物库存。
- `MCP-01`：`integrations/mcp` 25 工具严格按 4 个宿主环境变量开关（`COMPUTE`/`BUSINESS_READ`/`ALLOW_DRAFT_SCHEME`/`ALLOW_DEMAND_WRITE`）隔离，无静默吞错（显式返回 `partialErrors`/`degraded`），并暴露 2 份 Resource（含 `cutting://guides/operations`）与 3 个标准 Prompts。
- `MCP-02`：零依赖纯 JS PNG 渲染器（`preview-png.mjs`）随 `plan_task_on_material`、`plan_multi_material_drafts` 与 `render_cutting_preview` 返回合法 `image/png` 排料缩略图与工作台直达深链 `workbenchUrl`。
- `MCP-03`：阶段二草案协同 3 工具：`list_draft_schemes`（`BUSINESS_READ`）、`discard_draft_scheme`（`ALLOW_DRAFT_SCHEME`，透传 409 冲突且审计日志不落盘原因明文）、`plan_multi_material_drafts`（`COMPUTE+BUSINESS_READ+ALLOW_DRAFT_SCHEME`，并发渲染前 N 份 PNG 预览）。
- `DEEP-01`：打开 `#/workbench?taskId=...&resultId=...` 渲染 `[data-testid="external-plan-banner"]`（「外部试排方案预览（尚未锁库）」）与四层 Konva 蓝图，零写库请求。
- `DEEP-02`：打开 `#/workbench?taskId=...&draftId=...` 展示持久化草案号、有效期、同批组切换条（`[data-testid="banner-sibling-*"]`）与风险预检列表。
- `DEEP-03`：关联任务或库存版本变更后重新打开草案深链，触发 `[data-testid="external-plan-stale-alert"]` 醒目版本漂移告警条；已作废草案展示 `[data-testid="external-plan-discarded-alert"]` 并禁用「选定此方案」。
- `DEEP-04`：打开有效待确认草案深链 `#/workbench?taskId=...&draftId=...` 并点击工作台「选定此方案」，触发 `POST /api/v2/schemes/confirm` 携带 `draftId` 联动落库回写 `CONFIRMED`（按钮转为 `查看结果 · <schemeId>`），且二次作废该草案返回 `409 DRAFT_ALREADY_CONFIRMED`。
- `SLIT-01`：访问 `#/slitting`（`CuttingWorkbenchPage` 强制 `1D` 模式，`一维分切` 激活），支持加载/新增 `SLITTING_1D` 需求规格、`VIRTUAL_ROLL` 与 `STOCK_ROLL` 选材及刀架物理约束配置。
- `SLIT-02`：1D 边界拦截：切边之和超母卷幅宽、条宽小于机台最小物理刀距、危险细边丝禁区仅填下限缺上限时前端零请求拦截提示，且后端 `POST /api/v2/optimization-jobs`（`SLITTING_1D`）对切边越界、单边禁区与超产超限（`> 10000`）返回 `400 INVALID_INPUT`。
- `SLIT-03`：1D 选用已放行含疵点实卷求解并选定落库，待排量 `openTotal → plannedTotal` 精准扣减，并在 `#/results/<schemeId>` 导出 `分切机PLC排刀配方-<schemeId>.csv`（UTF-8 BOM 与 9 列中文表头）。
- `INBOX-01`：工作台顶栏「待审草案」计数微标按钮（`[data-testid="draft-inbox-trigger"]`）打开滑出抽屉（`[data-testid="draft-inbox-drawer"]`），支持状态过滤、批组聚合与一键跳转工作台画布预览。
- `INBOX-02`：抽屉与顶部横幅支持打开原生 `<dialog>` 作废弹窗（`DraftDiscardDialog`），必填/快捷选择 `discardReason` 后原子作废且零扣库存。
- `INBOX-03`：工作台「多料联排」总览卡提供「生成联排草案组」次级按钮（`[data-testid="generate-multi-drafts-btn"]`）触发跨卷接力批量草案并在预览后通过「选定此方案」携带 `draftId` 自动闭环回写 `CONFIRMED`。

## How to get to it (user POV)

- 外部本机 Harness（Codex / Claude Desktop / Cursor / Pi）通过 stdio 连接 `integrations/mcp/src/index.mjs`（配置模板见 `integrations/mcp/README.md`），执行查待排池 → 建需求任务 → 一键试排附 PNG 预览图 → 双方案对比 → 生成持久化草案。
- 用户点击 MCP 返回的 `workbenchUrl`（`http://127.0.0.1:<PORT>/app/#/workbench?taskId=...&resultId=...` 或 `&draftId=...`），在搭切工作台核对蓝图与顶部预检横幅后，手动点击右侧「选定此方案」进入既有落库流程。

## Driving it with `verify-ctl.mjs`

Preconditions: 已通过 `verify-ctl.mjs launch` 启动非 `8080` 免登隔离实例且 `doctor` 返回 `HEALTHY`（同一次 shell 会话内串行执行）。

- **驱动 MCP 25 工具真机闭环（22 项，零浏览器依赖）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script mcp-live-smoke`
  - 可观测结果：退出码 `0`；输出 JSON 为 `executed: 22, passed: 22, failed: 0, skipped: 0`，涵盖 25 工具发现、`list_draft_schemes`、`plan_multi_material_drafts`（批量草案 + PNG 预览）、`discard_draft_scheme` 正向作废与 `409` 冲突透传，且 `inventoryUnchanged: true`。
- **驱动深链预览、联动落库、版本漂移与服装自动分床（6 项 Playwright 断言）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script deeplink-and-cutplan`
  - 可观测结果：退出码 `0`；输出 JSON 为 `executed: 6, passed: 6, failed: 0, skipped: 0`（覆盖 `GARM-06..07` 与 `DEEP-01..04`），零未捕获页面异常、零原生弹窗。
- **驱动工作台待确认草案收件箱与多料联排批量草案闭环（21 项 Playwright 断言）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script drafts-inbox-and-relay`
  - 可观测结果：退出码 `0`；结果 JSON 输出 `executed: 21, passed: 21, failed: 0, skipped: 0`，覆盖收件箱 40 条分页与加载更多、状态过滤、`CONFIRMED`/`DISCARDED`/`EXPIRED`、`<dialog>` 原因必填与 `409` 冲突、多料头+多母卷接力 `batchGroupId` 批量草案与 `Idempotency-Key` 幂等/冲突，且未确认前物理库存零变动。
- **驱动 `#/slitting` 1D 分条排产与 `#/inspection` 质检库存闭环（20 项 Playwright 断言）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script inspection-and-slitting`
  - 可观测结果：退出码 `0`；结果 JSON 输出 `executed: 20, passed: 20, failed: 0, skipped: 0`（其中 F07 10 项覆盖 `#/slitting` 路由、1D 规格录入、`VIRTUAL_ROLL`/`STOCK_ROLL` 求解、物理刀距/切边/禁区/超产拦截、选定落库及 `#/results/<schemeId>` PLC 配方 CSV 导出）。
- **离线 MCP 契约与 PNG 单测**：
  - 命令：`npm test --prefix integrations/mcp`（25/25 全绿）。

## Gotchas

- `verify-ctl.mjs launch` 已显式隔离 `--cutdemo.workbench.drafts.path` 至临时目录，并在 `doctor` / `cleanup` 同步校验正式 `data/cutdemo-state.json.drafts` 零污染。
- 企业认证模式（`--auth`）下，`/api/v2/workbench/**` 的全部写端点（含 `POST /drafts/{draftId}/confirm`、`/discard`、`/multi-material-drafts`）仅允许 `ADMIN`/`PLANNER`（`OPERATOR`/`WAREHOUSE`/`INSPECTOR` 返回 `403`），4 个 `GET` 只读端点（含 `GET /drafts`）放行全部 5 角色。
- `mcp-live-smoke` 会创建一个隔离测试需求任务（仅写待排池，不扣实物母卷/料头），建议在 `ui-preview` 之后或独立隔离实例上运行。
