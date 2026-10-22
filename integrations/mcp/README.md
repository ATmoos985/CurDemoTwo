# 搭切 MCP 适配器

第一阶段可用范围：本机 stdio → 标准 REST → 现有应用用例。计算不会写库存；结果是预计值。MCP 没有独立算法、库存事务或结果比较逻辑。

采用官方 `@modelcontextprotocol/server` / `client` 2.3.1，依赖由 lockfile 固定，协议协商交给 SDK。参考：[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[工具契约](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。旧 2025 协议兼容由 SDK 提供；本批验收使用同版本官方客户端，不声称所有客户端均已验证。

## 安装与配置

需要 Node.js 22+、已启动的搭切服务及完整仓库。适配器直接读取仓库中的 OpenAPI，不复制一套模型参数；不要单独移动 `integrations/mcp` 目录。

```sh
npm ci --ignore-scripts --prefix integrations/mcp
npm test --prefix integrations/mcp
```

在支持 stdio MCP 的客户端中添加配置，将 `command` 和 `args` 改为本机绝对路径：

```json
{
  "mcpServers": {
    "cutting": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/CurDemoTwo/integrations/mcp/src/index.mjs"],
      "env": {
        "CUTTING_API_URL": "http://127.0.0.1:8080",
        "CUTTING_MCP_COMPUTE": "true",
        "CUTTING_MCP_BUSINESS_READ": "false"
      }
    }
  }
}
```

服务 URL 只接受字面量回环地址 `127.0.0.1` 或 `[::1]`，不接受路径、凭据、域名或重定向。这里的权限开关由本机宿主控制，模型不能在工具参数中开启。设置 `CUTTING_MCP_COMPUTE=true` 意味着允许消耗计算与归档配额；关闭时提交/取消工具不注册。业务读取默认关闭。适配器未自动写入任何 AI 客户端配置。

这是受信任本机单用户集成，不是远程或多租户权限边界：查询可读该服务已有作业，不限制为某个调用人的作业。尚未实现 OAuth、服务账号、组织/数据范围、远程 Streamable HTTP 或防篡改审计；不能把本机服务转发到公网后当作已完成认证。后续远程适配必须与 REST 共用服务端身份与授权。

## 工具

| 工具 | 默认可用 | 行为 |
| --- | --- | --- |
| `get_cutting_capabilities` | 是 | 当前真实引擎、输入类型、限额 |
| `validate_cutting_problem` | 是 | 与 REST 相同的完整输入校验；无业务写入 |
| `get_optimization_job` | 是 | 阶段/状态，不伪造进度百分比 |
| `get_optimization_input` | 是 | 原始不可变输入快照 |
| `get_optimization_result` | 是 | 默认指标摘要；`detail=full` 含完整几何 |
| `compare_cutting_results` | 是 | 服务端比较已存结果，返回约束差异与指标差值 |
| `submit_optimization_job` | 计算开关 | 创建持久化作业，明确标注非只读 |
| `cancel_optimization_job` | 计算开关 | 请求协作停止；不是生产撤销 |
| `get_cutting_task` | 业务读取开关 | 任务与净履约详情 |
| `get_inventory_ledger` | 业务读取开关 | 1–100 条/页，用 `nextCursor` 续查 |

`jobId/resultId` 是作业 UUID；`resultRef` 是 REST 相对路径，读取结果时使用 UUID，不把整条 URL 放进 ID。MCP resource `cutting://contracts/openapi` 提供完整契约。工具的结构化返回为 `{data: ...}`，同时提供 JSON 文本；错误为 `isError=true`，文本中含 code、message、retryable、traceId。

入参、出参均按 OpenAPI 校验，不接受 `approved`、`tenantId` 等额外字段。请求 256 KiB、响应读取 4 MiB、HTTP 等待 20 秒，不跟随重定向，不自动重试 POST。响应过大明确报错，不静默截断。等待超时不代表提交失败，必须以原幂等键与原正文重试；取消结果也需要再查询状态确认。

通过处理器的工具调用向 stderr 写 JSON 审计摘要：traceId、工具、参数 SHA-256、结果编号/错误码、耗时。stdout 只用于 MCP 协议。日志不保存完整需求、备注、布局或凭据；SDK 在调用前拒绝的无效输入不进入此摘要。日志保存由宿主负责，目前不是持久化权限审计。

## 结果比较

`GET /api/v2/result-comparisons?leftId=...&rightId=...` 与 MCP 调用同一个服务端用例。只有输入问题类型、版本、齐套要求和硬约束一致，且指标 name/unit/basis/version 一致，才返回 `rightMinusLeft`；否则保留两侧定义并给出不同比较状态，不自动推荐赢家。

允许引擎、时间预算、优化目标/一维 profile 和唛架缩短策略不同。需求/材料及其他约束按原结构比较，数组顺序不同也保守视为不同，不宣称数学等价。百分比指标差值为百分点，不是相对提升率；COMPLETE 是方案履约，不是已经生产完成。不在适配层重算几何或放宽约束。

## 验证

```sh
npm test --prefix integrations/mcp
# 必须指向隔离临时库存服务；脚本拒绝 8080
CUTTING_TEST_API_URL=http://127.0.0.1:18084 node integrations/mcp/test/live-smoke.mjs
```

首个命令覆盖协议工具发现、权限开关、Schema、路径输入、资源限制、错误与日志、官方客户端 stdio 互通。第二个命令通过真实 MCP 子进程执行能力→校验→提交→幂等→轮询→摘要/布局→比较→取消已完成作业→流水读取，核对库存对账前后完全不变；会生成纯计算归档，不应对正式服务运行。

`test/fixture.json` 是完整输入示例。`test/evaluation-template.xml` 为 10 个只读 AI 评估题；用 smoke 生成的 `resultId` 替换 `JOB_ID` 后可运行人工/模型评估。答案口径已由固定输入及实际服务结果核验；此题库不等同于已完成某个模型的评估。构建镜像前的 Node 测试阶段也执行 MCP 测试，最终 Java 服务镜像不包含或启动 Node 适配器。
