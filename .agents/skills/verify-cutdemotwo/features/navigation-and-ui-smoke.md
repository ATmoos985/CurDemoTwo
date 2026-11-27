---
routes:
  - demands
  - demand-library
  - clusters
  - workbench
  - slitting
  - results
  - reconciliation
  - cost-analytics
  - inventory
  - inspection
  - documents
  - garment
  - showcase
  - settings
  - login
  - profile
  - users
  - audit-logs
---

# 导航壳层、主路由渲染与旧书签重定向

用户打开 `/app/` 后，应能通过左侧 6 组 15 项主导航（普通角色 13 项，ADMIN/免登模式 15 项；以及左侧导航栏底部的引擎状态胶囊 `#engine-status` / 设置入口 / 认证卡片 `.mp-auth-foot-card`）无报错访问全部 18 个现代业务路由（17 个带侧栏路由 + `#/login` 独立登录路由，含 `#/slitting` 及 `#/workbench?taskId=&resultId=&draftId=` 深链），历史旧书签 Hash 自动跳转至对应现代路由，且纯浏览过程不产生任何非 GET 写请求或脚本异常。

## Sub-features

- `NAV-01`：6 组 15 项主导航分组结构与当前激活态高亮（`[aria-current="page"]` 唯一；`workbench` 导航项同时高亮 `#/workbench` 与 `#/slitting`；`系统安全` 组包含 `个人中心`、`用户与 Agent`、`操作审计`，其中非 `ADMIN` 角色仅显示 `个人中心`，全站 13 项）。
- `NAV-02`：18 个现代 Hash 路由（17 个带侧栏路由含 `#/settings`、`#/profile`、`#/users`、`#/audit-logs`、`#/slitting` + `#/login` 无侧栏独立登录页）正常渲染一级标题且零 `pageerror`（注：双视口零水平溢出断言位于 `unified-workflow` 的 `FLOW-01`）。
- `NAV-03`：6 类已下线旧路由（`#/tasks`、`#/task/new`、`#/planning`、`#/execution`、`#/quality`、`#/analysis`，以及带上下文参数的 `#/task/<id>` → `#/demands?append=<id>`、`#/execution/<id>/<planId>` → `#/results?taskId=<id>`、`#/execution/...?intent=quality` → `#/reconciliation`）自动重定向至对应现代路由。
- `NAV-04`：待排订单（`#/demand-library`）搜索框、空态文案与状态下拉筛选可用（页面另含优先级筛选与排序控件）。
- `NAV-05`：方案与工单（`#/results`）空列表态提供可直达 `#/workbench` 的跳转链接。
- `NAV-06`：全量只读浏览期间零非 GET 写请求、零 `pageerror`，根路径 `/` 返回 `302 → /app/`，且已退场经典旧页 `/index.html`、`/linear.html` 返回 `404`。

## How to get to it (user POV)

- 浏览器访问 `http://127.0.0.1:<PORT>/`（302 重定向）或直达 `http://127.0.0.1:<PORT>/app/`（免登默认落点 `#/workbench`；认证未登录自动重定向 `#/login?redirect=...`）。
- 左侧边栏 6 组导航：
  - **订单需求**：`新建订单`（`#/demands`）、`待排订单`（`#/demand-library`）、`纸样模板`（`#/clusters`）
  - **排料工作台**：`搭切工作台`（`#/workbench`，另有 1D 深链 `#/slitting` 与外部试排深链 `#/workbench?taskId=&resultId=&draftId=`）
  - **产出与核算**：`方案与工单`（`#/results`）、`复检与对账`（`#/reconciliation`）、`成本与备料`（`#/cost-analytics`）
  - **材料库存**：`卷料台账`（`#/inventory`）、`验布打标`（`#/inspection`）、`出入库单`（`#/documents`）
  - **工艺试验**：`示例沙盒`（`#/showcase`）、`服装唛架`（`#/garment`）
  - **系统安全**：`个人中心`（`#/profile`，全角色可见）、`用户与 Agent`（`#/users`，ADMIN/免登可见）、`操作审计`（`#/audit-logs`，ADMIN/免登可见）
- **左侧导航栏底部** `nav-foot` 包含认证卡片 `.mp-auth-foot-card`（`--auth` 时渲染，跳 `#/profile` 或登出）、引擎状态胶囊 `#engine-status` 与设置入口（`#/settings` 及 `#/settings/<tab>`）。

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已通过 `verify-ctl.mjs launch` 启动非 `8080` 免登隔离实例，且 `verify-ctl.mjs doctor` 返回 `HEALTHY`（认证模式下 `nav` 角色裁剪差异与 `#/login` 重定向由 `auth-rbac-agent-audit` 覆盖）。

- **执行全量只读 UI 冒烟（27 项检查，覆盖全部 18 个现代路由）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script ui-preview`
  - 可观测结果：退出码 `0`；证据日志末尾 JSON 输出 `"executed": 27, "passed": 27, "failed": 0, "skipped": 0`，且 `browsing has no business writes or script errors` 为 `true`。
- **验证根路径重定向与已退场经典旧页 404**：
  - 命令：`curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:<PORT>/`（期望 `302`），以及 `/index.html`、`/linear.html`（均期望 `404`）。

## Gotchas

- `ui-preview` 监听全过程 `page.on('request')`，一旦某个页面在挂载时误发 `POST`/`PUT`/`DELETE` 请求会立即判定失败，属于设计内的只读防回归护栏。
- 非首屏页面采用 `React.lazy` 分包懒加载；若刚修改前端未重新执行 `npm run build --prefix frontend` 或未重打包 JAR，可能加载到旧静态资源，先用 `doctor` 核对 JAR 时间戳。
- `app-ui-preview.cjs` 显式拒绝 `BASE_URL` 指向 `8080` 端口或非 `localhost`/`127.0.0.1` 地址。
