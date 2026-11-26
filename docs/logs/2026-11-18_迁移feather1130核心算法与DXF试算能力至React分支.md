# 2026-11-18 迁移 `feather1130` 核心算法与 DXF 试算能力至 React 分支日志

## 1. 背景与取舍原则

审查 `feather1130` 分支自共同基线 `d3975f4` 以来的全部 6 笔提交（`5623463`、`6f76236`、`7c254c9`、`8884a3c`、`2bed024`、`2da6eca`），按照**以当前 `react` 分支全量原生 React 19 + TypeScript 工作台架构为主**的原则进行甄别与迁移：

- **直接吸收的后端核心算法、存储加固与契约能力**：
  1. `FileOptimizationJobStore` Windows 原子快照替换短暂文件锁（`AccessDeniedException`）有界指数退避重试及 4 项单测（`2bed024`）。
  2. `AxisMarkerCompactor` 多顶点异形轮廓纵横双轴梯形条带碰撞界与最长路协同压紧（解决 >48 顶点真实 DXF 纸样此前跳过压紧的瓶颈），以及 `IrregularPackingSolverService` 临时工作目录规范化（`2da6eca`）。
  3. 统一计算作业策略 v2 可选 `initialPlacements`、`NestingSolver.validateMarkerSeed` 服务端从订单需求独立重建轮廓核验、`SEED` 零预算试排阶段记录与 `openapi.json` / `optimization-request.schema.json` 契约更新（`2da6eca`）；完整保留 `react` 分支 `OptimizationService` 的并发 worker 池配置。
- **融合接入的数据模型与脚本**：
  1. 引入 `scripts/import-garment-dxf.py`、`dxf-outlines.js`、`dxf-patterns.js`、`dxf-reference.js`、`four-piece-seed.js`、`garment-demand-model.js` 与 `task-packs.js`（`5623463`、`7c254c9`、`8884a3c`、`2da6eca`）。
  2. 完整保留 `react` 分支现有 `dxf-garment-samples.js`，确保「需求与纸样簇中心」「二维自由画布」「算法演示沙盒」及浏览器 `.dxf` 原文件直传解析器零回归，同时在 `marker-demo.js` 兼容两套款式标识。
- **不回退旧 DOM 脚本、直接原生化迁入 React 组件的交互能力**：
  1. 不引入 `feather1130` 已在 `react` 清退的 `static/app/js/pages/{garment,task-edit,tasks}.js` 命令式脚本，保持 `module-boundaries.test.mjs` 纯净门禁。
  2. [GarmentWidthPage.tsx](frontend/src/pages/GarmentWidthPage.tsx) 与 [App.tsx](frontend/src/App.tsx)：支持 `#/garment/:exampleId` 直链（如 `#/garment/four-piece-130-140`）、110–160 六档动态尺码配比输入、1226/20148D/3129 面布/衬布/罗纹/里布全料号样板、可选克重留空，以及 1226 四大件原报告基准条、「优化排料（1806.90 mm · 84.39%）」与「按图复排（1848.52 mm · 82.49%）」即时预览切换，并保留 React 版顶栏 KPI 及一键送入二维自由画布/转入生产任务闭环。
  3. [TaskEditPage.tsx](frontend/src/pages/TaskEditPage.tsx) 与 [TasksPage.tsx](frontend/src/pages/TasksPage.tsx)：新建任务增加「示例包」分组下拉（M/L 齐套服装、DXF 纸样、通用业务、能力展示）与草稿 `taskPackId` 持久化；区分一维「卷」与二维「件」单位，并在窄屏粘性固定任务队列右侧主操作列。

## 2. 涉及主要文件

- 后端与契约：`AxisMarkerCompactor.java`、`MarkerCompactor.java`、`IrregularPackingSolverService.java`、`NestingSolver.java`、`SolverFactory.java`、`MarkerOptimization.java`、`OptimizationService.java`、`OptimizationRequest.java`、`FileOptimizationJobStore.java`、`openapi.json`、`optimization-request.schema.json`
- 前端模型与工具：`scripts/import-garment-dxf.py`、`dxf-outlines.js`、`dxf-patterns.js`、`dxf-reference.js`、`four-piece-seed.js`、`marker-demo.js`、`scenario-examples.js`、`garment-demand-model.js`、`garment-demands.js`、`garment.js`、`task-packs.js`
- React 组件与样式：`frontend/src/App.tsx`、`frontend/src/pages/GarmentWidthPage.tsx`、`frontend/src/pages/TaskEditPage.tsx`、`frontend/src/pages/TasksPage.tsx`、`src/main/resources/static/app/app.css`
- 测试套件：`FileOptimizationJobStoreTests.java`、`MarkerCompactorTests.java`、`MarkerOptimizationTests.java`、`dxf-reference.test.mjs`、`task-packs.test.mjs`、`garment-width.test.mjs`、`marker-demo.test.mjs`、`garment-width.cjs`

## 3. 验证结果

| 验证套件 | 发现项数 | 实际执行 | 成功 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript (`tsc --noEmit`) | 16 文件 | 16 文件 | 16 | 0 | 0 |
| Java 全量 (`mvnw -B test`) | 414 | 414 | 414 | 0 | 0 |
| JavaScript 单元与架构门禁 | 325 | 325 | 325 | 0 | 0 |
| MCP 协议与契约测试 | 8 | 8 | 8 | 0 | 0 |
| **合计** | **747** | **747** | **747** | **0** | **0** |
