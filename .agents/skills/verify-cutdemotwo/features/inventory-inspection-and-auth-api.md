# 库存台账、验布质检放行、单据过账与企业认证接口

验证工厂库存流转与企业级安全底线：来料采购入库生成待检卷 → 验布打标录入疵点并执行质检放行（`PENDING → PASSED/FAILED`）→ 未放行卷严禁领料出库（前端禁用 + 后端 409）→ 库存总账对账严格平衡（`status="BALANCED"` 且 `issues: []`）→ 开启企业认证（`--auth`）后未登录拦截 401、5 角色 RBAC 权限隔离（含 `/api/v2/workbench/**`）及 Bearer 流式 SSE 推送返回 HTTP 200。

## Sub-features

- `INV-01`：采购入库单（`#/documents`）新增待检母卷默认 `PENDING`，领料下拉框与后端接口（`409 INVENTORY_CONFLICT`）双层拦截非 `PASSED` 母卷领料。
- `INV-02`：验布打标（`#/inspection`）保存未入档本机疵点草稿（`/api/rolls/{rollId}/inspection-defects`）并完成质检合格放行或判不合格（`POST /api/v2/quality/rolls/{rollId}/inspect-complete`，仅接受 `PASSED` 或 `FAILED`，传 `REJECTED` 返回 `400 INVALID_INPUT`），更新卷料台账状态。
- `INV-03`：库存账本对账接口（`GET /api/v2/inventory-ledger/reconciliation`）返回 `status="BALANCED"` 且 `issues` 为空数组 `[]`（`issues.length === 0`）。
- `AUTH-01`：开启 `cutdemo.auth.enabled=true` 后，白名单端点（`/api/health`、`/actuator/health/**`、`/api/v2/auth/{login,me}`、`/api/v2/integration-deliveries/**`、`/api/v2/mes/**`、`/api-v2/**`）按规则放行；`/api/v2/auth/me` 返回 `enabled=true, authenticated=false`，未带令牌访问业务接口返回 `401`（另全局具备 2MB 请求体 `413` 与写接口 600 次/分 `429` 保护）。
- `AUTH-02`：使用内置 5 角色账户（`admin`/`planner`/`operator`/`inspector`/`warehouse`）登录后获取 HS256 Bearer 令牌，业务 `GET/HEAD` 放行 5 角色，写接口按角色隔离（如仅 `ADMIN`/`INSPECTOR` 可质检放行与隔离料头放行；仅 `ADMIN`/`PLANNER` 可调 `POST /api/v2/workbench/**`，`OPERATOR`/`WAREHOUSE`/`INSPECTOR` 返回 `403`），且带 Bearer 的 `GET /api/v2/optimization-jobs/{jobId}/events` 返回 `200 text/event-stream`。

## How to get to it (user POV)

- 库存与质检界面：左侧 `材料库存` 分组下的 `卷料台账`（`#/inventory`）、`验布打标`（`#/inspection`）、`出入库单`（`#/documents`，含采购入库、领/退料、移库与盘点单）。
- 企业认证门控：以 `--auth` 启动隔离服后访问 `http://127.0.0.1:<PORT>/app/`，页面弹出原生 `<dialog>` 登录门控弹窗（`AuthGateModal`，禁用 Esc 关闭），登录后**左侧导航栏底部** `.mp-auth-foot-card` 显示当前操作员/角色并支持登出。

## Driving it with HTTP / `verify-ctl.mjs`

Preconditions: 验收企业认证时，使用独立端口并附加 `--auth` 启动隔离实例：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18092 --auth`，并用 `doctor` 确认 `auth_endpoint_enabled` 通过。

- **验证免登态库存与对账健康（免登实例）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs doctor --session "<localSessionFile>"`
  - 可观测结果：`api_health_up` 与 `ledger_reconciliation_balanced` 均为 `true`（`issues: []`）。
- **验证企业认证登录与 RBAC 边界（`--auth` 隔离实例，内置测试账号见 `AuthService.java`）**：
  - 未登录访问受保护接口：`curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:18092/api/rolls` → 期望 `401`。
  - 使用 `inspector` / `inspector123` 登录 `POST /api/v2/auth/login` 获取 `token`，携带 `Authorization: Bearer <token>` 请求 `GET /api/v2/auth/me` → 期望 `200` 且 `role="INSPECTOR"`。
  - 使用 `operator` / `operator123` 调 `POST /api/v2/workbench/drafts` → 期望 `403`；使用 `planner` / `planner123` 调 `POST /api/v2/workbench/drafts` → 放行进入业务校验（非 401/403）。
  - 使用 `planner` / `planner123` 登录，提交合法 `POST /api/v2/optimization-jobs`（可使用 `integrations/mcp/test/fixture.json`）后带 Bearer 读取 `GET /api/v2/optimization-jobs/{jobId}/events` → 期望 `200` 且 `Content-Type` 含 `text/event-stream`。
- **补充 UI 交互验真**：需要肉眼核对 `AuthGateModal`、`InspectionPage` 跑布验疵或 `DocumentsPage` 表单联动时，通过 Antigravity `browser` 子代理打开 `http://127.0.0.1:18092/app/` 并按角色走查。

## Gotchas

- 内置默认演示账号（`admin:admin123`、`planner:planner123`、`operator:operator123`、`inspector:inspector123`、`warehouse:warehouse123`）仅在未配置 `cutdemo.auth.users` 时启用，切勿作为生产口令。
- 浏览器原生 `EventSource` 无法携带 `Authorization: Bearer` 头，前端 `job-client.js` 采用 `fetch` 流式读取 SSE；回归认证模式时务必在真实页面验证求解进度流不触发 `401`。
- 验收完毕必须对认证隔离实例同样执行 `verify-ctl.mjs cleanup --session "<authSessionFile>"`。
