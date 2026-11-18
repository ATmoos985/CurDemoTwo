# 2026-11-18 基于 Modern Web Guidance 精简与现代化工作台 UI

## 目标与验收

　　结合本机 `~/.codex/skills/modern-web-guidance`、`impeccable`（`distill`）与项目内 `industrial-workbench-ui` 规范，对 `/app/` React 工作台做系统性降噪与现代化重构：去除面向开发者的技术栈噪音与重复导航入口，采用浏览器原生 `<dialog closedby="any">`、`<details>` 渐进展开、`role="toolbar"` 复合工具栏与语义化选择卡片，将客户与现场最关注的利用率、实占版长、较上限省料/省车数、齐套达成度及一键投产交付置于视觉中心。

## 变更文件与核心决策

1. [index.html](file:///d:/GitHub/CutDemoTwo/src/main/resources/static/app/index.html) 与 [App.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/App.tsx)
   - 移除底栏与顶栏中的 `React 19 + Vite + Zustand`、`branch: react`、`(解耦)`、`DEMO` 等内部开发术语，以及顶栏与左侧栏的重复导航链接。
   - 顶栏改为展示“01 需求与纸样簇 › 02 智能排料/分切 › 03 任务下达与报工 › 04 余料台账与对账”四段式核心业务闭环及实时并发引擎就绪状态；左侧主导航收敛为无重叠的业务分组，确保任意路由下 `nav [aria-current="page"]` 唯一标识当前页面。
2. [ModalDialog.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/components/ModalDialog.tsx)
   - 新建原生 `<dialog>` 模态框组件，通过 `showModal()` 提升至顶层并启用原生焦点锁定与 `Esc` 关闭，声明 `closedby="any"` 并内置无 `closedBy` 环境下的坐标点击遮罩关闭回退，关闭时重置 `returnValue`。
3. [NestingStudio2DPage.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/pages/NestingStudio2DPage.tsx)
   - 顶栏收敛“自由门幅 / 实卷避疵”与门幅 W、版长上限 L 及单主操作按钮，将“裁片安全间距 / 首端切头”次级工艺余量收折至渐进式 `<details>` 面板；左栏补齐一键直传 CAD DXF 入口。
   - 中栏画布控制条升级为标准 `role="toolbar"`（含 `focusgroup="toolbar wrap"`、键盘方向键漫游焦点回退及基于 `[aria-pressed="true"]` 的状态样式）。
   - 右栏翻转信息层级：首屏直接展示当前方案的综合材料利用率、实占唛架长度（含较上限省料毫米数）、排入齐套数、净面积及“移交车间执行 / 导出 DXF·G-Code”核心交付动作；7 项并行竞速引擎采用 `<details>` 手风琴与 `:has(> input:checked)` 选择卡片呈现，消除长段说明文字堆叠与选中跳动。
4. [ClusterCenterPage.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/pages/ClusterCenterPage.tsx)、[SlittingStudio1DPage.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/pages/SlittingStudio1DPage.tsx)、[TasksPage.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/pages/TasksPage.tsx)、[ExecutionCenterPage.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/pages/ExecutionCenterPage.tsx)、[SettingsPage.tsx](file:///d:/GitHub/CutDemoTwo/frontend/src/pages/SettingsPage.tsx) 与 [studio.css](file:///d:/GitHub/CutDemoTwo/frontend/src/styles/studio.css)
   - 纸样簇新建弹窗切换至原生 `ModalDialog`，卡片接入 `container-type: inline-size` 与 `:has(.cluster-check input:checked)` 选中态；一维分切台收折切边/组合宽次级约束并新增相对传统独立分切的“省车数 + 利用率增益”横幅；任务页合并重复的双层状态筛选条为单一交互式 KPI 筛选组（保留 `data-status` 与 `aria-pressed` 无障碍契约）。

## 验证与本地服务状态

- TypeScript 类型检查（`tsc -p frontend/tsconfig.json --noEmit`）：通过（0 错误，`COMPILE_PROVEN`）。
- JavaScript 模块与架构门禁测试（`node --test src/test/js/*.test.mjs`）：发现 325 / 执行 325 / 成功 325 / 失败 0 / 跳过 0。
- Java 架构边界测试（`ModuleBoundaryTests`）：发现 8 / 执行 8 / 成功 8 / 失败 0 / 跳过 0。
- 本地打包与 8080 重启：`target/CutDemoTwo-0.0.1-SNAPSHOT.jar` 已重新打包并重启，`/api/health` 返回 `UP`（两种原生求解引擎均可用，在库料头 120），`/app/index.html`、`/app/dist/react-app.js`、`/app/dist/main.css` 均返回 HTTP 200；前端交互视觉与业务验收标记 `USER_TEST_PENDING`。

