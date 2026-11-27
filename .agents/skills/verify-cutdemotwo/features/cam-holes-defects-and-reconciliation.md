---
routes:
  - workbench
  - results
  - reconciliation
  - cost-analytics
---

# 带孔 CNC 加工、20mm 避疵窗、跨任务复检对账与画布性能

验证高风险制造正确性与交互流畅度：带内孔异形裁片在起切线外沿 20mm 边界疵点约束下全链路无损求解并导出“先切内孔、后切外轮廓”且零侵入禁区的 G-Code；双任务合排报工后对单片复检判废时，母卷消耗不回滚且工作台/复检对账/成本核算三端净良品与残值严格一致；80 件四层 Konva 画布缩放与平移满足交互帧预算。

## Sub-features

- `CAM-01`：带内孔（`shape.holes`）异形裁片在求解、选定落库与 G-Code（`.nc`）导出全链路无损透传，且 CNC 刀路严格先切全部 `INNER HOLE` 后切 `OUTER CONTOUR`。
- `CAM-02`：位于工位起切线外沿的疵点按 `20mm` 安全边距先扩边再裁窗（前后端口径一致），所有导出刀路点零侵入边界安全禁区。
- `CAM-03`：双任务合排完工报工后，对其中任务 A 单片执行复检判废：原母卷消耗保持不变、任务 A 净良品扣减并释放补排余量、任务 B 净良品与面积不受波及，且 `#/workbench`、`#/reconciliation`、`#/cost-analytics` 三端数值一致。
- `PERF-01`：80 件裁片在四层 Konva 画布（`WorkbenchBoardCanvas`）下真实滚轮缩放与**鼠标中键拖拽平移**（`button: 'middle'`）的 P50 / P95 帧耗时低于预算阈值。

## How to get to it (user POV)

- 加工求解与 CNC 导出：`搭切工作台`（`#/workbench`）选卷求解 → 右侧面板直接「导出 G-Code」（`closure-perf` 实测路径）或于 `方案与工单`（`#/results`）点击「导出 CNC G-Code (.nc)」。
- 复检判废与三端核对：侧栏 `复检与对账`（`#/reconciliation`，页面一级标题为「复检补排与对账」）核对净良品与禁用「冲销报工」按钮（注：`closure-perf` 经 REST API 造报工与复检记录后，在 `#/workbench`、`#/reconciliation`、`#/cost-analytics` 三页执行只读一致性校验；如需测表单提交判废/撤销/冲销请另行交互验真）。
- 画布交互体验：`搭切工作台`（`#/workbench`）在大批量裁片方案下使用鼠标滚轮缩放与鼠标中键拖拽平移。

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已通过 `verify-ctl.mjs launch` 启动隔离实例且 `doctor` 返回 `HEALTHY`。

- **执行三大现代闭环与四层画布性能基线（4 项断言）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script closure-perf --perf-budget-ms 120`
  - 可观测结果：退出码 `0`；证据目录同时生成 `.log` 与 `.result.json`（场景 1 展开输出 `innerHoleSegments / outerContourSegments / totalG01Points`，场景 2 输出双任务三端一致快照，场景 3 输出 `perfMetrics.zoom` 与 `perfMetrics.pan` 的真实 P50/P95 帧耗时 ms）。

## Gotchas

- 本机负载高或 CPU 节流时，Konva 帧耗时 P95 可能波动；默认脚本预算为 `500ms`，严格回归建议传 `--perf-budget-ms 120` 并在实测报告中贴出真实 P50/P95 数值（不要只写“通过”）。
- 复检判废绝不可恢复已消耗的母卷长度，该业务不变量与报工冲销（`POST /api/v2/cutting/reports/{planId}/reverse`）语义完全不同，验收时注意区分。
- 本脚本会创建带随机 UUID 标签的隔离测试母卷与双任务订单，务必仅运行在独立非 `8080` 隔离实例上。
- **历史缺陷归档（已于 M3 修复并持续回归守卫）**：此前 `closure-perf` 场景 1 经 `POST /api/v2/rolls` 新建 `totalLength=10000, usedLength=1000` 母卷时，曾因后端 `RollAndRemnantDomainService.saveOrUpdateMotherRollInternal` 未按 `totalLength - usedLength` 初始化 `currentRemainingLength` 而导致跑完 `closure-perf` 后 `doctor` 触发 `ROLL_LENGTH_MISMATCH`（`MISMATCH`）；该缺陷已在 M3 修复（自动按 `totalLength - usedLength` 初始化），跑完 `closure-perf` 后仍必须执行 `doctor` 确认总账与卷长零不平衡。
