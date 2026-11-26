# 库存台账、验布质检放行、单据过账与企业认证接口

验证工厂库存流转与企业级安全底线：来料采购入库生成待检卷 → 验布打标录入疵点并执行质检放行（`PENDING → PASSED/REJECTED`）→ 未放行卷严禁领料出库 → 库存总账对账严格平衡（`BALANCED`）→ 开启企业认证（`--auth`）后未登录拦截 401、5 角色 RBAC 权限隔离及 Bearer 流式 SSE 推送返回 HTTP 200。

## Sub-features

- `INV-01`：采购入库单（`#/documents`）新增待检母卷默认 `PENDING`，领料下拉框与后端接口双层拦截非 `PASSED` 母卷领料。
- `INV-02`：验布打标（`#/inspection`）保存疵点并完成质检合格放行（`POST /api/v2/quality/rolls/{rollId}/inspect-complete`）或判不合格，更新卷料台账状态。
- `INV-03`：库存账本对账接口（`GET /api/v2/inventory-ledger/reconciliation`）返回 `BALANCED` 且 `issues` 为 `0`。
- `AUTH-01`：开启 `cutdemo.auth.enabled=true` 后，`/api/v2/auth/me` 返回 `enabled=true, authenticated=false`，未带令牌写接口与业务查询返回 `401`。
- `AUTH-02`：使用内置 5 角色账户（`admin`/`planner`/`operator`/`inspector`/`warehouse`）登录后获取 HS256 Bearer 令牌，按角色校验放行与越权拦截（如仅 `ADMIN`/`INSPECTOR` 可质检放行），且带 Bearer 的 `GET /api/v2/optimization-jobs/{jobId}/events` 返回 `200 text/event-stream`。

## How to get to it (user POV)

- 库存与质检界面：左侧 `材料库存` 分组下的 `卷料台账`（`#/inventory`）、`验布打标`（`#/inspection`）、`出入库单`（`#/documents`）。
- 企业认证门控：以 `--auth` 启动隔离服后访问 `http://127.0.0.1:<PORT>/app/`，页面弹出登录门控弹窗（`AuthGateModal`），登录后顶栏显示当前角色并支持登出。

## Driving it with HTTP / `verify-ctl.mjs`

Preconditions: 验收企业认证时，使用独立端口并附加 `--auth` 启动隔离实例：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18092 --auth`，并用 `doctor` 确认 `auth_endpoint_enabled` 通过。

- **验证免登态库存与对账健康（免登实例）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs doctor --session "<localSessionFile>"`
  - 可观测结果：`api_health_up` 与 `ledger_reconciliation_balanced` 均为 `true`。
- **验证企业认证登录与 RBAC 边界（`--auth` 隔离实例，内置测试账号见 `AuthService.java`）**：
  - 未登录访问受保护接口：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18092/api/rolls` → 期望 `401`。
  - 使用 `inspector` / `inspector123` 登录 `POST /api/v2/auth/login` 获取 `token`，携带 `Authorization: Bearer <token>` 请求 `GET /api/v2/auth/me` → 期望 `200` 且 `role="INSPECTOR"`。
  - 使用 `planner` / `planner123` 登录，提交纯求解作业 `POST /api/v2/optimization-jobs` 后带 Bearer 读取 `GET /api/v2/optimization-jobs/{jobId}/events` → 期望 `200` 且 `Content-Type` 含 `text/event-stream`。
- **补充 UI 交互验真**：需要肉眼核对 `AuthGateModal`、`InspectionPage` 跑布验疵或 `DocumentsPage` 表单联动时，通过 Antigravity `browser` 子代理打开 `http://127.0.0.1:18092/app/` 并按角色走查。

## Gotchas

- 内置默认演示账号（`admin:admin123`、`planner:planner123`、`operator:operator123`、`inspector:inspector123`、`warehouse:warehouse123`）仅在未配置 `cutdemo.auth.users` 时启用，切勿作为生产口令。
- 浏览器原生 `EventSource` 无法携带 `Authorization: Bearer` 头，前端 `job-client.js` 采用 `fetch` 流式读取 SSE；回归认证模式时务必在真实页面验证求解进度流不触发 `401`。
- 验收完毕必须对认证隔离实例同样执行 `verify-ctl.mjs cleanup --session "<authSessionFile>"`。
