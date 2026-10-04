# 标准裁切接口 v1

## 当前能力

同一套无库存副作用的内核服务两条入口：

```text
现有工作台 /api/solve
  → CuttingWorkflowService（任务、库存版本、保存方案）
  → FabricSolveAdapter（业务输入 → 局部裁切问题）
  → SolverFactory → CrossCutSolverService / PackingSolverService
  → 通用结果校验 → NestingResult
  → FabricSolveAdapter（转换原工作台结果，料头母卷扣料为零）

独立调用 /api/v1/nesting/solve
  → SolverFactory → 同一套引擎与结果校验 → NestingResult
```

独立入口不读取母卷或料头库存、不创建任务、不保存方案、不报工。`material.id` 只是调用者提供的关联标识，不要求在数据库中存在。纯 Java 调用也可直接使用 `SolverFactory.solve(NestingProblem)`，无需 HTTP 或库存服务。

当前一次求解处理一块材料加工区。矩形策略保留原规则；新增 `CONTOUR` 策略通过 PackingSolver irregular 处理简单多边形材料和零件。多材料联合分配、非零刀缝、孔洞、圆弧和可执行的轮廓刀路尚未接入。预设演示结果不再注册为求解引擎。

## 接口

- `GET /api/v1/nesting/engines`：返回引擎标识、适配器版本、支持的形状、工艺、目标、尺寸精度要求和是否可用。
- `POST /api/v1/nesting/solve`：`Content-Type: application/json`，传入完整标准问题，返回标准结果。

服务器沿用现有认证配置。接口本身不保存认证信息。示例：

```sh
curl -H 'Content-Type: application/json' \
  --data-binary @docs/examples/nesting-crosscut.json \
  http://localhost:8080/api/v1/nesting/solve
```

Windows PowerShell 中使用 `curl.exe`。其他可调用示例为 `docs/examples/nesting-guillotine.json` 和 `docs/examples/nesting-contour.json`。

## 输入与坐标

| 字段 | 含义与规则 |
| --- | --- |
| `schemaVersion` | 当前为字符串 `"1"` |
| `unit` | 当前为 `"mm"`，尺寸均以毫米表示 |
| `material.id` | 调用者的材料关联标识，不执行库存查询 |
| `material.shape` | 本次加工区；`RECTANGLE` 或 `POLYGON`，多边形仅用于 `CONTOUR` |
| `material.exclusions` | 禁入轮廓的局部 `x`、`y`、`shape`、外扩距离 `clearance`；作用于成品裁片，回收余料可以带疵 |
| `material.continuesAfterRegion` | 本区末端是否仍连接后续材料；整块材料必须为 `false` |
| `parts` | 每项包含唯一整数 `id`、`name`、`shape`、正整数 `quantity`、`allowRotation` |
| `process.mode` | `CROSSCUT`、`GUILLOTINE` 或 `CONTOUR` |
| `process.feedMode` | `CONTINUOUS` 连续送料或 `SHEET` 整块材料 |
| `process.startCorner` | `left-top` / `right-top` / `left-bottom` / `right-bottom`；规定起刀基准，输出坐标始终保持左上原点 |
| `process.firstStageOrientation` | `horizontal` 或 `vertical`；横切策略仅支持 `horizontal`；轮廓排料为 `none` |
| `process.trimStart` | 入口修边长度，小于材料加工区长度 |
| `process.minReusableWidth/Height` | 候选回收余料的最小宽高 |
| `process.kerf` | 当前仅支持 `0`，非零值明确拒绝 |
| `process.objective` | 横切为 `INPUT_ORDER`；矩形贯通切割与轮廓排料为 `MAXIMIZE_PIECE_AREA` |
| `engine` | `auto`、`crosscut`、`packingsolver`、`packingsolver-irregular`；未知名称明确拒绝，不回退其他引擎 |
| `timeLimitSeconds` | 1–60 秒；C++ 进程另有启动及终止宽限时间 |

横切要求每个零件占满材料幅宽，按输入顺序尝试排列；矩形引擎使用当前三阶段贯通切割策略。它们的优化目标不同，当前没有对两者作“谁更优”的自动比较。

`allowRotation=true` 允许矩形零件旋转 90°，`false` 禁止旋转；当前不支持任意角度或镜像。引擎通过 `coordinateResolutionMm` 声明精度：矩形 PackingSolver、异形 PackingSolver 与横切均为 0.1 mm（与现有刀路输出精度一致）。矩形适配器版本 2 将输入毫米值精确放大 10 倍传给整数求解器，输出坐标、尺寸、刀路和面积均还原为原有单位；支持一位小数的疵点档案，无需修改库存数据。超出分辨率的尺寸、修边或禁入区域坐标会拒绝而非舍入。矩形单次最多 10000 件；轮廓排料最多 200 件、按数量展开后最多 10000 个顶点、最多 128 个禁入区域。

