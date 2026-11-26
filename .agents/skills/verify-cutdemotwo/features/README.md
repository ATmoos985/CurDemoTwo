# CurDemoTwo 功能验收地图（Feature Map）

本目录是 CurDemoTwo 用户视角真机验收的维护事实源。执行真机验收前先读本索引，再按改动范围挑选对应功能文件驱动验证。

## 基线前置条件

- 使用 `node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs launch --port <非8080>` 启动独立隔离实例，数据目录完全隔离于 `os.tmpdir()/cutdemo-verify/run-<runId>/`。
- 禁止连接或操作 `http://127.0.0.1:8080`；禁止向正式 `data/cutdemo-state.json` 写入测试数据。
- 首次驱动前及每次失败重试前，必须执行 `verify-ctl.mjs doctor --session "<sessionFile>"` 并确认返回 `HEALTHY`。
- 若业务流程发生持久化修改（如 `unified-workflow`、`closure-perf`），优先使用独立隔离会话或新启动实例，避免前序脏数据干扰断言。

## 驱动与证据约定

- 优先使用 `verify-ctl.mjs drive --session "<sessionFile>" --script <name>` 驱动仓库内现役 Playwright 脚本；需要排查单页交互或补充专项验证时，结合 Antigravity `browser` 子代理或直接 HTTP `fetch`/PowerShell 验真。
- 交互定位优先选用稳定语义句柄（ARIA role/name、`#id`、`data-*` 属性、明确 Hash 路由），不依赖脆性像素坐标。
- 所有证据文件保存在独立 `evidenceDir` 中；验收完毕执行 `verify-ctl.mjs cleanup` 后，必须核实证据仍完整存在且正式 `data/cutdemo-state.json` SHA-256 零变动。
- 若某路径因前置条件（例如未开启 `--auth`、本机缺原生 C++ 二进制或缺少 `playwright/test`）不可达，如实标为未验证并注明缺失前置，绝不借道另一条路径冒充通过。

## 功能地图索引

1. [导航壳层、主路由渲染与旧书签重定向](./navigation-and-ui-smoke.md) — 覆盖 5 组 12 项导航、13 现代路由与 6 类旧路由自动跳转、只读筛选、零写零错（对应 `ui-preview`）。
2. [下单到完工记账全流程闭环](./order-to-cutting-closure.md) — 覆盖新建订单、需求库、搭切工作台 2D/多料联排选定锁料、A4 车间派工单、新建待检母卷与质检放行绑卷、二次确认完工记账、母卷空间条与设置弹窗（对应 `unified-workflow`）。
3. [带孔 CNC 加工、20mm 避疵窗、跨任务复检对账与画布性能](./cam-holes-defects-and-reconciliation.md) — 覆盖异形内孔先切后外 G-Code、边界 20mm 疵点零侵入、双任务复检三端净良品与残值守恒、80 件四层 Konva 缩放/平移帧耗时基线（对应 `closure-perf`）。
4. [服装多门幅唛架对比与订单自动分床](./garment-marker-and-cutplan.md) — 覆盖 180° 掉头与固定方向对比、同款补空、18 个内置与 DXF 服装示例、四大件 16 片压紧及第二 Tab 自动分床（对应 `garment-width`）。
5. [库存台账、验布质检放行、单据过账与企业认证接口](./inventory-inspection-and-auth-api.md) — 覆盖卷料来料质检放行、待检卷禁领料、采购/领退料单据、库存账本对账 `BALANCED` 及 `--auth` 模式 HS256/RBAC/SSE 鉴权验证。
