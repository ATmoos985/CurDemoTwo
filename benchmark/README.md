# 排料基准套件

在一个或两个**已经启动**的 CutDemoTwo 服务上，按交替顺序重复求解一组由代码生成的题目。每题、每个服务输出排入数、利用率、耗时和实际引擎的均值与区间；给两个服务时再输出 B − A。

- 不属于 `mvn verify`：Maven 只跑 `src/test`，镜像构建只复制 `src`，CI 不会执行本目录。
- 自检（题目哈希、运行顺序、统计与表格，不需要服务）：`node --test benchmark/*.test.mjs`
- 需要 Node 22 或更新：与 `src/test/js` 一样，直接加载前端的 ES 模块取预设案例。

## 1. 启动被测服务

改前、改后各构建一个 jar，分别起在空闲端口上。旧提交用 `git archive` 导出到临时目录再构建，不动当前工作区：

```bash
T=/c/Users/Ami/AppData/Local/Temp/cutdemo-bench/suite
mkdir -p $T/src-30e3d4b && git archive 30e3d4b | tar -x -C $T/src-30e3d4b
mvn -B -q -DskipTests -f $T/src-30e3d4b/pom.xml package && cp $T/src-30e3d4b/target/CutDemoTwo-*.jar $T/30e3d4b.jar
```

```bash
java -jar $T/30e3d4b.jar --server.port=18310 --cutdemo.state.path=$T/state-30e3d4b.json --packingsolver.fallback.enabled=false --packingsolver.executable.path=D:/GitHub/CutDemoTwo/data/solver/packingsolver_rectangleguillotine.exe --packingsolver.irregular.executable.path=D:/GitHub/CutDemoTwo/data/solver/packingsolver_irregular.exe > $T/server-30e3d4b.log 2>&1 &
```

另一个服务同样启动，换成 `18311` 和它自己的状态文件。每个参数都不能省：

| 参数 | 原因 |
|---|---|
| `--server.port=18310` | 8080 留给日常预览，不要为基准重启它 |
| `--cutdemo.state.path=<临时目录>/state-x.json` | 服务一启动就写库存状态，默认写到当前目录下的 `data/cutdemo-state.json`；两个服务也不能共用一个文件 |
| `--packingsolver.fallback.enabled=false` | 原生引擎缺失时直接返回 UNAVAILABLE，不悄悄改用 javaguillotine |
| `--packingsolver.executable.path=…`<br>`--packingsolver.irregular.executable.path=…` | 默认路径是相对的 `data/solver/…`，在 worktree 或临时目录里不存在 |

启动后 `curl http://127.0.0.1:18310/api/health` 应看到 `packingsolverAvailable: true`、`packingsolverFallback: null`。跑完只结束自己启动的 java 进程（`netstat -ano | grep :18310` 查 PID）。

## 2. 运行

```bash
node benchmark/run.mjs --smoke http://127.0.0.1:18311
```

```bash
node benchmark/run.mjs --set all 30e3d4b=http://127.0.0.1:18310 05022f8=http://127.0.0.1:18311 > report.md
```

- 服务写作 `[标签=]地址`，标签建议用提交号；第一个是 A，第二个是 B。
- 进度逐行写到 stderr，最终报告（Markdown）写到 stdout。
- 每次求解后都重写结果 JSON（默认 `benchmark/results/<开始时间>.json`，已被 git 忽略），中断也不丢已完成的部分；`node benchmark/report.mjs <结果 JSON>` 重新出报告。
- `--list` 列出题目、预期引擎和请求体哈希；`--help` 列出全部选项。
- 退出码：0 全部有效；1 有无效运行；2 参数错误、服务不可用或请求中断。

## 3. 题目

题目全部由 `problems.mjs` 生成，不存 JSON。每行结果都记录请求体哈希（`JSON.stringify` 的 SHA-256 前 12 位）：哈希相同，请求就逐字节相同，可以跨次比较。

| 题集 | 题目 | 两个服务时约需 |
|---|---|---|
| `smoke` | guillotine、contour14、scenario4、synthetic2000（`--smoke` 统一限时 2 s、1 轮、不预热） | 30 s（1 轮） |
| `demo`（默认） | 试验台两个示例 + 前端预设案例 1–8，限时 3 s | 4 min（4 轮） |
| `large` | synthetic2000、synthetic10000、contour200，限时 20 s | 8 min（4 轮） |
| `all` | demo + large | 12 min（4 轮） |

另可用 `--problems` 点名：

- `scenario<N>`：前端预设案例，经 `scenario-examples.js` 转成请求，改了预设哈希就会变。
- `synthetic<N>`：10 种规格各 N/10 件，2000 × 30N mm 连续卷，需求是可用面积的 1.75 倍，两处避让；N 为 10 的倍数且不超过 10000。synthetic2000、synthetic10000 与之前 COPIES、`-e` 两次对比的请求相同（`e6227b8cb038`、`1869b4e841ef`）。
- `distinct<N>`：N 种不同规格各 1 件（mulberry32 种子 20261018），原生求解器要处理 N 种物品，是 COPIES 的最坏情况；不在任何题集里。

## 4. 测量口径

- **交替**：轮次在外层、题目在内层。两个服务时奇数轮 A 先、偶数轮 B 先，同一题前后紧挨着跑，机器状态的漂移对两边一样。不要先跑完改前再跑改后：大题受文件读写波动影响大，顺序运行会把这种波动误当成改动的效果。
- **预热**：每个服务、每个引擎先以 1 s 限时求解一次，不计入结果。
- **有效运行**：HTTP 200、`FEASIBLE`、实际引擎等于按工艺推断的引擎、没有 `fallbackReason`、裁片编号不重复。均值与区间只统计有效运行，其余计入"异常"列。
- **字段**：排入/需求、利用率（裁片面积 ÷ 加工面积）、耗时（服务返回的 `elapsedMs`）、越限（耗时 − 限时）、实际引擎。结果 JSON 另有连续卷用长、刀数、空走距离和客户端往返时间。
- **对比**：B − A 是均值之差；"利用率区间"为"区间分离"表示两边各次结果互不重叠，"区间重叠"表示这几轮还分不出高下，应加轮数或单独复现，"单次"表示某一边只有一次有效运行，没有区间可比。
- **噪声**：两个服务在同一台机器上轮流求解，另有其他负载或大小核调度时耗时会抖动；结论以区间是否分离为准，不看单次。