`POLYGON` 的 `vertices` 按边界顺序列出 3–128 个 `{x,y}` 顶点，顺逆时针均可，末点不重复首点。要求简单多边形、无重复顶点、自交或边界自接触，坐标非负且外接框左上角归零；`width/height` 必须等于顶点的外接范围。多边形面积根据真实轮廓计算，不能使用外接框面积。`RECTANGLE` 不得同时传顶点。未知 JSON 字段也会被拒绝，防止调用者传入的约束被忽略。

坐标固定为加工区左上原点，X 向右、Y 向下。母卷全局偏移、工位号和机器坐标变换由业务适配负责。例如全卷 `5–10 m` 的工位提交为局部 `0–5000 mm`。连续送料的排料沿 Y 正方向推进；整块材料的矩形引擎可根据底部起刀基准贴底排料。画布可以切换显示原点，但不得改变标准结果的坐标含义。

## 输出

`schemaVersion`、`unit`、`coordinateSystem` 描述协议。`engine` 和 `engineVersion` 标识策略及适配器版本，`elapsedMs` 是包括检查和转换的调用耗时。

| 字段 | 含义 |
| --- | --- |
| `materialId` / `processingRegion` | 本次实际提交的材料标识与加工区轮廓，不是整卷库存 |
| `placements` | 每件的标识、需求标识、局部位置、已变换的实际形状与 `rotationDegrees` |
| `leftovers` | 候选回收余料的局部位置、形状、是否带疵；不是已入库料头 |
| `cuts` | 刀序、水平/垂直类型、明确起止点、空行程距离和说明 |
| `contours` | 轮廓排料返回的闭合裁片边界，包含 `placementId`、材料局部坐标 `vertices`、`closed=true`；无走刀顺序、进退刀或刀具补偿 |
| `fulfillment` | 每项需求的请求数、排入数、未排数；未排原因 `NOT_PLACED_IN_THIS_SOLUTION` 不表示已证明无解 |
| `metrics.processingAreaMm2` | 提交的加工区面积 |
| `metrics.pieceAreaMm2` | 排入零件的面积 |
| `metrics.reusableAreaMm2` | 候选回收余料面积，可能包含带疵余料 |
| `metrics.unassignedAreaMm2` | 加工区扣除零件与候选余料后的面积，包含未动用的连续尾料，不能直接报废 |
| `metrics.suggestedFeedLengthMm` | 引擎建议的进给范围提示；不是实际扣库存长度，业务报工仍需实测确认 |

所有面积统一使用 **mm²**。旧工作台仍通过适配层转换为 m²，避免新旧口径混用。

`placements[].shape` 已是放置后的形状，`x/y` 是其左上角。矩形发生 90° 旋转时输出宽高已交换，`rotationDegrees` 记录相对原需求的旋转，画布不要再次旋转输出形状。标识仅在本次问题/结果内有效。

成功结果在返回前检查：需求归属、件数、尺寸、允许旋转、材料边界、禁入区、成品与余料之间的重叠以及刀路坐标范围。这些几何检查不等于机床加工认证；完整切割顺序、夹持、共边等能力仍需各工艺的后续验证。

## 状态与错误

| HTTP | `status` | 含义 |
| --- | --- | --- |
| 200 | `FEASIBLE` | 获得通过几何核验的可行结果，允许部分需求未排入；不宣称全局最优 |
| 200 | `NO_SOLUTION_FOUND` | 本次未获得可用零件布局，仍返回材料与未完成数量；不宣称已证明无解 |
| 400 | `INVALID_INPUT` | 格式、数量、单位内数值或标识等输入有误 |
| 422 | `UNSUPPORTED` | 协议版本、形状、工艺、目标、精度或其他能力不支持 |
| 503 | `UNAVAILABLE` | 所需引擎未就绪 |
| 500 | `FAILED` / `INVALID_RESULT` | 引擎执行失败或结果未通过公共校验 |

错误结果不包含可用于报工的几何。错误不产生任务、方案或库存变更。

## 轮廓排料的能力边界

