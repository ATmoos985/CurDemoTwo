# 变更记录：在 .gitignore 中增加日志与运行产物规则

## 1. 变更背景与原因
- 用户反馈提交与工作区中包含大量日志文件（如 `app.log`、`logs/` 目录等），需要加入 Git 忽略配置，防止污染版本库和工作区审查。

## 2. 变更内容与涉及文件
- `.gitignore`：
  - 新增 `Logs & Runtime Output` 规则组，覆盖 `*.log`、`*.log.*`、`logs/`、`app.log`、`nohup.out`、`*.dump`、`*.dumpstream`、`hs_err_pid*`、`replay_pid*`；
  - 新增 `OS Generated` 规则组，覆盖 `.DS_Store`、`Thumbs.db`。

## 3. 验证状态
- 执行 `git status`，确认 `app.log` 与 `logs/` 目录已成功被 Git 忽略，不再出现在未跟踪文件列表中；
- 确认现有版本库中无被误提交或跟踪的 `.log` 文件。
