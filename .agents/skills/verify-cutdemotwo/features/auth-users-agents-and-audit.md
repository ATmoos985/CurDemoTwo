---
routes:
  - login
  - profile
  - users
  - audit-logs
---

# 多角色认证、个人中心、用户与 AI Agent 管理及全站操作审计

验证企业认证模式（`cutdemo.auth.enabled=true`）下的完整身份治理、RBAC 与 Agent 作用域隔离、以及全站操作审计可观测闭环：路由级独立登录页 `#/login`（防 401 请求风暴与 `redirect` 安全回跳）→ 个人中心 `#/profile` 自助改密与主动登出吊销令牌 → 管理员在 `#/users` 管理数据库持久化操作员与签发/吊销受限 AI Agent 凭证 → 全站关键业务与安全操作落库 `operation_audit_log` 并在 `#/audit-logs` 多维分页检索。

## Sub-features

- `SEC-01`：独立路由级登录页（`#/login`）。开启企业认证且未登录时，访问任意受保护页面自动重定向至 `#/login?redirect=...` 且不挂载侧栏与业务面板（避免并发 401 请求风暴）；输入合法凭据登录 `POST /api/v2/auth/login` 后持久化 Bearer 令牌并安全回跳原路由（屏蔽开放重定向与 `#/login` 死循环）。本地免登模式（`cutdemo.auth.enabled=false`）下访问 `#/login` 显示免登状态并提供一键进入工作台。
- `SEC-02`：个人中心（`#/profile`）。展示当前账号、角色、主体类型（`USER` / `AGENT`）、Agent ID、到期时间及有效 `scopes`；支持当前用户校验并修改登录密码（`PUT /api/v2/auth/password`，使用 `PBKDF2WithHmacSHA256` 盐值哈希落库并递增 `token_version`，改密成功后立即吊销并清理旧令牌、引导重登）；支持主动点击登出（`POST /api/v2/auth/logout` 写入 `sys_token_revocation` 吊销当前 `jti`）使旧令牌再请求返回 `401`。
- `SEC-03`：管理员用户管理（`#/users`「操作员账户」Tab）。仅 `ADMIN` 角色可访问（非管理员直访 URL 由前端守卫与后端 `AuthSecurityFilter` 双重返回 `403` 拦截）；支持基于原生 `<dialog>` 创建用户（`POST /api/v2/users`）、修改显示名与角色（`PUT /api/v2/users/{username}`）、启停账号（`POST /api/v2/users/{username}/status`，禁用时立即吊销存量令牌）及管理员重置密码（`POST /api/v2/users/{username}/reset-password`）。
- `SEC-04`：AI Agent 受限凭证与越权隔离（`#/users`「AI Agent 凭证」Tab + MCP/REST 全链路）。管理员选择细粒度作用域（`DEMAND_READ` / `DEMAND_WRITE` / `INVENTORY_READ` / `PLAN_COMPUTE` / `DRAFT_WRITE`）与有效期签发凭证（`POST /api/v2/agents`），创建后**仅一次性展示并支持复制明文 Bearer Token**；Agent 越权执行确认落库（`POST /api/v2/schemes/confirm` / `POST /api/v2/workbench/drafts/{id}/confirm`）、出入库、质检或用户管理接口时服务端硬拦截返回 `403` 并记录 `ACCESS_DENIED` 审计；支持一键吊销（`POST /api/v2/agents/{agentId}/revoke`），吊销后请求返回 `401`。
- `SEC-05`：全站持久化操作审计检索（`#/audit-logs`）。覆盖认证（`AUTH_LOGIN`/`AUTH_LOGOUT`/`AUTH_PASSWORD_CHANGE`）、用户与 Agent 管理、越权拦截（`ACCESS_DENIED`）、需求/草案/方案、车间报工/冲销、质检放行与库存单据写入；仅 `ADMIN` 可检索 `GET /api/v2/audit-logs`，支持按 `targetId`/`targetType` 单据、按 `actor`/`actorType` 操作人、`action`、`outcome` 与时间范围（`from`/`to`）筛选、分页及原生 `<dialog>` 查看脱敏详情。

## How to get to it (user POV)

- 未登录跳转：以 `--auth` 启动隔离实例后打开 `http://127.0.0.1:<PORT>/app/#/workbench`，系统自动重定向至 `#/login?redirect=%23%2Fworkbench`。
- 登录后导航：左侧栏底部 `.mp-auth-foot-card` 点击账号区域跳转 `#/profile` 或点击「登出」吊销会话；左侧导航 `系统安全` 分组下包含 `个人中心`（`#/profile`，全角色可见），`ADMIN` 账号额外可见 `用户与 Agent`（`#/users`）与 `操作审计`（`#/audit-logs`）。

## Driving it with HTTP / `verify-ctl.mjs`

Preconditions: 使用独立非 `8080` 端口并附加 `--auth` 启动隔离实例：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18092 --auth`，并用 `doctor` 确认 `auth_endpoint_enabled` 为 `true`。

- **验证独立登录与 RBAC 界面隔离**：
  - 使用 `admin` / `admin123` 登录 `POST /api/v2/auth/login` 获取管理员令牌；
  - 请求 `GET /api/v2/users`、`GET /api/v2/agents`、`GET /api/v2/audit-logs?page=0&size=20` → 期望均返回 `200`；
  - 使用 `planner` / `planner123` 登录后请求上述 3 个端点 → 期望均返回 `403 FORBIDDEN`，并在审计日志中生成 `action="ACCESS_DENIED"` 记录。
- **验证 Agent 凭证签发、作用域拦截与吊销**：
  - 管理员调用 `POST /api/v2/agents`（携带 `{"name":"verify-agent","scopes":["DEMAND_READ","PLAN_COMPUTE"],"ttlHours":24}`）→ 返回 `201` 及一次性 `token`；
  - 使用该 Agent Token 调用 `GET /api/v2/demand-pool` → `200`；调用 `POST /api/v2/schemes/confirm` 或 `POST /api/v2/inventory-receipts` → `403 FORBIDDEN`；
  - 调用 `POST /api/v2/agents/{agentId}/revoke` 吊销后再持原 Token 请求 `GET /api/v2/demand-pool` → `401 UNAUTHORIZED`。
- **验证主动登出与改密令牌失效**：
  - 持有效用户 Token 调用 `POST /api/v2/auth/logout` 返回 `{"revoked":true}`，再持同 Token 请求 `GET /api/rolls` → `401 UNAUTHORIZED`。

## Gotchas

- `POST /api/v2/agents` 返回的明文 `token` 仅在签发响应中提供一次，数据库中仅存储元数据与 `token_version`，页面关闭一次性卡片后不可再次查看。
- `OperationAuditFilter` 严格忽略 `GET` 与 SSE 流请求，且对 `password`/`token`/`secret` 等敏感字段自动脱敏为 `***`，避免在审计表泄露凭证明文。
- 验收完毕必须对 `--auth` 隔离实例执行 `verify-ctl.mjs cleanup --session "<authSessionFile>"`，并核验正式库存 SHA-256 零变动。
