# 2026-11-27 路线 C：工业导入导出、Benchmark 门禁与工程债务全量收敛交付日志

> 目标：完成路线 C（M4-1 ~ M4-5）全部五大工程与业务支柱：存量 `/api/*` 全量收敛与 OpenAPI 3.1 100% 覆盖、服务端生产级多格式导出与原子批量库存导入、前端多格式订单/BOM/DXF 解析引擎与导入导出向导 UI、全仓 30 个超千行生产源码文件清零与 `workflow-closure-audit` 基线归 `0` 锁定、以及 `benchmark/` 真机求解质量门禁。

---

## 一、核心改造清单（M4-1 ~ M4-5）

### 1. M4-1：全仓存量 `/api/*` 向 `/api/v2/*` 与 OpenAPI 3.1 收敛
- **端点收敛处置**：全仓 4 个 Controller 原 36 条非 `/api/v2/*` 端点完成治理：
  - **下线移除 12 个全仓零调用死接口**（保留 11 个内部 Service 方法以备复用）：`GET /api/cutting/tasks`、`GET /api/cutting/task-summaries`、`POST /api/cutting/material-candidates`、`GET /api/cutting/plans/{id}`、`GET /api/cutting/tasks/{id}/plan-checks`、`POST /api/cutting/plans/{id}/{cancel,restore,adjust}`、`POST /api/cutting/report-batch`、`POST /api/rolls/{rollId}/defects`、`POST /api/remnants/{scan,match}`；
  - **迁入 `/api/v2/*` 并写入 OpenAPI 23 个业务端点**；
  - **保留基础设施健康探针 `GET /api/health` 并新增 `GET /api/v2/health`**（双写入 `openapi.json`）。
- **鉴权与跨端迁移**：
  - 清理 `AuthSecurityFilter` 与 `OperationAuditFilter` 死规则；修复 `AuthSecurityFilter.java` `L324` 等 23 处 `.startsWith("/api/v2/.../")` 遗漏精确根路径导致 Agent `GET /api/v2/inventory-ledger` 等被误判 403 的缺陷，补齐 `inventory-transfers/options` 与 `inventory-counts/options` 的 `SCOPE_INVENTORY_READ` 放行并新增 `AuthSecurityFilterTests.agentRootPathsScopeIsolationAndForbiddenWriteEndpoints`；
  - 全量迁移 `frontend/src`、`integrations/{mcp,inventory}`、`benchmark/run.mjs` 与 13 个 Java 测试类；将 `workflow-closure-audit.mjs` 的 `LEGACY_NON_V2_ENDPOINTS_BASELINE` 锁定为 `Object.freeze([])`。

