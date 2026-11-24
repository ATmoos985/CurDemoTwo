# 搭切 MCP 适配器（企业级 14 工具 + Streamable HTTP）

覆盖本机 stdio 与可选远程 Streamable HTTP 两种传输模式，统一经标准 REST 调用后端应用用例。计算与草稿令牌不写库存；结果均明确区分预测值与实绩值。MCP 不包含独立几何算法、库存事务或结果比较逻辑。

采用官方 `@modelcontextprotocol/server` / `client` 2.3.1，零新增重型 HTTP 框架依赖（Streamable HTTP 基于 Node 22 原生 `node:http` 与官方 `InMemoryTransport` 实现）。

## 安装与配置

需要 Node.js 22+、已启动的搭切服务及完整仓库。适配器直接读取仓库中的 `src/main/resources/static/api-v2/openapi.json`，不要单独移动 `integrations/mcp` 目录。

```sh
npm ci --ignore-scripts --prefix integrations/mcp
npm test --prefix integrations/mcp
```

### 1. 本机 stdio 模式（默认）

```json
{
  "mcpServers": {
    "cutting": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/CurDemoTwo/integrations/mcp/src/index.mjs"],
      "env": {
        "CUTTING_API_URL": "http://127.0.0.1:8080",
        "CUTTING_MCP_COMPUTE": "true",
        "CUTTING_MCP_BUSINESS_READ": "true",
        "CUTTING_MCP_ALLOW_DRAFT_SCHEME": "false",
        "CUTTING_API_TOKEN": "",
        "MCP_AUDIT_LOG_PATH": ""
      }
    }
  }
}
```

### 2. 远程 Streamable HTTP 模式（强制 Bearer 鉴权）

当 `MCP_TRANSPORT=http` 时启动 HTTP JSON-RPC 端点（默认 `POST http://127.0.0.1:3080/mcp`）：

- **强制鉴权**：必须配置至少 16 位字符的 `MCP_API_TOKEN`，否则拒绝启动，禁止无鉴权裸奔。
- **后端凭据透传**：可配置 `CUTTING_API_TOKEN` 或在单次请求中提供 `X-Cutting-Api-Token` 头，适配器以 `Authorization: Bearer <token>` 透传给受保护的后端 REST。
- **脱敏持久化审计**：配置 `MCP_AUDIT_LOG_PATH` 后，每次工具调用自动向该路径追加脱敏 JSONL 摘要（仅含 `timestamp`、`traceId`、`tool`、`inputHash`、`status`、`code`、`elapsedMs`、`resultId`、`transport`，绝不落盘原始多边形、订单备注、业务明细或访问凭据）。

```sh
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3080 \
MCP_API_TOKEN="<至少16位随机访问令牌>" \
CUTTING_API_URL=http://127.0.0.1:8080 \
CUTTING_MCP_COMPUTE=true \
CUTTING_MCP_BUSINESS_READ=true \
CUTTING_MCP_ALLOW_DRAFT_SCHEME=true \
MCP_AUDIT_LOG_PATH=./logs/mcp-audit.jsonl \
node integrations/mcp/src/index.mjs
```

服务 URL 只接受字面量回环地址 `127.0.0.1` 或 `[::1]`，不接受路径、凭据、域名或重定向。所有权限开关由宿主环境控制，模型无法通过工具参数自行开启。

## 全部 14 个工具目录

| # | 工具 | 开放开关 | 行为与边界 |
| --- | --- | --- | --- |
| 1 | `get_cutting_capabilities` | 默认只读 | 当前真实引擎、输入类型、限额 |
| 2 | `validate_cutting_problem` | 默认只读 | 与 REST 相同的完整输入校验；无业务写入 |
| 3 | `get_optimization_job` | 默认只读 | 阶段/状态，不伪造进度百分比 |
| 4 | `get_optimization_input` | 默认只读 | 原始不可变输入快照 |
| 5 | `get_optimization_result` | 默认只读 | 默认指标摘要；`detail=full` 含完整几何 |
| 6 | `compare_cutting_results` | 默认只读 | 服务端比较已存结果，返回约束差异与指标差值 |
| 7 | `submit_optimization_job` | `CUTTING_MCP_COMPUTE=true` | 创建持久化计算作业，明确标注非只读，不写库存 |
| 8 | `cancel_optimization_job` | `CUTTING_MCP_COMPUTE=true` | 请求协作停止；不是生产撤销 |
| 9 | `get_cutting_task` | `CUTTING_MCP_BUSINESS_READ=true` | 读取任务与净履约详情 |
| 10 | `get_inventory_ledger` | `CUTTING_MCP_BUSINESS_READ=true` | 1–100 条/页，支持全部聚合枚举（含 `COUNT`/`QUALITY_RELEASE`/`RECEIPT_IN`/`MATERIAL_ISSUE`/`ROLL_SCRAP`） |
| 11 | `find_material_candidates` | `CUTTING_MCP_BUSINESS_READ=true` | 只读选料与多料头/多母卷联合排产推荐，不占库 |
| 12 | `get_material_trace` | `CUTTING_MCP_BUSINESS_READ=true` | 只读查询 `/api/rolls/{rollId}/spatial-map`、派生料头谱系与关联流水 |
| 13 | `analyze_production_insights` | `CUTTING_MCP_BUSINESS_READ=true` | 只读工厂运营归因：整合对账异常、成本偏差、备料缺口与待排需求 |
| 14 | `save_draft_scheme` | `CUTTING_MCP_ALLOW_DRAFT_SCHEME=true` | 生成带 SHA-256 哈希、有效期与风险预检的待审批草稿令牌，**严禁直接落库扣库存**，明确交由人工确认 |

## 验证

```sh
npm test --prefix integrations/mcp
# 必须指向隔离临时库存服务；脚本拒绝 8080
CUTTING_TEST_API_URL=http://127.0.0.1:18084 node integrations/mcp/test/live-smoke.mjs
```
