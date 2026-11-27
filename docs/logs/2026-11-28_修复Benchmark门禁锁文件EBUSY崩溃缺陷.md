# 2026-11-28 修复 Benchmark 门禁锁文件 EBUSY 崩溃缺陷

## 一、问题根因

1. 本地 `8080` 常驻预览服务启动后，Java 端 3 个文件存储类通过 `FileChannel.open(..., CREATE, WRITE)` + `tryLock()` 在整个进程生命周期持有 OS 级排他字节锁：
   - `data/cutdemo-state.json.drafts/drafts.lock`（`FileWorkbenchDraftStore`）
   - `data/cutdemo-state.json.jobs/dispatcher.lock`（`FileOptimizationJobStore`）
   - `data/cutdemo-state.json.integrations/delivery.lock`（`FileIntegrationDeliveryStore`）
2. `benchmark/gate.mjs`（原第 182–217 行）在执行隔离求解前后的 `captureDataFingerprint` 零污染校验时，会对 `.drafts`、`.jobs`、`.security`、`.audit` 全递归目录下的所有非目录文件无差别调用 `readFileSync`，未跳过 `*.lock` 句柄文件，也未捕获 `EBUSY`/`EACCES`/`EPERM` 锁冲突异常。因此在 Windows 下只要 `8080` 常驻预览服务正在运行，无论执行 `node benchmark/gate.mjs` 还是 E2E `import-export-and-benchmark` 的 `T1-F14-01`，都会在读取 `drafts.lock` / `dispatcher.lock` 时必现 `EBUSY: resource busy or locked, read` 并以退出码 `2`/`1` 崩溃。
3. 同时，`verify-import-export-and-benchmark.mjs:2500-2501`（`T1-F14-02`）硬编码校验 `benchmark` 单测总数为 `25`，必须随本次新增回归用例同步更新为 `27`。

## 二、修复方案与修改文件

| 文件 | 修改要点 |
| --- | --- |
| `benchmark/gate.mjs` | 1. 新增并导出 `sha256File(filePath, st = null, readFile = readFileSync)`：移除 `existsSync` 前置竞态，统一捕获 `ENOENT -> 'MISSING'`；捕获 `EBUSY`/`EACCES`/`EPERM` 并回退为 `LOCKED:<size>:<Math.round(mtimeMs)>` 元数据指纹，其他异常照常抛出。<br>2. 新增并导出 `directoryFingerprint(dirPath, options = {})`：遍历遇到 `*.lock` 锁文件时仅 `statSync` 记录 `L:<rel>:<size>`，彻底跳过 `readFile` 读取文件内容。<br>3. 扩展并导出 `captureDataFingerprint(rootDir, options = {})`，支持 `options.readFile` 测试钩子。 |
| `benchmark/benchmark.test.mjs` | 新增 2 条跨平台 0 skip 回归用例（总用例 `25 -> 27`）：<br>1. `captureDataFingerprint 跳过 *.lock 锁文件并捕获 EBUSY/EACCES 安全回退`（测试钩子拦截任何 `.lock` 读取并验证 `EBUSY`/`EACCES` 元数据回退与大小变更检出）；<br>2. `Windows OS 真实 FileStream.Lock 字节锁冲突下 captureDataFingerprint 仍稳定通过`（Windows 下启动 PowerShell `.NET FileStream.Lock(0, 1024)` 真锁住 `drafts.lock`、`dispatcher.lock` 与 `audit/live.jsonl`，先自证原生 `readFileSync` 触发 `EBUSY`，再断言 `captureDataFingerprint` 稳定通过；非 Win32 验证常规锁与 `EPERM` 回退路径，确保 0 skip）。 |
| `.agents/skills/verify-cutdemotwo/scripts/verify-import-export-and-benchmark.mjs` | 同步第 15 行注释与第 2500–2501 行 `T1-F14-02` 断言，将 `benchmark/*.test.mjs` 单测预期总数由 `25` 更新为 `27`。 |
| `docs/代码模块与实施进度.md` | 索引本日志并同步第 3 节 Benchmark 工具单测口径说明（`25 -> 27` 项）。 |

## 三、验证记录（8080 持锁态实测）

- `node --test benchmark/*.test.mjs`：`27/27 PASS`（`fail: 0`, `skipped: 0`，含 Windows OS 真实 `FileStream.Lock` 测试）
- `node --test scripts/*.test.mjs src/test/js/*.test.mjs`：`182/182 PASS`（`fail: 0`, `skipped: 0`）
- `node scripts/workflow-closure-audit.mjs --fail`：`PASS`（0 违规）
- `node scripts/arch-coupling-audit.mjs --fail-on-cycle`：`PASS`（0 SCC / 0 超千行）
- `node --check .agents/skills/verify-cutdemotwo/scripts/verify-import-export-and-benchmark.mjs`：通过
- 后续将同步完成本地提交、停旧 `8080` 重打 `target/CutDemoTwo-0.0.1-SNAPSHOT.jar`、重启 `8080` 后台预览服务并在新 `8080` 持锁态实跑 `benchmark/gate.mjs --set v2-gate --auth` 与隔离 E2E `import-export-and-benchmark`。
