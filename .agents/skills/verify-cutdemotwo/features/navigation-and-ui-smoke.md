# 导航壳层、主路由渲染与旧书签重定向

用户打开 `/app/` 后，应能通过左侧 5 组 12 项主导航（以及顶部引擎胶囊/设置入口）无报错访问全部现代业务页面，历史旧书签 Hash 自动跳转至对应现代路由，且纯浏览过程不产生任何非 GET 写请求或脚本异常。

## Sub-features

- `NAV-01`：5 组 12 项主导航分组结构与当前激活态高亮（`[aria-current="page"]` 唯一）。
- `NAV-02`：13 个现代 Hash 路由（含 `#/settings` 模态弹窗深链）正常渲染一级标题且无水平溢出与 `pageerror`。
- `NAV-03`：6 类已下线旧路由（`#/tasks`、`#/task/new`、`#/planning`、`#/execution`、`#/quality`、`#/analysis`）自动重定向至对应现代路由。
- `NAV-04`：待排订单（`#/demand-library`）搜索框、空态文案与状态下拉筛选可用。
- `NAV-05`：方案与工单（`#/results`）空列表态提供可直达 `#/workbench` 的跳转链接。
- `NAV-06`：全量只读浏览期间零非 GET 写请求、零 `pageerror`。

## How to get to it (user POV)

- 浏览器访问 `http://127.0.0.1:<PORT>/`（302 重定向）或直达 `http://127.0.0.1:<PORT>/app/`（默认落点 `#/workbench`）。
- 左侧边栏 5 组导航：
  - **订单需求**：`新建订单`（`#/demands`）、`待排订单`（`#/demand-library`）、`纸样模板`（`#/clusters`）
  - **排料工作台**：`搭切工作台`（`#/workbench`）
  - **产出与核算**：`方案与工单`（`#/results`）、`复检与对账`（`#/reconciliation`）、`成本与备料`（`#/cost-analytics`）
  - **材料库存**：`卷料台账`（`#/inventory`）、`验布打标`（`#/inspection`）、`出入库单`（`#/documents`）
  - **工艺试验**：`示例沙盒`（`#/showcase`）、`服装唛架`（`#/garment`）
- 底部设置入口或顶栏引擎状态胶囊 `#engine-status` 打开设置模态弹窗（`#/settings`）。

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已通过 `verify-ctl.mjs launch` 启动非 `8080` 免登隔离实例，且 `verify-ctl.mjs doctor` 返回 `HEALTHY`。

- **执行全量只读 UI 冒烟（22 项检查）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script ui-preview`
  - 可观测结果：退出码 `0`；证据日志末尾 JSON 输出 `"executed": 22, "passed": 22, "failed": 0, "skipped": 0`，且 `browsing has no business writes or script errors` 为 `true`。
- **验证已退场经典旧页 404**：
  - 命令：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<PORT>/index.html`（及 `/linear.html`）
  - 可观测结果：均返回 `404`。

## Gotchas

- `ui-preview` 监听全过程 `page.on('request')`，一旦某个页面在挂载时误发 `POST`/`PUT`/`DELETE` 请求会立即判定失败，属于设计内的只读防回归护栏。
- 非首屏页面采用 `React.lazy` 分包懒加载；若刚修改前端未重新执行 `npm run build --prefix frontend` 或未重打包 JAR，可能加载到旧静态资源，先用 `doctor` 核对 JAR 时间戳。
- `app-ui-preview.cjs` 显式拒绝 `BASE_URL` 指向 `8080` 端口或非 `localhost`/`127.0.0.1` 地址。
