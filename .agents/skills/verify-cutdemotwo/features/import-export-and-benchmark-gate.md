---
routes:
  - demands
  - clusters
  - results
  - reconciliation
  - cost-analytics
  - inventory
  - inspection
  - slitting
---

# 生产级多格式导入导出、Benchmark 求解质量门禁与 `/api/v2/*` 契约收敛

覆盖路线 C（M4）核心交付能力的真机端到端黑盒验收：前端多编码（UTF-8 BOM / GB18030）/ 多分隔符（`,` / `;` / `\t`）/ 多 Sheet BOM 展开与通用 DXF（`$INSUNITS` + `LWPOLYLINE` + `holes`）向导导入 → 服务端原子批量母卷 / 料头 / 0.1 mm 瑕疵导入（`Idempotency-Key` 幂等与全回滚）→ 服务端生产级多格式导出（DXF R12 / LWPOLYLINE / AAMA、HPGL `.plt`、CNC G-Code `.nc`、1D 分切配方 JSON / CSV / XLSX、纯 Java 随工单 `ticket.pdf`、5-Sheet 生产汇总报表与流式防 Zip Slip 批量 ZIP）→ `benchmark/` 真机求解质量红线门禁与全仓 `/api/v2/*` & OpenAPI 3.1.0 契约收敛。

## Sub-features

- `IMP-01`（需求 / BOM / 1D 表格导入向导）：`#/demands` 点击 `demand-import-wizard-btn` 打开 `demand-import-modal`，支持 GB18030 / UTF-8 BOM / 分号 CSV、多 Sheet 评分推荐（`demand-import-sheet-select`）、单位换算、BOM 多层展开（`demand-import-bom-root-qty`）、`CIRCULAR_BOM` / 负尺寸行级报错表（`demand-import-issues-table`）及错误明细 CSV 下载（`demand-import-download-errors-btn`）。
- `IMP-02`（通用 CAD DXF 几何导入）：`#/demands`（`demand-dxf-wizard-btn`）与 `#/clusters`（`cluster-open-dxf-import-btn`）共用 `dxf-import-modal`，支持 `$INSUNITS` 识别与单位覆写、弧段弦高与端点拼接容差、经纬纹旋转模式（`HALF_TURN_180` / `ROTATE_90`）、内孔 `holes` 自动归属与 SVG 预览（`dxf-pieces-preview`），并阻断未闭合孤立轮廓。
- `IMP-03`（原子批量母卷 / 料头 / 瑕疵导入）：`#/inventory`（`inv-open-batch-import-btn` → `inv-receive-tab-batch-rolls` / `inv-receive-tab-batch-remnants`）与 `#/inspection`（`insp-open-batch-defects-btn` → `insp-batch-defects-modal`）提供模板下载、只读预检（`POST /api/v2/inventory/import/{rolls,remnants,defects}/preview`）与单事务原子提交（`POST /api/v2/inventory/import/{rolls,remnants,defects}`）。强制校验 `Idempotency-Key`（409 冲突拦截）、`ROLL_LENGTH_MISMATCH`（0.001 mm）、瑕疵 `0.1 mm` 精度（`PRECISION_VIOLATION`）、`captureId` 去重跳过、已报废/锁定母卷保护（`ROLL_SCRAPPED` / `ROLL_RESERVED`）、500 行上限、`2MB` 载荷 `413` 拦截及 RBAC（`WAREHOUSE`/`INSPECTOR`/`ADMIN`）隔离。
- `EXP-01`（服务端 CAM / 分切 / PDF / XLSX / ZIP 导出）：`#/results`、`#/reconciliation`、`#/cost-analytics` 接入 5 个服务端导出端点：
  - `GET /api/v2/exports/schemes/{schemeId}/cam`（`dxf_r12`、`dxf_lwpolyline`、`dxf_aama`、`plt`、`nc`）；
  - `GET /api/v2/exports/schemes/{schemeId}/slitting`（`json` / `csv` / 2-Sheet `xlsx`）；
  - `GET /api/v2/exports/schemes/{schemeId}/ticket.pdf`（A4 矢量 PDF 1.4，内嵌 `/STSong-Light` 与 `FlateDecode`）；
  - `GET /api/v2/exports/production-summary`（`pdf` / 5-Sheet `xlsx`）；
  - `POST /api/v2/exports/batch-zip`（1..50 方案流式打包，`manifest.json` 跨维 `SKIPPED`，防 Zip Slip，AI Agent 严格 `403`）。
  - 全量 CSV/XLSX 导出均通过 `CsvSanitizer` 中和 `=`, `+`, `-`, `@` 等公式注入载荷且保留正常连字符（如 `PAT-1`）。
