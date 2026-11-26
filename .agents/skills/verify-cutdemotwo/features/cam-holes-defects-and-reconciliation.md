# 带孔 CNC 加工、20mm 避疵窗、跨任务复检对账与画布性能

验证高风险制造正确性与交互流畅度：带内孔异形裁片在起切线外沿 20mm 边界疵点约束下全链路无损求解并导出“先切内孔、后切外轮廓”且零侵入禁区的 G-Code；双任务合排报工后对单片复检判废时，母卷消耗不回滚且工作台/复检对账/成本核算三端净良品与残值严格一致；80 件四层 Konva 画布缩放与平移满足交互帧预算。

## Sub-features

- `CAM-01`：带内孔（`shape.holes`）异形裁片在求解、选定落库与 G-Code（`.nc`）导出全链路无损透传，且 CNC 刀路严格先切全部 `INNER HOLE` 后切 `OUTER CONTOUR`。
- `CAM-02`：位于工位起切线外沿的疵点按 `20mm` 安全边距先扩边再裁窗（前后端口径一致），所有导出刀路点零侵入边界安全禁区。
- `CAM-03`：双任务合排完工报工后，对其中任务 A 单片执行复检判废：原母卷消耗保持不变、任务 A 净良品扣减并释放补排余量、任务 B 净良品与面积不受波及，且 `#/workbench`、`#/reconciliation`、`#/cost-analytics` 三端数值一致。
- `PERF-01`：80 件裁片在四层 Konva 画布（`WorkbenchBoardCanvas`）下真实滚轮缩放与拖拽平移的 P50 / P95 帧耗时低于预算阈值。

## How to get to it (user POV)

- 加工求解与 CNC 导出：`搭切工作台`（`#/workbench`）选卷求解 → `方案与工单`（`#/results`）下载 CNC G-Code（`.nc`）。
- 复检判废与三端核对：`复检与对账`（`#/reconciliation`）登记复检处置或受控撤销/报工冲销 → 跳转 `搭切工作台`（`#/workbench`）与 `成本与备料`（`#/cost-analytics`）核对净良品与成本残值。
- 画布交互体验：`搭切工作台`（`#/workbench`）在大批量裁片方案下使用鼠标滚轮缩放与画布拖拽平移。

## Driving it with Playwright (`verify-ctl.mjs`)

Preconditions: 已通过 `verify-ctl.mjs launch` 启动隔离实例且 `doctor` 返回 `HEALTHY`。

- **执行三大现代闭环与四层画布性能基线（4 项断言）**：
  - 命令：`node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs drive --session "<sessionFile>" --script closure-perf --perf-budget-ms 120`
  - 可观测结果：退出码 `0`；证据目录同时生成 `.log` 与 `.result.json`（含 `ncStats` 零侵入点数、双任务三端一致快照以及缩放/平移 P50/P95 帧耗时 ms）。

## Gotchas

- 本机负载高或 CPU 节流时，Konva 帧耗时 P95 可能波动；默认脚本预算为 `500ms`，严格回归建议传 `--perf-budget-ms 120` 并在实测报告中贴出真实 P50/P95 数值（不要只写“通过”）。
- 复检判废绝不可恢复已消耗的母卷长度，该业务不变量与报工冲销（`POST /api/cutting/reports/{planId}/reverse`）语义完全不同，验收时注意区分。
- 本脚本会创建带随机 UUID 标签的隔离测试母卷与双任务订单，务必仅运行在独立非 `8080` 隔离实例上。
