---
name: verify-cutdemotwo
description: >-
  CurDemoTwo（智能布艺/板材搭切排产平台）的项目级真机端到端验收技能。
  封装独立非 8080 隔离实例启停、只读健康体检（Doctor）、4 套现役 Playwright 浏览器验收脚本驱动、证据留存及正式库存 SHA-256 零污染校验。
  当需要验证前端 React 工作台（/app/）、后端 REST/SSE API、CAM 导出、复检对账或服装唛架的真实端到端行为时使用。
---

# Verify CurDemoTwo（真机隔离验收技能）

本技能面向接手任务、首次操作本仓库的 Agent，提供**零猜测、零污染正式 `8080` 与正式 `data/cutdemo-state.json`** 的真机验收标准流。

- **主交互面**：React SPA 工作台（`http://127.0.0.1:<PORT>/app/`，5 组 12 项导航，14 个现代 Hash 路由如 `#/workbench`、`#/slitting` 及 `?taskId=&resultId=&draftId=` 深链）
- **次交互面**：Spring Boot REST / SSE API（`/api/*`、`/api/v2/*`、`/api/v2/workbench/*`）、OpenAPI 3.1（`/api-v2/openapi.json`）、MCP 服务（`integrations/mcp`，22 工具 + PNG 预览）
- **统一辅助控制器**：[`scripts/verify-ctl.mjs`](./scripts/verify-ctl.mjs)（零外部依赖，跨平台）
- **功能验收地图索引**：[`features/README.md`](./features/README.md)（驱动前必读）

> **铁律**：严禁将任何自动化验收指向正式 `8080` 端口；严禁向正式 `data/cutdemo-state.json` 及 `data/cutdemo-state.json.drafts` 注入测试单据；清理过程严禁按 `java.exe` 进程名强杀（防止误杀用户常驻 `8080` 服务）。
>
> **Windows / Agent 进程生命周期提示**：在带 Job Object 进程组回收的命令执行器中，跨不同 shell 会话的独立后台子进程可能被系统自动终止；务必在**同一条 shell 会话**内以 `try / finally` 串联 `launch → doctor → drive → cleanup`。

---

## Launch（启动隔离验收实例）

前置条件：存在最新构建产物 `target/CutDemoTwo-0.0.1-SNAPSHOT.jar`（若刚改动代码或尚未打包，先执行 `.\mvnw.cmd -DskipTests package` 或完整 `.\mvnw.cmd clean package`）。

```powershell
# 1. 启动默认免登隔离实例（端口严禁为 8080，默认 18091）
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18091

# 2. 若需验收企业认证（HS256 + 5 角色 RBAC + Bearer SSE），附加 --auth
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18092 --auth
```

- **数据物理隔离**：自动在系统临时目录 `os.tmpdir()/cutdemo-verify/run-<runId>/` 下显式隔离 `--cutdemo.state.path`、`--cutdemo.jobs.path`、`--cutdemo.integration.path` 与 `--cutdemo.workbench.drafts.path`（防止外部环境变量污染正式 `data/` 目录），并开启 `--cutdemo.seed-demo-data=true`。
- **可用就绪判据**：并非只看端口监听，必须同时满足进程存活 + `GET /app/` 返回 `200` + `GET /api/health` 返回 `status="UP"` 且 `storageStatus="UP"`（认证模式改为校验 `GET /api/v2/auth/me` 返回 `enabled=true`）。
- **启动输出**：返回 JSON 中的 `sessionFile`、`baseUrl`、`evidenceDir` 与正式库存启动前 `prodStateSha256Before`。

---

## Doctor（只读健康体检）

首次驱动前、以及**任意一次驱动失败或行为异常后**，必须先执行一次只读体检：

```powershell
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs doctor --session "<sessionFile>"
```

体检项（全通过返回 `HEALTHY` 且退出码 `0`）：
1. 隔离服务 PID 存活；
2. 磁盘 `target/CutDemoTwo-0.0.1-SNAPSHOT.jar` 与运行中实例一致（未因重新打包而陈旧）；
3. `GET /app/` 返回 HTTP 200；
4. 免登模式：`GET /api/health` 为 `UP` 且 `storageStatus=UP`，且 `GET /api/v2/inventory-ledger/reconciliation` 为 `BALANCED`；认证模式：`GET /api/v2/auth/me` 返回 `enabled=true`；
5. 正式 `data/cutdemo-state.json` 的 SHA-256 与正式 `data/cutdemo-state.json.drafts` 目录指纹与启动前一致；
6. 自动报告探测到的本机 `playwright` / `playwright/test` 模块与 Chrome/Edge 可执行路径。

---

## Drive（驱动验收脚本与地图）

先查阅 [`features/README.md`](./features/README.md) 选择对应功能地图，优先通过控制器驱动仓库现役 4 套 Playwright 脚本及技能配套 2 套闭环脚本：