- `GATE-01`（Benchmark 真机门禁与 `/api/v2/*` 全契约收敛）：`node benchmark/gate.mjs --set v2-gate --auth` 在非 `8080` 隔离端口验证 8 题求解质量红线（含 `contour-holes-16`、`slitting-basic`、`multi-material-relay`）与正式库存 SHA-256 零变动；全仓暴露路由与 `openapi.json`（3.1.0，104 路径 / 116 操作）100% 一致，已下线旧 `/api/*` 与 `/api/v1/*` 端点返回 `404`，`workflow-closure-audit.mjs --fail` 与 `arch-coupling-audit.mjs --fail-on-cycle` 均为 `0` 违规。

## How to get to it (user POV)

- 表格 / BOM / DXF 导入：进入 `#/demands` 点击 `表格 / BOM 导入向导` 或 `DXF 几何向导`；进入 `#/clusters` 点击 `导入 CAD DXF 模板`。
- 批量库存 / 瑕疵导入：进入 `#/inventory` 点击 `批量导入母卷/料头`；进入 `#/inspection` 点击 `批量导入瑕疵`。
- 服务端生产导出：进入 `#/results` 使用 `CAM / 工艺导出设置`、`服务端分切导出`、`下载随工单 PDF`、`批量导出 ZIP` 与 `生产汇总报表 (PDF / XLSX)`；进入 `#/reconciliation` 或 `#/cost-analytics` 点击右上角 `生产汇总 PDF` / `多维汇总 Excel`。

## Driving it with HTTP / `verify-ctl.mjs`

Preconditions: 使用非 `8080` 隔离实例（支持免登或 `--auth` 模式）：
`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18095 --auth --jvm-opts "-Xms64m -Xmx256m"`
并用管理员凭据完成前置体检：
`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs doctor --session "<sessionFile>" --auth-user admin --auth-pass admin123`

- **一键驱动全链路 F13 + F14 + Tier 3 黑盒验收（`import-export-and-benchmark`，27 项全真实校验，零跳过）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script import-export-and-benchmark`
  - 可观测结果：退出码 `0`；输出 `.result.json` 为 `executed: 27, passed: 27, failed: 0, skipped: 0`（`prodInventoryUntouched: true`、`prodDraftsUntouched: true`）。
- **独立驱动 Benchmark 真机求解质量门禁（非 `8080` 自启隔离实例）**：
  - 命令：`node benchmark/gate.mjs --set v2-gate --auth --port 18391`
  - 可观测结果：退出码 `0`（`8/8` 题目全部达标；质量红线违约返回 `1`；参数/不可达/无 `--auth` 令牌返回 `2`）。

## Gotchas

- `InventoryImportController` 正式提交 URL 为 `/api/v2/inventory/import/{rolls,remnants,defects}`（无 `/commit` 后缀），仅 UI 按钮 `data-testid` 使用 `inv-import-commit-btn` / `insp-import-commit-btn`。
- `POST /api/v2/exports/batch-zip` 仅限 5 类人类工厂角色执行，所有 AI Agent Token（即使携带 `INVENTORY_READ`）均返回 `403 FORBIDDEN` 并记录 `ACCESS_DENIED` 审计；其余 `GET /api/v2/exports/*` 端点对携带 `INVENTORY_READ` 的 Agent 放行。
- 验证已下线旧 `/api/*` 端点返回 `404` 时，在 `--auth` 模式下必须携带有效 Bearer Token 穿透 `AuthSecurityFilter` 后才会到达 Spring MVC 返回 `404`（无令牌会被网关提前拦截为 `401`）。
