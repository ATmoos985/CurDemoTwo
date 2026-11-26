# 沉淀项目级真机隔离验收技能 `verify-cutdemotwo`（2026-11-26）

## 目标与验收

基于全局 `create-verification-skill` 规范，将 CurDemoTwo 的隔离端口启停、只读健康体检（Doctor）、4 套现役 Playwright 验收脚本驱动、证据独立留存及正式库存 SHA-256 防污染校验，固化为项目级自动发现技能 `.agents/skills/verify-cutdemotwo/` 及 5 份用户视角功能验收地图，并完成端到端真机实跑自证。

## 变更文件

- 新增 `.agents/skills/verify-cutdemotwo/SKILL.md`：项目级验收技能主入口（含 `Launch` / `Doctor` / `Drive` / `Evidence` / `Cleanup` / `Helpers` 六节，零占位符）。
- 新增 `.agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs`：跨平台零外部依赖验收控制器，支持 `launch`（强制拒跑 8080、隔离 `--cutdemo.state.path`、支持 `--auth`）、`doctor`（PID/JAR 一致性、`/app/`、`/api/health`、账本对账 `BALANCED`、正式库存 SHA-256 与 Playwright/Chrome 自动探测）、`drive`（自动注入 `BASE_URL`/`PLAYWRIGHT_MODULE`/`CHROME_PATH` 并落盘证据）与 `cleanup`（仅按 PID 精准停服、清临时目录、保留证据目录并二次复核正式库存零变动）。
- 新增功能验收地图（`.agents/skills/verify-cutdemotwo/features/`）：
  - `README.md`（基线前置、驱动约定与功能总索引）
  - `navigation-and-ui-smoke.md`（5 组 12 项导航、13 现代路由与 6 旧路由重定向）
  - `order-to-cutting-closure.md`（下单 → 搭切工作台 → 选定锁料 → 待检母卷/质检放行/绑卷 → 二次确认完工记账 → 空间条 → 设置弹窗）
  - `cam-holes-defects-and-reconciliation.md`（带孔 CNC 先孔后外、20mm 边界避疵窗、双任务复检三端一致与 80 件四层 Konva 帧耗时）
  - `garment-marker-and-cutplan.md`（服装多门幅唛架对比、180° 旋转、补空、四大件与订单自动分床）
  - `inventory-inspection-and-auth-api.md`（来料质检放行、待检卷禁领料、账本对账与 `--auth` 企业认证/RBAC/SSE 鉴权）

## 端到端真机自证结果（隔离端口 `18091`）

- **安全护栏（拒跑 `8080`）**：`verify-ctl.mjs launch --port 8080` 直接拒跑，退出码 `2`。
- **`launch` + 驱动前 `doctor`**：成功于 `http://127.0.0.1:18091` 启动隔离实例（`pid=73520`），`doctor` 6/6 检查 `HEALTHY`，自动探测本机 Chrome 与 `playwright` / `playwright/test`。
- **`drive --script ui-preview`**：发现 `22` / 实际执行 `22` / 成功 `22` / 失败 `0` / 跳过 `0`（耗时 `8.88s`），零写零错。
- **`drive --script unified-workflow`**：发现 `5` / 实际执行 `5` / 成功 `5` / 失败 `0` / 跳过 `0`（耗时 `12.03s`），全生命周期闭环通过。
- **驱动后 `doctor`**：隔离实例由 `revision=1` 演进至 `revision=7`，账本对账仍为 `BALANCED`，正式库存 SHA-256 零变动。
- **`cleanup` 与清理后核验**：`pidKilled=true`、`portReleased=true`、`tmpDirRemoved=true`、`evidencePreserved=true`（2 份证据日志完整存活），正式 `data/cutdemo-state.json` SHA-256 前后完全一致（`edad0900a208cb515abeaccabb844314588a5d3a7755708034199a0c353bbfaf`），正式 `http://127.0.0.1:8080/api/health` 保持 `UP`（`revision=44`）。

## 尚未实跑项说明

- 本次仅新增 `.agents/skills/` 验收资产与文档，未改动任何 Java / TypeScript 生产代码，故未重打包或重启正式 `8080` 服务。
- 映射地图中的 `closure-perf`、`garment-width` 与 `--auth` 认证专项已编入控制器和地图，本轮自证按 `create-verification-skill` 规约实跑了 `ui-preview` 与 `unified-workflow` 两条主链路，其余两条可在涉及算法/服装/鉴权改动或首次运行 `maintain-verification-skill` 时按需触发。