```powershell
# A. 全路由渲染、旧书签重定向、筛选与零写零错冒烟（22 项，只读）
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script ui-preview

# B. 下单 -> 排料工作台 -> 选定方案锁料 -> 新建待检卷/质检放行/绑卷 -> 完工记账 -> 空间条 -> 设置弹窗（5 阶段闭环）
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script unified-workflow

# C. 带孔裁片 G-Code 先孔后外 + 20mm 避疵窗 + 双任务复检三端一致 + 80 件四层 Konva 帧耗时基线
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script closure-perf --perf-budget-ms 120

# D. 服装多门幅唛架对比、180° 旋转、补空与四大件 DXF 压紧验收（28 项，需 playwright/test）
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script garment-width

# E. 22 工具工业级 MCP stdio 真机闭环（含 PNG 预览图、持久化草案与库存零污染，零浏览器依赖）
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script mcp-live-smoke

# F. 服装第二 Tab 订单自动分床（GARM-06）+ 工作台深链预览/草案预检/版本漂移告警（DEEP-01..03）
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script deeplink-and-cutplan
```

### 配套无头自动化套件（按改动范围按需组合）

| 套件 | 命令 |
| :--- | :--- |
| Java 全量编译测试打包 | `.\mvnw.cmd clean package` |
| 前端 TypeScript 类型检查 | `npm run typecheck --prefix frontend` |
| 前端 Vitest 单元测试 | `npm test --prefix frontend` |
| JS 模块与架构无环门禁 | `node --test src/test/js/*.test.mjs` |
| 全仓架构耦合只读体检 | `node scripts/arch-coupling-audit.mjs --fail-on-cycle` |
| 防遗漏工作流闭环门禁 | `node scripts/workflow-closure-audit.mjs --fail` |
| MCP 企业级契约测试 | `npm test --prefix integrations/mcp` |
| Outbox 同步 Worker 测试 | `node --test integrations/inventory/test/sync-worker.test.mjs` |

---

## Evidence（证据标准与存放位置）

- **存放位置**：独立于运行临时目录，默认为 `os.tmpdir()/cutdemo-verify/evidence-<runId>/`（可通过 `launch --evidence-dir <dir>` 自定义，严禁放到临时运行目录 `run-<runId>/` 内部）。
- **自动落盘内容**：每次 `drive` 自动写出 `<script>-<timestamp>.log`（含时间、URL、驱动路径、退出码、耗时与完整 stdout/stderr），`closure-perf` 同步写出 `<script>-<timestamp>.result.json`（含 G-Code 统计、三端对账数与 P50/P95 帧耗时）。
- **验真标准**：
  1. 必须走真实页面与真实 HTTP/SSE 路径，禁止通过内部后门跳过质检或篡改状态；
  2. 涉及业务写入的验收，必须通过只读接口（`/api/v2/demand-pool`、`/api/v2/schemes`、`/api/rolls/{id}/spatial-map`、`/api/v2/inventory-ledger/reconciliation`）交叉核对落库副作用；
  3. 汇报必须严格区分“发现数 / 实际执行数 / 成功 / 失败 / 跳过”，且跳过项说明真实原因（例如缺原生 C++ 二进制）。

---

## Cleanup（精准清理且保留证据）

无论测试通过、失败还是中途报错，**每次运行结束必须执行清理**：

```powershell
node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs cleanup --session "<sessionFile>"
```

清理逻辑保证：
1. 仅按 `sessionFile` 中记录的精确 `pid` 终止进程树（Windows `taskkill /pid <pid> /t /f`，POSIX `SIGTERM`/`SIGKILL`），绝不波及正式 `8080`；
2. 删除隔离临时目录 `run-<runId>/`（临时状态文件、`.jobs`、`.integrations`、`.drafts`、临时日志）；
3. **保留全部证据文件**并输出存活证据文件名清单；
4. 自动复核端口已释放，且正式 `data/cutdemo-state.json` 的 SHA-256 及正式 `data/cutdemo-state.json.drafts` 目录指纹严格零变动（`prodInventoryUntouched: true`、`prodDraftsUntouched: true`）。

---

## Helpers（附带脚本说明）

- [`scripts/verify-ctl.mjs`](./scripts/verify-ctl.mjs)：统一验收控制器，提供 `launch`、`doctor`、`drive`、`cleanup` 四个子命令，已覆盖自动探测本机 `playwright` / `playwright-core` / `playwright/test` 与系统 Chrome/Edge，并支持零浏览器依赖的 `mcp-live-smoke`。
- [`scripts/verify-deeplink-and-cutplan.mjs`](./scripts/verify-deeplink-and-cutplan.mjs)：技能自有真机补充驱动，覆盖服装第二 Tab 订单自动分床（`GARM-06`）与工作台深链/草案/版本漂移告警（`DEEP-01..03`）。
