# 2026-10-09 需求进度条颜色调整为绿色记录

## 变更背景
用户反馈左侧“本次需求”卡片中的进度条为棕褐色（`--accent-amber: #a77b36`），要求改为绿色。

## 事实分析
1. **问题成因**：在近期提交 `d8d2e68` 中，`.demand-meter > .demand-meter-staged` 被设定为 `background: var(--accent-amber, #b98228)`。
2. **影响范围**：排料求解完成后生成的待报工裁切数量（staged）全部归入 `.demand-meter-staged`。在用户未执行报工前，整卷需求进度条和各项裁片进度条呈现 100% 棕褐色，与制造现场“需求完成/达标展示绿色”的工业视觉语义冲突。
3. **修复方案**：
   - 将 `src/main/resources/static/css/production-workbench.css` 中 `.demand-meter > .demand-meter-staged` 的背景色从 `var(--accent-amber, #b98228)` 改为 `var(--accent-green)`。
   - 同步修正 `src/main/resources/static/css/workbench-layout.css` 中 `.demand-meter > span` 与 `.demand-segment > span` 的底色为 `var(--accent-green)`，保持样式一致。

## 变更文件列表
- `src/main/resources/static/css/production-workbench.css`
- `src/main/resources/static/css/workbench-layout.css`
- `2026-10-09_demand_color_to_green.md`
