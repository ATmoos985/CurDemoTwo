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

当前一次求解处理一个矩形材料加工区；多材料联合分配、非零刀缝、多边形和轮廓刀路尚未接入。预设演示结果不再注册为求解引擎。

## 接口

- `GET /api/v1/nesting/engines`：返回引擎标识、适配器版本、支持的形状、工艺、目标、尺寸精度要求和是否可用。
- `POST /api/v1/nesting/solve`：`Content-Type: application/json`，传入完整标准问题，返回标准结果。

服务器沿用现有认证配置。接口本身不保存认证信息。示例：

```sh
curl -H 'Content-Type: application/json' \
  --data-binary @docs/examples/nesting-crosscut.json \
  http://localhost:8080/api/v1/nesting/solve
```

Windows PowerShell 中使用 `curl.exe`。另一份可调用示例是 `docs/examples/nesting-guillotine.json`。

## 输入与坐标

| 字段 | 含义与规则 |
| --- | --- |
| `schemaVersion` | 当前为字符串 `"1"` |
| `unit` | 当前为 `"mm"`，尺寸均以毫米表示 |
| `material.id` | 调用者的材料关联标识，不执行库存查询 |
| `material.shape` | 本次加工区；当前仅支持 `RECTANGLE` 的 `width`、`height` |
| `material.exclusions` | 禁入矩形的局部 `x`、`y`、`shape`、外扩距离 `clearance`；作用于成品裁片，回收余料可以带疵 |
| `material.continuesAfterRegion` | 本区末端是否仍连接后续材料；整块材料必须为 `false` |
| `parts` | 每项包含唯一整数 `id`、`name`、`shape`、正整数 `quantity`、`allowRotation` |
| `process.mode` | `CROSSCUT` 或 `GUILLOTINE` |
| `process.feedMode` | `CONTINUOUS` 连续送料或 `SHEET` 整块材料 |
| `process.startCorner` | `left-top` / `right-top` / `left-bottom` / `right-bottom`；规定起刀基准，输出坐标始终保持左上原点 |
| `process.firstStageOrientation` | `horizontal` 或 `vertical`；横切策略仅支持 `horizontal` |
| `process.trimStart` | 入口修边长度，小于材料加工区长度 |
| `process.minReusableWidth/Height` | 候选回收余料的最小宽高 |
| `process.kerf` | 当前仅支持 `0`，非零值明确拒绝 |
| `process.objective` | 横切为 `INPUT_ORDER`；矩形贯通切割为 `MAXIMIZE_PIECE_AREA` |
| `engine` | `auto`、`crosscut`、`packingsolver`；未知名称明确拒绝，不回退其他引擎 |
| `timeLimitSeconds` | 1–60 秒；C++ 进程另有启动及终止宽限时间 |

横切要求每个零件占满材料幅宽，按输入顺序尝试排列；矩形引擎使用当前三阶段贯通切割策略。它们的优化目标不同，当前没有对两者作“谁更优”的自动比较。

`allowRotation=true` 允许矩形零件旋转 90°，`false` 禁止旋转；当前不支持任意角度或镜像。引擎通过 `coordinateResolutionMm` 声明精度：PackingSolver 为 1 mm，横切为 0.1 mm（与现有刀路输出精度一致）。超出分辨率的尺寸、修边或禁入区域坐标会拒绝而非舍入。单次最多 10000 件。

几何类型保留 `vertices` 字段用于后续多边形协议演进，但当前 `POLYGON` 会返回 `UNSUPPORTED`。`RECTANGLE` 不得同时传顶点。未知 JSON 字段也会被拒绝，防止调用者传入的约束被忽略。

坐标固定为加工区左上原点，X 向右、Y 向下。母卷全局偏移、工位号和机器坐标变换由业务适配负责。例如全卷 `5–10 m` 的工位提交为局部 `0–5000 mm`。连续送料的排料沿 Y 正方向推进；整块材料的矩形引擎可根据底部起刀基准贴底排料。画布可以切换显示原点，但不得改变标准结果的坐标含义。

## 输出

`schemaVersion`、`unit`、`coordinateSystem` 描述协议。`engine` 和 `engineVersion` 标识策略及适配器版本，`elapsedMs` 是包括检查和转换的调用耗时。

| 字段 | 含义 |
| --- | --- |
| `materialId` / `processingRegion` | 本次实际提交的材料标识与加工区轮廓，不是整卷库存 |
| `placements` | 每件的标识、需求标识、局部位置、已变换的矩形形状与 `rotationDegrees` |
| `leftovers` | 候选回收余料的局部位置、形状、是否带疵；不是已入库料头 |
| `cuts` | 刀序、水平/垂直类型、明确起止点、空行程距离和说明 |
| `fulfillment` | 每项需求的请求数、排入数、未排数；未排原因 `NOT_PLACED_IN_THIS_SOLUTION` 不表示已证明无解 |
| `metrics.processingAreaMm2` | 提交的加工区面积 |
| `metrics.pieceAreaMm2` | 排入零件的面积 |
| `metrics.reusableAreaMm2` | 候选回收余料面积，可能包含带疵余料 |
| `metrics.unassignedAreaMm2` | 加工区扣除零件与候选余料后的面积，包含未动用的连续尾料，不能直接报废 |
| `metrics.suggestedFeedLengthMm` | 引擎建议的进给范围提示；不是实际扣库存长度，业务报工仍需实测确认 |

所有面积统一使用 **mm²**。旧工作台仍通过适配层转换为 m²，避免新旧口径混用。

`placements[].shape` 已是放置后的形状，`x/y` 是其左上角。矩形发生 90° 旋转时输出宽高已交换，`rotationDegrees` 记录相对原需求的旋转，画布不要再次旋转这个输出矩形。标识仅在本次问题/结果内有效。

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

## 与现有业务的兼容及下一阶段

`POST /api/solve` 保留旧请求和旧输出，适配层把内部标准结果转换回原有结构后再保存方案。现有任务、方案、库存表不增加字段；任务版本、材料快照、保存方案、报工幂等和撤回仍在原工作流内执行。历史方案继续按原结构读取和确认。料头的母卷扣料为零由适配层负责，通用求解器不接触这个业务规则。

当前画布继续读取兼容字段；下一阶段可把标准输入与 `NestingResult` 交给通用展示模型，同时将已报工状态作为独立业务覆盖层。多边形引擎、通用轮廓画布和设备刀路扩展不属于这一阶段已经具备的能力。
