# 排料基准套件与求解质量门禁

基于代码生成的确定性题集，支持对单个或两个 CutDemoTwo 服务执行 2D 直刀/横切/异形（含内孔）、1D 分切异步作业及多料接力联排对比；并提供一键非 `8080` 端口隔离真机门禁 `gate.mjs`。

- 不属于 `mvn verify`：Maven 只跑 `src/test`，镜像构建只复制 `src`。
- **构建期纯单测（毫秒级，不启动服务）**：`node --test benchmark/*.test.mjs`（校验题目哈希、调度、多类型度量与 `thresholds.json` 红线判定逻辑；已接入 `Dockerfile` 与 `.github/workflows/image.yml`）。
- **真机求解质量门禁（隔离端口，自动启停 JAR）**：`node benchmark/gate.mjs --set v2-gate --auth`。
- 需要 Node 22 或更新：与 `src/test/js` 一样，直接加载前端 ES 模块取预设案例与几何定义。

## 1. 一键隔离门禁（推荐）

`benchmark/gate.mjs` 自动在独立非 `8080` 端口（默认 `18391`，严禁 `8080`）启动隔离实例（将 `state` / `jobs` / `integrations` / `drafts` / `security` / `audit` 全部挂载到系统临时目录，并注入 `--cutdemo.seed-demo-data=true`），跑完指定题集与红线校验后按 PID 树精准停止子进程、清理临时目录，并比对 `data/cutdemo-state.json` SHA-256 确认正式库存零变动。

```bash
# 1. 构建最新可执行 JAR
.\mvnw.cmd -DskipTests package

# 2. 免登模式跑全平台自主引擎闭环门禁（v2-gate 共 8 题）
node benchmark/gate.mjs --set v2-gate

# 3. 企业认证模式跑门禁（注入 --cutdemo.auth.enabled=true 并自动调用 /api/v2/auth/login）
node benchmark/gate.mjs --set v2-gate --auth

# 4. 在装有原生 C++ solver（data/solver/*.exe）的环境中跑 demo/all 全集
node benchmark/gate.mjs --set demo --auth
```

常用参数：
- `--set <smoke|demo|v2-gate|large|all>`：默认 `v2-gate`；`--problems <a,b>` 可点名题目。
- `--rounds <n>` / `--warmup <n>`：默认 `1` 轮、`0` 次预热（对比基准可设为 `--rounds 2 --warmup 1`）。
- `--auth` / `--username <u >` / `--password <p>` / `--token <jwt>`：支持自动登录 `POST /api/v2/auth/login` 或直接传入 `Bearer` Token（亦支持环境变量 `CUTDEMO_BENCH_USER`、`CUTDEMO_BENCH_PASS`、`CUTDEMO_BENCH_TOKEN`）。**日志与结果 JSON 中绝不落盘密码或 Token**。
- `--port <18391>`：指定隔离端口（严禁 `8080`，除非显式 `--allow-8080`）。
- `--base <http://127.0.0.1:18391>`：连接已运行的隔离服务并跳过启停 JAR。
- `--allow-fallback`：允许原生 C++ 引擎缺失时回退至自主引擎（门禁默认 `false`，严格零降级）。
- `--thresholds <path>`：默认读取 `benchmark/thresholds.json`。

## 2. 双服务对比运行（`run.mjs`）

改前、改后各构建一个 JAR，分别起在独立隔离端口与独立状态文件上后运行：

```bash
node benchmark/run.mjs --set v2-gate --rounds 4 --auth 30e3d4b=http://127.0.0.1:18310 HEAD=http://127.0.0.1:18311 > benchmark/results/report.md
```

- 服务写作 `[标签=]地址`，第一个是 A，第二个是 B，输出 B − A。
- 进度逐行写到 stderr，最终报告（Markdown）写到 stdout；`node benchmark/report.mjs <结果 JSON>` 可从已落盘 JSON 重建报告。
- `--list` 列出题目、预期引擎与请求体哈希；`--help` 列出全部选项。
- 退出码：`0` 全部有效且红线通过；`1` 有无效运行、红线违约或库存污染；`2` 参数错误、服务不可用、鉴权失败或请求中断。

## 3. 题集与 `/api/v2/*` 覆盖

题目全部由 `problems.mjs` 生成，每题记录请求体 SHA-256 前 12 位作为指纹。

| 题集 | 题目 | 对接端点与核心覆盖 |
|---|---|---|
| `v2-gate`（门禁默认） | `guillotine-java`、`scenario1`、`scenario4-java`、`contour14`、`contour-holes-16`、`nesting-2d-job`、`slitting-basic`、`multi-material-relay` | 全平台自主引擎零降级闭环：2D 直刀/横切/异形/带内孔扣面积、`POST/GET /api/v2/optimization-jobs`（2D + 1D `OR-Tools QUALITY`）、`POST /api/v2/planning/multi-material`（3 料头 + 2 母卷连续接力） |
| `smoke` | `guillotine`、`guillotine-java`、`contour14`、`scenario4`、`synthetic2000` | 快速冒烟（2s/1 轮） |
| `demo` | `guillotine`、`contour14`、`scenario1`–`scenario8` | 试验台示例 + 全部前端预设场景（含原生 C++ 题目） |
| `large` | `synthetic2000`、`synthetic10000`、`contour200` | 大规模连续卷与异形上限压测（20s） |
| `compare` | `guillotine-java`、`scenario4-java`、`contour14`、`contour14-native` | 自主引擎 vs 原生引擎对照 |
| `all` | `demo` + `large` | 全量 2D 基准 |

## 4. 测量口径与红线纪律

- **交替与预热**：轮次在外层、题目在内层；双服务时奇偶轮交替先后，消除环境漂移。
- **2D（含带内孔）**：通过 `/api/v2/nesting/solve` 或 `/api/v2/optimization-jobs` (`NESTING_2D`) 求解，校验 `FEASIBLE`、`validationStatus=PASSED`、无重复裁片、默认无降级，以及带 `holes` 裁片扣孔净面积一致。
- **1D 分切（`SLITTING_1D`）**：轮询 `/api/v2/optimization-jobs` 至终态并拉取 `/api/v2/optimization-results/{id}`，提取 `motherAreaUtilization`（母卷总面积利用率）、`usableAreaUtilization`（扣切边可用幅宽利用率）、排刀方案数与超产卷数，校验 `maxOverproduced`。
- **多料接力（`multi-material`）**：调用 `/api/v2/planning/multi-material`，校验件数守恒（`totalRequestedPieces === placedByRemnants + placedByRoll + unplacedPieces`），统计料头排入件数 `placedByRemnants`、接力母卷数 `relayRollCount`、节省面积与综合利用率，并强制校验 `minRemnantPlaced` 与 `minRelayRolls`。
- **红线反作弊纪律**：`benchmark/thresholds.json` 中的红线基于真机实测稳态数据设定，严禁为凑通过而无依据下调 `minUtilization`、`minPlacedRatio`、`minRemnantPlaced` 或 `minRelayRolls`。