#### 完整 36 条「旧 `/api/*` → 新 `/api/v2/*`」映射表（供 E2E-M4 同步）
| # | Controller | 原端点 | M4-1 最终处置 | 目标 `/api/v2/*` 路径 | 权限 / 审计变化 |
|---:|---|---|---|---|---|
| 1 | `FabricCutController` | `GET /api/cutting/tasks` | **下线移除**（Service `listTasks()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 2 | `FabricCutController` | `GET /api/cutting/task-summaries` | **下线移除**（Service `taskSummaries()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 3 | `FabricCutController` | `GET /api/cutting/tasks/{id}` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/cutting/tasks/{id}` | Agent `SCOPE_DEMAND_READ` |
| 4 | `FabricCutController` | `POST /api/cutting/tasks` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/cutting/tasks` | `ROLE_PLANNER`；审计 `TASK_SAVE` |
| 5 | `FabricCutController` | `POST /api/cutting/material-candidates` | **下线移除**（Service `materialCandidates()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 6 | `FabricCutController` | `GET /api/cutting/plans/{id}` | **下线移除**（Service `getPlan()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 7 | `FabricCutController` | `GET /api/cutting/tasks/{id}/plans` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/cutting/tasks/{id}/plans` | Agent `SCOPE_DEMAND_READ` |
| 8 | `FabricCutController` | `GET /api/cutting/tasks/{id}/plan-checks` | **下线移除**（Service `planChecks()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 9 | `FabricCutController` | `POST /api/cutting/plans/{id}/cancel` | **下线移除**（Service `changePlanStatus()` 保留） | - | 清理 `AuthSecurityFilter`、`OperationAuditFilter` |
| 10 | `FabricCutController` | `POST /api/cutting/plans/{id}/restore` | **下线移除**（Service `changePlanStatus()` 保留） | - | 清理 `AuthSecurityFilter`、`OperationAuditFilter` |
| 11 | `FabricCutController` | `POST /api/cutting/plans/{id}/adjust` | **下线移除**（Service `adjust()` 保留） | - | 清理 `AuthSecurityFilter`、`OperationAuditFilter` |
| 12 | `FabricCutController` | `POST /api/cutting/report-confirm` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/cutting/report-confirm` | `OPERATOR`/`PLANNER`；审计 `CUT_REPORT_CONFIRM` |
| 13 | `FabricCutController` | `GET /api/cutting/reports/{id}/quality-dispositions` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/cutting/reports/{id}/quality-dispositions` | Agent `SCOPE_INVENTORY_READ` |
| 14 | `FabricCutController` | `POST /api/cutting/reports/{id}/quality-dispositions` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/cutting/reports/{id}/quality-dispositions` | `ROLE_INSPECTOR`；审计 `QUALITY_DISPOSITION_CREATE` |
| 15 | `FabricCutController` | `POST /api/cutting/reports/{reportId}/dispositions/{dispositionId}/revoke` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/cutting/reports/{reportId}/dispositions/{dispositionId}/revoke` | `ROLE_INSPECTOR`；审计 `QUALITY_DISPOSITION_REVOKE` |
| 16 | `FabricCutController` | `POST /api/cutting/reports/{id}/reverse` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/cutting/reports/{id}/reverse` | `ROLE_PLANNER`；审计 `CUT_REPORT_REVERSE` |
| 17 | `FabricCutController` | `POST /api/cutting/report-batch` | **下线移除**（Service `reportBatch()` 保留） | - | 清理 `AuthSecurityFilter`、`OperationAuditFilter` |
| 18 | `FabricCutController` | `POST /api/demo/inventory` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/demo/inventory` | 仅 `ROLE_ADMIN`；审计 `SYSTEM_DEMO_INIT` |
| 19 | `FabricCutController` | `GET /api/rolls` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/rolls` | Agent `SCOPE_INVENTORY_READ` |
| 20 | `FabricCutController` | `GET /api/rolls/{rollId}` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/rolls/{rollId}` | Agent `SCOPE_INVENTORY_READ` |
| 21 | `FabricCutController` | `POST /api/rolls` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/rolls` | 仅 `ROLE_WAREHOUSE`（精确 `equals`）；审计 `ROLL_SAVE` |
| 22 | `FabricCutController` | `POST /api/rolls/{rollId}/defects` | **下线移除**（Service `addDefectToRoll()` 保留） | - | 清理 `AuthSecurityFilter`、`OperationAuditFilter` |
| 23 | `FabricCutController` | `POST /api/rolls/{rollId}/inspection-defects` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/rolls/{rollId}/inspection-defects` | `ROLE_INSPECTOR`；审计 `ROLL_DEFECT_ADD` |
| 24 | `FabricCutController` | `POST /api/rolls/{rollId}/defects/{defectId}/void` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/rolls/{rollId}/defects/{defectId}/void` | `ROLE_INSPECTOR`；审计 `ROLL_DEFECT_VOID` |
| 25 | `FabricCutController` | `POST /api/inspection/rolls` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/inspection/rolls` | `ROLE_INSPECTOR`；审计 `INSPECTION_ROLL_CREATE` |
| 26 | `FabricCutController` | `POST /api/rolls/{rollId}/reset` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/rolls/{rollId}/reset` | 仅 `ROLE_ADMIN`；审计 `ROLL_RESET` |
| 27 | `FabricCutController` | `POST /api/remnants/{id}/scrap` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/remnants/{id}/scrap` | `ROLE_WAREHOUSE`；审计 `REMNANT_SCRAP` |
| 28 | `FabricCutController` | `GET /api/remnants` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/remnants` | Agent `SCOPE_INVENTORY_READ` |
| 29 | `FabricCutController` | `POST /api/remnants/scan` | **下线移除**（Service `scanOrGetById()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 30 | `FabricCutController` | `POST /api/remnants/match` | **下线移除**（Service `matchRemnants()` 保留） | - | 清理 `AuthSecurityFilter` 死规则 |
| 31 | `FabricCutController` | `POST /api/remnants/register` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/remnants/register` | `ROLE_WAREHOUSE`；审计 `REMNANT_REGISTER` |
| 32 | `FabricCutController` | `GET /api/health` | **保留兼容 + 新增 v2（双入 OpenAPI）** | `GET /api/health`、`GET /api/v2/health` | 白名单 + 写限流豁免 |
| 33 | `NestingController` | `GET /api/v1/nesting/engines` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/nesting/engines` | Agent `SCOPE_PLAN_COMPUTE` |
| 34 | `NestingController` | `POST /api/v1/nesting/solve` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/nesting/solve` | `ROLE_PLANNER` / Agent `SCOPE_PLAN_COMPUTE` |
| 35 | `RemnantRecommendationController` | `POST /api/cutting/remnant-recommendations` | **迁入 v2 + 入 OpenAPI** | `POST /api/v2/cutting/remnant-recommendations` | `ROLE_PLANNER` / Agent `SCOPE_PLAN_COMPUTE` |
| 36 | `StudioWorkflowController` | `GET /api/rolls/{rollId}/spatial-map` | **迁入 v2 + 入 OpenAPI** | `GET /api/v2/rolls/{rollId}/spatial-map` | Agent `SCOPE_INVENTORY_READ` |

---

### 2. M4-2：后端生产级导出引擎与原子批量库存导入
- **依赖与零外依 PDF 引擎**：`pom.xml` 引入 `org.apache.poi:poi-ooxml:5.2.5`（`SXSSFWorkbook(100)` + `dispose()` 适配 `-Xmx256m`）；纯 Java PDF 1.4 引擎（`PurePdfWriter` / `PdfTicketRenderer`，使用 JDK `Deflater` + `STSong-Light`/`UniGB-UTF16-H` + 精确 `xref` 偏移表，零外部 PDF 依赖）；JDK 原生 `ZipOutputStream` 防 Zip Slip 批量打包（单次上限 50 方案 + `manifest.json`）。
- **数据库迁移与热冷规范**：新增 `src/main/resources/db/migration/V15__inventory_batch_imports.sql`（`inventory_batch_import` 表与 `idx_batch_import_type_rev` 索引，`JdbcInventoryStore` 对历史批量导入保持按需查询、零全表冷扫）。
- **新增 11 个 `/api/v2/*` 端点**（使 OpenAPI `3.1.0` 达到 **104 路径 / 116 操作 / 169 Schema**）：
  - **导出（`/api/v2/exports/*`，`ExportController`，5 端点）**：
    - `GET /api/v2/exports/schemes/{schemeId}/cam?format=dxf_r12|dxf_lwpolyline|dxf_aama|plt|nc&overcutMm=&leadInMm=&microJointWidthMm=&deduplicateCommonEdges=&cutTool=&punchTool=&creaseTool=`（7 层 R12 DXF、闭合 `LWPOLYLINE`、AAMA/ASTM 块结构、HPGL `40 units/mm` 振刀机、先孔后外 G-Code 含 `1e-5 mm` 环归属精度安全引线/微连接/共边去重/圆弧拟合）
    - `GET /api/v2/exports/schemes/{schemeId}/slitting?format=json|csv|xlsx`
    - `GET /api/v2/exports/schemes/{schemeId}/ticket.pdf`
    - `GET /api/v2/exports/production-summary?format=pdf|xlsx&taskId=&state=&from=&to=`（5-Sheet 多维 Excel 汇总）
    - `POST /api/v2/exports/batch-zip`（禁止全部 Agent 调用，返回 403）
  - **批量导入（`/api/v2/inventory/import/*`，`InventoryImportController`，6 端点）**：
    - `POST /api/v2/inventory/import/{rolls,remnants,defects}/preview` & `POST /api/v2/inventory/import/{rolls,remnants,defects}`（`WAREHOUSE`/`ADMIN` 导入母卷/料头，`INSPECTOR`/`ADMIN` 导入瑕疵；强制 `Idempotency-Key` 幂等重放与 409 冲突拦截；单事务原子回滚，`0.1 mm` 精度与 `ROLL_LENGTH_MISMATCH <= 0.001 mm` 守恒）。
- **安全与内存护栏**：`CsvSanitizer`（基于 Unicode `isISOControl` / `Character.FORMAT` 与 C0/C1 控制符防公式注入）；`OperationAuditFilter` 跳过 `/api/v2/exports/**` 响应体缓存防止大文件导出触发 `-Xmx256m` OOM。

---

### 3. M4-3A & M4-3B：前端生产级解析引擎与导入导出 UI 整合
- **订单 / BOM / 1D / CSV 解析引擎**（`frontend/src/lib/domain/`，以下文件行数均按 `scripts/arch-coupling-audit.mjs` `countLines` 口径统计）：
  - `demand-import-csv.js`（215 行）：UTF-8 BOM / UTF-16LE/BE / fatal UTF-8 / `gb18030` 解码，引号感知 `,`/`;`/`\t` 自动探测，RFC 4180 转义；
  - `demand-import-schema.js`（662 行）：多 Sheet 评分推荐、中英文/车间列名别名与 `_in_` 单位清洗、四层正交 1D/2D 决策树、BOM 多层展开、三色 DFS 环路拦截 `CIRCULAR_BOM` 与三态 `explicitAllowRotation` 继承、精确 `sheetName + rowIndex(1-based) + column + reason` 报错；
  - `demand-import-model.js`（532 行）：新增 `parseDemandCsv`、`inspectDemandWorkbook`、`parseDemandWorkbook`，100% 兼容既有 6 导出（`demand-import-engine.test.ts` 16/16）。
- **通用生产级 DXF 几何解析引擎**（`frontend/src/lib/nesting/`）：
  - `dxf-geometry.js`（689 行）与 `dxf-parser.js`（797 行）：支持 `$INSUNITS` 换算与 `unitOverride`、空行与非整数组码容错、`BLOCKS + INSERT`（缩放/旋转/负缩放镜像/阵列/深度 16 循环引用防护）、凸度 `bulge` / `CIRCLE` / `ARC` / 有理 `SPLINE` 采样、散落实体闭合拼接、奇偶嵌套 `holes` 内孔提取与斜边防穿刺校验、AAMA 屏蔽层 14、`rotationMode` 映射、128 顶点抽稀（`dxf-parser.test.ts` 11/11）。
- **前端导入导出客户端与向导 UI**（零新增路由，保持 18 现代路由、`useStudioStoreFanInCount=3`、`WorkbenchBoardCanvas` 零越界）：
  - 新增 `exportApiClient.ts`（363 行，Bearer 下载 + RFC 5987 防穿越）、`inventoryImportApi.ts`（668 行，`Idempotency-Key` 双写 + 0-based/1-based 行映射 + `0.1 mm` 预检）、`OperationFeedbackCard.tsx`（69 行）、`DxfImportWizardModal.tsx`（346 行）；
  - 在 `#/demand-create`、`#/clusters`、`#/inventory`、`#/inspection`、`#/results`、`#/reconciliation`、`#/cost-analytics` 全面接入原生 `<dialog>` 向导弹窗。

---

### 4. M4-3A + M4-3B + M4-4：全仓 30 个超千行生产源码文件全量拆解归零
通过 M3（提前降至千行以下的 2 个后端文件）+ M4-3A（前端 5 个核心/组件）+ M4-3B（前端 9 个业务页面）+ M4-4（后端主工程 8 个 + `changyang` 6 个），原 30 个超千行生产源码文件全部拆解至 `< 1000` 行（M4 拆解文件按 `arch-coupling-audit` `countLines` 口径均 `<= 849` 行，且均 `<= 850` 行），`changyang` 下沉 `OrToolsNativeLoader` 消除跨包隐环，保持全仓 `totalCycles = 0`、`ModuleBoundaryTests` 18/18。

> **行数统计口径说明**：下表「拆后行数（按 `arch-coupling-audit` `countLines` 口径）」统一采用 `scripts/arch-coupling-audit.mjs` 的 `countLines(source)` 实现（`\r\n` 归一化为 `\n` 后剔除末尾单个换行符，与主流编辑器及 `wc -l` 语义一致）；同时在末列列出含末尾空行的 `split(/\r?\n/).length` 物理切分行总数（均多 `1` 行），30/30 文件均已逐一实测对齐。

| # | 文件路径（原 >1000 行） | 所属端 / 里程碑 | 拆解前行数 | 拆后行数（按 `arch-coupling-audit` `countLines` 口径） | 含尾空行总行数（`split(/\r?\n/)`） |
|---:|---|---|---:|---:|---:|
| 1 | `frontend/src/components/WorkbenchBoardCanvas.tsx` | 前端 / M4-3A | 2,963 | **407** | 408 |
| 2 | `frontend/src/pages/InventoryPage.tsx` | 前端 / M4-3B | 2,776 | **849** | 850 |
| 3 | `frontend/src/pages/ShowcasePage.tsx` | 前端 / M4-3B | 2,318 | **407** | 408 |
| 4 | `frontend/src/pages/DocumentsPage.tsx` | 前端 / M4-3B | 2,247 | **528** | 529 |
| 5 | `frontend/src/pages/CuttingWorkbenchPage.tsx` | 前端 / M4-3B | 2,226 | **824** | 825 |
| 6 | `frontend/src/pages/ResultsCenterPage.tsx` | 前端 / M4-3B | 2,138 | **846** | 847 |
| 7 | `frontend/src/lib/nesting/scenarios.js` | 前端 / M4-3A | 2,089 | **25** | 26 |
| 8 | `frontend/src/components/SettingsModal.tsx` | 前端 / M4-3A | 2,079 | **480** | 481 |
| 9 | `frontend/src/pages/InspectionPage.tsx` | 前端 / M4-3B | 1,714 | **845** | 846 |
| 10 | `frontend/src/pages/DemandCreatePage.tsx` | 前端 / M4-3B | 1,660 | **690** | 691 |
| 11 | `frontend/src/pages/workbench/useWorkbenchSolver.ts` | 前端 / M4-3A | 1,482 | **85** | 86 |
| 12 | `frontend/src/pages/ReconciliationPage.tsx` | 前端 / M4-3B | 1,281 | **551** | 552 |
| 13 | `frontend/src/pages/workbench/workbenchDeeplinkUtils.ts` | 前端 / M4-3A | 1,256 | **164** | 165 |
| 14 | `frontend/src/pages/GarmentWidthPage.tsx` | 前端 / M4-3B | 1,201 | **592** | 593 |
| 15 | `src/main/java/com/example/cutdemotwo/business/cutting/CuttingExecutionAndReportService.java` | 后端 / M3 | >1,000 | **961** | 962 |
| 16 | `src/main/java/com/example/cutdemotwo/business/cutting/ProductionCostAndProcurementService.java` | 后端 / M3 | >1,000 | **693** | 694 |
| 17 | `src/main/java/com/example/cutdemotwo/algorithm/nesting/DeepnestSolverEngine.java` | 后端 / M4-4 | 2,148 | **394** | 395 |
| 18 | `src/main/java/changyang/cut/apsmodule/generator/NewSolver/output/InstructionConverter.java` | 后端 / M4-4 | 2,055 | **656** | 657 |
| 19 | `src/main/java/changyang/cut/apsmodule/generator/NewSolver/output/LocalNeighborhoodSequenceOptimizer.java` | 后端 / M4-4 | 1,955 | **523** | 524 |
| 20 | `src/main/java/com/example/cutdemotwo/business/cutting/SchedulingStudioService.java` | 后端 / M4-4 | 1,640 | **340** | 341 |
| 21 | `src/main/java/com/example/cutdemotwo/algorithm/nesting/GuillotineSearchKernel.java` | 后端 / M4-4 | 1,555 | **145** | 146 |
| 22 | `src/main/java/com/example/cutdemotwo/business/cutting/GlobalPlanningService.java` | 后端 / M4-4 | 1,544 | **522** | 523 |
| 23 | `src/main/java/com/example/cutdemotwo/algorithm/nesting/DeepnestNfpGeometry.java` | 后端 / M4-4 | 1,442 | **695** | 696 |
| 24 | `src/main/java/changyang/cut/apsmodule/generator/NewSolver/mip/UnifiedSetPartitionSolver.java` | 后端 / M4-4 | 1,284 | **447** | 448 |
| 25 | `src/main/java/changyang/cut/apsmodule/generator/NewSolver/output/SetPartitionRefiner.java` | 后端 / M4-4 | 1,251 | **552** | 553 |
| 26 | `src/main/java/com/example/cutdemotwo/business/optimization/OptimizationService.java` | 后端 / M4-4 | 1,250 | **674** | 675 |
| 27 | `src/main/java/com/example/cutdemotwo/business/cutting/StudioMaterializer.java` | 后端 / M4-4 | 1,244 | **531** | 532 |
| 28 | `src/main/java/changyang/cut/apsmodule/generator/NewSolver/CuttingSolver.java` | 后端 / M4-4 | 1,233 | **318** | 319 |
| 29 | `src/main/java/com/example/cutdemotwo/algorithm/toolpath/ToolpathOptimizerService.java` | 后端 / M4-4 | 1,183 | **454** | 455 |
| 30 | `src/main/java/changyang/cut/apsmodule/generator/NewSolver/mip/LegacyOrderPatternSelectionSolver.java` | 后端 / M4-4 | 1,115 | **461** | 462 |

---

### 5. M4-5：`benchmark/` 真机求解质量门禁与 `workflow-closure-audit` 归零锁定
- **`benchmark/` 升级**：
  - `benchmark/run.mjs`：重构导出 `executeBenchmark(options)` 与 `parseRunArgs`、`buildAuthHeaders`；支持 `--auth` / `--username` / `--password` / `--token` / `CUTDEMO_BENCH_TOKEN` / `--allow-fallback`，开启 `--auth` 时自动调用 `POST /api/v2/auth/login` 并于全部请求附加 Bearer 鉴权（严禁在日志或 JSON 中明文落盘密码或 Token）；全面对接 `/api/v2/auth/me`、`/api/v2/health`、`/api/v2/capabilities`、`/api/v2/nesting/engines`、`/api/v2/nesting/solve`、`/api/v2/optimization-jobs`（带幂等键轮询）+ `/api/v2/optimization-results/{id}`、`/api/v2/planning/multi-material`。
  - `benchmark/problems.mjs`：新增 `polygonWithHoles` 与扣孔 `netShapeArea`；新增 `contour-holes-16`、`nesting-2d-job`、`slitting-basic`（`ortools-1d`）、`multi-material-relay` 4 题与全平台自主引擎门禁题集 `SETS['v2-gate']`（8 题）。
  - `benchmark/lib.mjs` & `benchmark/report.mjs`：扩展 `measure` 支持 2D（含内孔净面积一致性核验）、`SLITTING_1D`、`NESTING_2D_JOB` 与 `multi-material`（件数守恒与料头/母卷加权利用率）；升级 `evaluateThresholds` 支持 `minRemnantPlaced`、`minRelayRolls`、`maxOverproduced` 与漏题校验，报告追加 1D 分切 / 多料联排扩展明细表。
  - `benchmark/gate.mjs`：新增零依赖一键隔离真机门禁（默认端口 `18391`，严禁 `8080`；在 `os.tmpdir()` 下创建独立隔离目录覆盖 `state`/`jobs`/`integrations`/`drafts`/`security`/`audit`，注入 `--cutdemo.seed-demo-data=true` 与 `--cutdemo.auth.enabled=true|false`；`finally` 按 PID 树精确清理进程与临时目录，并校验正式 `data/cutdemo-state.json` SHA-256 及状态目录指纹零变动）。
  - `benchmark/thresholds.json`：先打包最新 JAR 并经 `gate.mjs` 真机两轮实跑 `v2-gate`（严格零降级）与 `demo`（`--allow-fallback`）取得客观真值后，按科学裕量公式锁定全部 20 题红线（单床可齐套题 `minPlacedRatio = 1.0`，`multi-material-relay` 锁定 `minRemnantPlaced: 5`、`minRelayRolls: 2`，`slitting-basic` 锁定 `maxOverproduced: 6`，`scenario8` 按超单床物理截断实测设为 `15.0%` / `0.7`）。
  - `benchmark/benchmark.test.mjs` & `benchmark/README.md`：单测由 21 项扩展至 **25 项**（覆盖内孔面积、1D/多料/2D 异步作业度量、扩展红线、鉴权头、`gate.mjs` 8080 禁令与指纹比对）。
- **CI 与规范联动**：`.github/workflows/image.yml` 在 `image` job 补跑 `node --test benchmark/*.test.mjs`；`docs/AI开发规范.md` 第 5 节补充真机求解门禁与严禁压低红线反作弊条文。
- **`workflow-closure-audit` 归零锁定**：`scripts/workflow-closure-audit.mjs` 将 `LARGE_SOURCE_FILES_BASELINE` 锁定为 `Object.freeze([])` 并同步更新维度 B/C 提示与 Markdown 文案；`scripts/workflow-closure-audit.test.mjs` 同步断言归 `0` 并保留自定义基线单向递减兼容测试。

---

## 二、全仓门禁终验实测汇总

| # | 验证命令 | 发现 | 执行 | 成功 | 失败 | 跳过 | 关键指标 / 备注 |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | `.\mvnw.cmd test` | 627 | 612 | 612 | 0 | 15 | `ModuleBoundaryTests` 18/18；15 跳过均为既有缺原生 C++ / 按需基准条件（`03:53 min`） |
| 2 | `.\mvnw.cmd -Dgroups=mysql-integration test` | 145 | 145 | 145 | 0 | 0 | H2 `MODE=MySQL` + Flyway V1–V15 全覆盖（22 类，`01:25 min`） |
| 3 | `npm run typecheck --prefix frontend` | 1 | 1 | 1 | 0 | 0 | `tsc --noEmit` 0 错误 |
| 4 | `npm test --prefix frontend` | 179 | 179 | 179 | 0 | 0 | Vitest 35/35 测试文件全绿 |
| 5 | `npm run build --prefix frontend` | 1 | 1 | 1 | 0 | 0 | Vite `243 modules transformed`，刷新 `static/app/` |
| 6 | `node --test src/test/js/*.test.mjs` | 166 | 166 | 166 | 0 | 0 | 含前端全图 0 SCC 与 `static/` 顶层白名单 |
| 7 | `node --test scripts/*.test.mjs` | 15 | 15 | 15 | 0 | 0 | `arch-coupling-audit.test.mjs` (7) + `workflow-closure-audit.test.mjs` (8) |
| 8 | `node scripts/arch-coupling-audit.mjs --fail-on-cycle` | 1 | 1 | 1 | 0 | 0 | `totalCycles=0`、`largeFileCount=0`、`useStudioStoreFanInCount=3`、`canvasBoundaryPassed=true` |
| 9 | `node scripts/workflow-closure-audit.mjs --fail` | 1 | 1 | 1 | 0 | 0 | `violationCount=0`（`115 v2 + 1 探针 = 116 OpenAPI`、`0/0 非 v2`、`0/0 超千行`、`18 路由 / 7 特征地图 / 11 SKILL 路径`） |
| 10 | `npm test --prefix integrations/mcp` | 25 | 25 | 25 | 0 | 0 | MCP 25 工具、权限矩阵与 PNG 预览 |
| 11 | `node --test integrations/inventory/test/sync-worker.test.mjs` | 7 | 7 | 7 | 0 | 0 | Outbox Worker |
| 12 | `node --test benchmark/*.test.mjs` | 25 | 25 | 25 | 0 | 0 | 原 21 项 + M4-5 新增内孔/1D/多料/鉴权/`gate.mjs` 护栏单测 |
| 13 | `node benchmark/gate.mjs --set v2-gate --auth`（及 `--set v2-gate`） | 8 | 8 | 8 | 0 | 0 | 隔离端口 `18391`，8/8 组红线全部通过，正式 `data/cutdemo-state.json` SHA-256 零变动 |

### Benchmark 真机实测数据详情（`v2-gate` `--auth`，隔离端口 `18391`）
| 题目 | 引擎 | 排入/需求 | 利用率 % | 耗时 ms | 红线校验 |
|---|---|---:|---:|---:|---|
| `guillotine-java` | `javaguillotine` | 1/1 | 56.25% | 21 | PASS（>=50%, 排入 1.0） |
| `scenario1` | `crosscut` | 3/30 | 72.00% | 4 | PASS（>=68%, 排入 >=0.1） |
| `scenario4-java` | `javaguillotine` | 20/74 | 87.44% | 64 | PASS（>=75%, 排入 >=0.25） |
| `contour14` | `deepnest` | 14/14 | 82.24% | 885 | PASS（>=75%, 排入 1.0） |
| `contour-holes-16` | `deepnest` | 16/16 | 43.24% | 441 | PASS（>=40%, 排入 1.0, 内孔扣面积校验通过） |
| `nesting-2d-job` | `javaguillotine` | 1/1 | 56.25% | 1 | PASS（>=50%, 排入 1.0, 异步作业 PASSED） |
| `slitting-basic` | `ortools-1d` | 38/34 | 91.65%（可用幅宽 92.81%） | 1675 | PASS（>=88%, 超产 4<=6, 3 排刀方案） |
| `multi-material-relay` | `javaguillotine` | 29/29 | 78.51% | 89 | PASS（>=74%, 料头排入 7>=5, 命中 3 料头, 接力 2>=2 母卷, 节省 5.22 m²） |

*(注：另执行了 `--set demo --allow-fallback` 两轮隔离实测获取 `scenario2` 93.22% / `scenario3` 56.25%(5/5) / `scenario4` 87.44% / `scenario5` 90.00% / `scenario6` 92.93% / `scenario7` 87.06% / `scenario8` 17.82%(14/18 超长主帘物理截断) 基线，以及临时 99% 超标红线负向证伪测试验证 `gate.mjs` 精确拦截并返回退出码 `1`。)*

---

## 三、待 E2E-M4 同步清单与禁改区声明
- **禁改区确认**：路线 C（M4-1 ~ M4-5）全程零修改 `.agents/skills/verify-cutdemotwo/**` 与 `src/test/browser/*.cjs`（保留并行 E2E 轨道独立演进），未执行 `git commit` / `git push`。
- **需由 E2E-M4 同步的既有脚本与文档路径**（经对 `.agents/skills/verify-cutdemotwo/` 与 `src/test/browser/` 全量正则扫描 `/api/(?!v2/|health)` 及 `/api/v1/` 核实，确认全部残留非 v2 旧业务接口位置如下，均不包含 `/api/v1/`）：
  1. `src/test/browser/app-react-closure-and-perf.cjs`：
     - `L346`、`L567`（`POST /api/rolls` → `POST /api/v2/rolls`）
     - `L355`（`POST /api/rolls/{rollId}/inspection-defects` → `POST /api/v2/rolls/{rollId}/inspection-defects`）
     - `L377`、`L727`、`L761`（`GET /api/rolls/{rollId}` → `GET /api/v2/rolls/{rollId}`）
     - `L750`（`POST /api/cutting/reports/{planId}/quality-dispositions` → `POST /api/v2/cutting/reports/{planId}/quality-dispositions`）
  2. `src/test/browser/app-unified-workflow.cjs`：
     - `L309`（`GET /api/rolls/{rollId}` → `GET /api/v2/rolls/{rollId}`）
     - `L314`（`POST /api/rolls` → `POST /api/v2/rolls`）
     - `L350`（`GET /api/rolls/{rollId}/spatial-map` → `GET /api/v2/rolls/{rollId}/spatial-map`）
  3. `.agents/skills/verify-cutdemotwo/scripts/verify-auth-rbac-agent-audit.mjs`：
     - `L701`、`L715`、`L732`、`L1146`、`L1149`（断言文案）、`L1510`、`L1577`（`GET /api/rolls` 含分页/限流测试 → `GET /api/v2/rolls`）
     - `L1706`（`POST /api/rolls` → `POST /api/v2/rolls`）
     - `L1841`（`POST /api/remnants/register` → `POST /api/v2/remnants/register`）
  4. `.agents/skills/verify-cutdemotwo/scripts/verify-drafts-inbox-and-relay.mjs`：
     - `L162`、`L166`（断言文案）（`GET /api/rolls` → `GET /api/v2/rolls`）
     - `L163`、`L167`（断言文案）、`L1233`（`GET /api/remnants` → `GET /api/v2/remnants`）
     - `L179`（`POST /api/rolls` → `POST /api/v2/rolls`）
     - `L257`（`POST /api/remnants/register` → `POST /api/v2/remnants/register`）
     - *注：`L463`、`L681` 为 `req.url().includes('/api/')` 通用写拦截断言，天然覆盖 `/api/v2/*`，无需迁移。*
  5. `.agents/skills/verify-cutdemotwo/scripts/verify-inspection-and-slitting.mjs`：
     - `L469`（`/api/rolls/{rollId1}/inspection-defects` → `/api/v2/rolls/{rollId1}/inspection-defects`）
     - `L617`（`POST /api/inspection/rolls` → `POST /api/v2/inspection/rolls`）
     - *注：`L760` 为 `req.url().includes('/api/')` 通用写拦截断言，天然覆盖 `/api/v2/*`，无需迁移。*
  6. `.agents/skills/verify-cutdemotwo/` 技能与特征地图文档（精确行号）：
     - `.agents/skills/verify-cutdemotwo/SKILL.md`：`L14`（移除旧 `/api/*` 并列说明）、`L121`（`/api/rolls/{id}/spatial-map` → `/api/v2/rolls/{id}/spatial-map`）
     - `.agents/skills/verify-cutdemotwo/features/cam-holes-defects-and-reconciliation.md`：`L37`（`POST /api/cutting/reports/{planId}/reverse` → `POST /api/v2/cutting/reports/{planId}/reverse`）、`L39`（`POST /api/rolls` → `POST /api/v2/rolls`）
     - `.agents/skills/verify-cutdemotwo/features/inventory-inspection-and-auth-api.md`：`L15`（`/api/rolls/{rollId}/inspection-defects` → `/api/v2/rolls/{rollId}/inspection-defects`）、`L39`（`GET /api/rolls` → `GET /api/v2/rolls`）
     - `.agents/skills/verify-cutdemotwo/features/order-to-cutting-closure.md`：`L21`（`/api/rolls/{id}/spatial-map` → `/api/v2/rolls/{id}/spatial-map`）
     - *注：经全量扫描确认，`.agents/skills/verify-cutdemotwo/features/{README,auth-users-agents-and-audit,garment-marker-and-cutplan,navigation-and-ui-smoke,workbench-orchestration-mcp-and-deeplink}.md`、`scripts/verify-{ctl,deeplink-and-cutplan,workflow-gate}.mjs` 与 `src/test/browser/{app-ui-preview,garment-width}.cjs` 均无残留旧 `/api/*` 业务端点调用（`verify-deeplink-and-cutplan.mjs:254` 为通用 `/api/` 写拦截、`verify-ctl.mjs` 与 `verify-workflow-gate.mjs` 仅含合法 `/api/health` 探针）；上述文档按需由 E2E-M4 增量补充 M4 导入导出与门禁契约。*
- **供 E2E-M4 新增覆盖的 M4-3B 导入导出 `data-testid` 契约索引**：
  - 需求/BOM/DXF：`demand-import-modal`、`dxf-import-modal`（`#/demand-create` & `#/clusters`）；
  - 批量库存导入：`inv-open-batch-import-btn`（`#/inventory`）、`insp-open-batch-defects-btn` / `insp-batch-defects-modal`（`#/inspection`）；
  - 服务端导出：`res-cam-export-modal`、`res-batch-zip-modal`、`res-summary-export-modal`（`#/results`）及 `#/reconciliation`、`#/cost-analytics` 汇总导出按钮。
