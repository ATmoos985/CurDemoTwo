---
routes:
  - workbench
---

# 工作台编排求解、22 工具工业 MCP 与深链预览闭环

验证阶段一（`542fa5c..c6c5a94`）新增的外部 Harness 协同闭环：后端 `/api/v2/workbench/**` 5 端点无环编排求解、同口径双方案比较与持久化待确认草案（File `.drafts/` 与 MySQL V11）→ `integrations/mcp` 22 工具四开关权限隔离、零依赖 PNG 蓝图预览与显式故障回报 → 浏览器打开 `#/workbench?taskId=...&resultId=...` / `&draftId=...` 深链直接在四层 Konva 画布核对方案与版本漂移告警（预览零写库，最终由人工点击「选定此方案」确认落库）。

## Sub-features

- `WB-01`：`POST /api/v2/workbench/tasks/{taskId}/plan-jobs` 按任务待排余量自动装配 2D（矩形直刀外扩/异形带孔）或 1D 求解作业，严格 `422 MATERIAL_NOT_READY` 拦截未放行 `PENDING` 卷、报废卷或不可用料头。
- `WB-02`：`GET /api/v2/workbench/tasks/{taskId}/result-comparison` 返回逐规格应排/已排/缺件与同口径物理占长对比，条件不同或未双齐套时抑制节省量。
- `WB-03`：`POST/GET /api/v2/workbench/drafts` 持久化待人工确认草案（`status="PENDING_CONFIRMATION"`、`requiresHumanConfirmation=true`、`inventoryMutated=false`），支持 TTL `EXPIRED` 与库存/任务 revision 漂移 `stale=true` 动态探测，且不写入或扣减实物库存。
- `MCP-01`：`integrations/mcp` 22 工具严格按 4 个宿主环境变量开关（`COMPUTE`/`BUSINESS_READ`/`ALLOW_DRAFT_SCHEME`/`ALLOW_DEMAND_WRITE`）隔离，无静默吞错（显式返回 `partialErrors`/`degraded`），并暴露 2 份 Resource（含 `cutting://guides/operations`）与 3 个标准 Prompts。
- `MCP-02`：零依赖纯 JS PNG 渲染器（`preview-png.mjs`）随 `plan_task_on_material` 与 `render_cutting_preview` 返回合法 `image/png` 排料缩略图与工作台直达深链 `workbenchUrl`。
- `DEEP-01`：打开 `#/workbench?taskId=...&resultId=...` 渲染 `[data-testid="external-plan-banner"]`（「外部试排方案预览（尚未锁库）」）与四层 Konva 蓝图，零写库请求。
- `DEEP-02`：打开 `#/workbench?taskId=...&draftId=...` 展示持久化草案号、有效期与风险预检列表。
- `DEEP-03`：关联任务或库存版本变更后重新打开草案深链，触发 `[data-testid="external-plan-stale-alert"]` 醒目版本漂移告警条。

## How to get to it (user POV)

- 外部本机 Harness（Codex / Claude Desktop / Cursor / Pi）通过 stdio 连接 `integrations/mcp/src/index.mjs`（配置模板见 `integrations/mcp/README.md`），执行查待排池 → 建需求任务 → 一键试排附 PNG 预览图 → 双方案对比 → 生成持久化草案。
- 用户点击 MCP 返回的 `workbenchUrl`（`http://127.0.0.1:<PORT>/app/#/workbench?taskId=...&resultId=...` 或 `&draftId=...`），在搭切工作台核对蓝图与顶部预检横幅后，手动点击右侧「选定此方案」进入既有落库流程。

## Driving it with `verify-ctl.mjs`

Preconditions: 已通过 `verify-ctl.mjs launch` 启动非 `8080` 免登隔离实例且 `doctor` 返回 `HEALTHY`（同一次 shell 会话内串行执行）。

- **驱动 MCP 22 工具真机闭环（17 项，零浏览器依赖）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script mcp-live-smoke`
  - 可观测结果：退出码 `0`；输出 JSON 为 `executed: 17, passed: 17, failed: 0, skipped: 0`，`plan1PngBytes > 0`、`previewPngBytes > 0` 且 `inventoryUnchanged: true`。
- **驱动深链预览、风险横幅、版本漂移与服装自动分床（4 项 Playwright 断言）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script deeplink-and-cutplan`
  - 可观测结果：退出码 `0`；输出 JSON 为 `executed: 4, passed: 4, failed: 0, skipped: 0`，零未捕获页面异常、零原生弹窗。
- **离线 MCP 契约与 PNG 单测**：
  - 命令：`npm test --prefix integrations/mcp`（21/21 全绿）。

## Gotchas

- `verify-ctl.mjs launch` 已显式隔离 `--cutdemo.workbench.drafts.path` 至临时目录，并在 `doctor` / `cleanup` 同步校验正式 `data/cutdemo-state.json.drafts` 零污染。
- 企业认证模式（`--auth`）下，`/api/v2/workbench/**` 的 2 个 `POST` 写端点仅允许 `ADMIN`/`PLANNER`（`OPERATOR`/`WAREHOUSE`/`INSPECTOR` 返回 `403`），3 个 `GET` 只读端点放行全部 5 角色。
- `mcp-live-smoke` 会创建一个隔离测试需求任务（仅写待排池，不扣实物母卷/料头），建议在 `ui-preview` 之后或独立隔离实例上运行。