- 自动分发：`CONTOUR` → `packingsolver-irregular`；支持矩形、凹/凸简单多边形及禁入区。
- 当前仅支持 `SHEET`、`continuesAfterRegion=false`、`startCorner=left-top`、`firstStageOrientation=none`。起刀角仅作坐标基准，不承诺轮廓切割顺序。
- `trimStart`、`minReusableWidth/Height`、`kerf` 必须为零；不支持的约束明确拒绝，不静默忽略。
- `allowRotation=true` 允许 0/90/180/270°，false 仅 0°。正角在 X 向右、Y 向下的画布上表现为顺时针。禁止镜像和任意角旋转。
- 矩形禁入区的 `clearance` 按轴向外扩；多边形禁入区目前要求 `clearance=0`，调用者可直接提供已包含安全间距的轮廓。
- 结果独立核验需求、数量、形状与旋转的等价性、实际材料范围、裁片真实交叠面积和禁入区。内部布尔面积计算容差为 0.001 mm²，仅用于浮点误差，不是工艺间隙。
- `cuts=[]`、`leftovers=[]`、`reusableAreaMm2=0`、`suggestedFeedLengthMm=0`。`contours` 是零件实际边界，不能作为已认证的 NC 刀路。未分配区域也不能按外接框直接建成库存料头。
- 使用固定上游版本 `3f4faae1a4bc42e2276c5729878933010d37ca14`，适配范围小于引擎全部能力。求解时限内只承诺经过核验的可行结果，不承诺最优或全部排入。

Docker 镜像构建会同时编译两个原生引擎并执行集成测试。Windows 可按原方式构建上游目标 `PackingSolver_irregular_main`，再执行：

```powershell
./scripts/prepare-windows-solver.ps1 -Engine irregular -SolverExecutable <packingsolver_irregular.exe路径> -RuntimeDirectory <同工具链DLL目录>
```

配置项为 `packingsolver.irregular.executable.path`，环境变量为 `PACKINGSOLVER_IRREGULAR_PATH`；默认 `data/solver/packingsolver_irregular.exe`。部署时需包含对应运行库。集成测试要求实际引擎存在，不以跳过代替验证。

## 与现有业务的兼容

`POST /api/solve` 保留旧请求和旧输出，适配层把内部标准结果转换回原有结构后再保存方案。现有任务、方案、库存表不增加字段；任务版本、材料快照、保存方案、报工幂等和撤回仍在原工作流内执行。历史方案继续按原结构读取和确认。料头的母卷扣料为零由适配层负责，通用求解器不接触这个业务规则。

## 通用画布与裁切试验台

打开 `/nesting.html`，或从业务工作台的「工具与设置 → 裁切试验台」进入独立页面。可以输入材料尺寸、需求、禁入区和工艺参数，调用标准求解接口，查看加工区、裁片、候选余料、刀路、需求完成情况及面积。横切、矩形避疵和异形示例使用同一套页面与绘图代码；材料、需求、禁入区均可选择轮廓类型并逐点编辑多边形。选择多边形会切换为轮廓排料策略。页面仅调用 `/api/v1/nesting/engines` 与 `/api/v1/nesting/solve`，不装载库存、不创建业务任务。

「标准输入 / 输出」允许编辑完整输入 JSON 和导出输入、结果。表单没有暴露的字段仍保留在请求中，不会自动丢弃未知约束。输入变化会立即清除旧结果并取消前端等待，迟到的响应不会覆盖新输入；取消等待不代表后端算法进程已经终止。导出的结果只属于当前输入。长度显示为 mm，界面面积显示为 m²，JSON 中面积仍为 mm²。

前端分层如下：

```text
标准输入 / 标准结果 → createNestingScene → renderNestingGeometry → 通用画布
原业务状态 → createWorkspaceScene ────────────┘
                       └→ 独立 overlay（已报工裁片、完成范围）
```

- `js/nesting/nesting-scene.js`：纯展示模型，不读取业务状态，固定左上原点；直接使用已变换的裁片宽高，不会按旋转角再次交换。
- `js/nesting/nesting-renderer.js`：共享几何绘制；交互回调、显示选项和完成状态由宿主传入。
- `js/nesting/nesting-viewer.js`：独立画布宿主，提供适合材料、缩放、平移、裁片点选、尺寸和刀路开关。
- `js/plugins/cad/workspace-scene.js`：原工作台的业务适配，保留全卷坐标及工位偏移，完成状态单独传递。原来的拖拽微调、测量、标尺、母卷导航和报工仍由业务插件负责。

通用画布展示矩形和实际多边形，不对已变换的形状再次旋转。凹多边形不在可能落于形状外的外接框中心强行放置标签，点选后在结果栏查看详情。可执行轮廓刀路、独立试验台的手动修改排布以及多材料联合求解尚未实现。
