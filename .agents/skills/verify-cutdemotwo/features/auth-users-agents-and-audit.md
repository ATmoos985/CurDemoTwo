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

Preconditions: 使用独立非 `8080` 端口并附加 `--auth`（以及按需传 `--jvm-opts "-Xms64m -Xmx256m"`）启动隔离实例：
`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port 18092 --auth --jvm-opts "-Xms64m -Xmx256m"`
并用 `doctor` 带着管理员凭据确认 `auth_endpoint_enabled`、`auth_doctor_login`、`api_health_up` 与 `ledger_reconciliation_balanced` 全通过：
`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs doctor --session "<authSessionFile>" --auth-user admin --auth-pass admin123`

- **一键驱动全链路 Playwright + MCP + `-Xmx256m` 黑盒端到端验收（`auth-rbac-agent-audit`，34 项全真实用例，零跳过）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<authSessionFile>" --script auth-rbac-agent-audit`
  - 可观测结果：退出码 `0`；输出 `.result.json` 为 `executed: 34, passed: 34, failed: 0, skipped: 0`（`prodInventoryUntouched: true`、`prodDraftsUntouched: true`），覆盖：
    - **F10（5 正 + 5 负）**：`#/login` 重定向回跳与开放重定向清洗、`#/profile` 信息与自主改密重登、`#/users` 新建/编辑/重置/启停、401 防枚举、改密校验、登出/改密/禁用后旧 Token 立即 401、最后 `ADMIN` 防禁用 409、非 `ADMIN` 双层 403；
    - **F11（5 正 + 5 负）**：5 角色各自职责写放行、`#/users` 签发受限 Agent（`[data-testid="agent-once-token"]`）、Agent REST + MCP stdio 读写与生成草案、Bearer SSE `200 text/event-stream`、`#/audit-logs` 多维检索与脱敏详情、无/篡改 Token 401、跨职能与矩阵/编码路径绕过 403、Agent REST+MCP 越权 403、吊销 Agent 后 REST/SSE/MCP 立即 401、普通角色直访 `#/audit-logs` 403 与 `ACCESS_DENIED` 审计留痕；
    - **F12（5 正 + 5 负）**：独立临时目录与动态空闲端口构造批量单据与 >=2,500 条审计后以 `-Xms64m -Xmx256m -XX:+ExitOnOutOfMemoryError` 冷启动 `<=30s`、总账 `BALANCED`、多页低延迟遍历、12 路并发读写无 OOM、`/actuator/prometheus` 核实 `jvm_memory_max_bytes <= 268435456`、恶意极大 `size/limit` 截断与 `400` 拦截、高页码/负游标、空筛选 UI/API、非 `ADMIN`/未登录访问 `/actuator/prometheus` `403`/`401`、重启持久化一致性；
    - **Tier 3（4 组跨特性组合）**：`T3-F10×F11-01`（账号禁用实时踢下线与审计）、`T3-F11×F08-01`（Agent MCP 提案 × 人类确认落库责任链）、`T3-F12×F11-01`（`-Xmx256m` 历史积压下多角色协同审计）与 `T3-F10×F02-01`（13 vs 15 导航权限可见性差异）。
- **协同驱动 MCP `--auth` 作用域验收（`mcp-live-smoke`）**：
  - 传入控制面令牌 `CUTTING_API_TOKEN` 与受限 Agent 令牌 `CUTTING_AGENT_TOKEN` 驱动 `verify-ctl.mjs drive --session "<authSessionFile>" --script mcp-live-smoke`，验证受限 Agent 正常试排与 `403` 防火墙拦截。

## Gotchas

- `POST /api/v2/agents` 返回的明文 `token` 仅在签发响应中提供一次，数据库中仅存储元数据与 `token_version`，页面关闭一次性卡片后不可再次查看。
- `OperationAuditFilter` 严格忽略 `GET` 与 SSE 流请求，且对 `password`/`token`/`secret` 等敏感字段自动脱敏为 `***`，避免在审计表泄露凭证明文。
- 验收完毕必须对 `--auth` 隔离实例执行 `verify-ctl.mjs cleanup --session "<authSessionFile>"`，并核验正式库存 SHA-256 零变动。
