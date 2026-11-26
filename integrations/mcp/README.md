# 搭切排产 MCP 适配器 v1（22 工具 + 零依赖 PNG 预览 + 全本机 Harness 适配）

统一面向 **Codex / Claude Desktop / Cursor / Pi** 等所有标准 MCP Harness，支持本机 `stdio` 与可选受保护 `Streamable HTTP` 两种传输模式。全部业务与算法调用均走仓库标准 REST API，**绝不直接锁库、报工或扣减实物库存**；试排结果与持久化草案均附带前端工作台深链 URL（`workbenchUrl`）与零依赖高对比工业风 PNG 蓝图预览，交由授权计划员人工核对后点击「选定此方案」落库。

采用官方 `@modelcontextprotocol/server` / `client` 2.3.1，**零新增第三方依赖**（Streamable HTTP 基于 Node 22 原生 `node:http` 与 `InMemoryTransport`，PNG 排料渲染器基于 `node:zlib` 与纯 JS 像素缓冲实现）。

---

## 安装与验证

需要 **Node.js 22+**、已启动的本机搭切服务（默认 `http://127.0.0.1:8080`）及完整仓库。适配器直接读取 `src/main/resources/static/api-v2/openapi.json`，请勿单独移出 `integrations/mcp` 目录。

```sh
npm ci --ignore-scripts --prefix integrations/mcp
npm test --prefix integrations/mcp
```

---

## 安全边界与权限开关

- **严格回环地址校验**：`CUTTING_API_URL` 仅接受字面量回环地址 `http(s)://127.0.0.1[:port]` 或 `http(s)://[::1][:port]`，拒绝域名、路径、凭据、查询串与重定向。
- **宿主隔离开关**：以下 4 个环境变量仅接受 `'true'` / `'false'`（默认全 `false`），由宿主环境控制，模型无法通过工具参数自授权：
  - `CUTTING_MCP_COMPUTE`：开放纯计算排料作业提交/取消（与业务只读同时开启时开放一键编排试排 `plan_task_on_material`）
  - `CUTTING_MCP_BUSINESS_READ`：开放需求池、库存全景、模板库、分床纯计算、母卷追踪、运营归因与同口径对比
  - `CUTTING_MCP_ALLOW_DRAFT_SCHEME`：开放后端持久化待审批草案 `save_draft_scheme`（不写库存）
  - `CUTTING_MCP_ALLOW_DEMAND_WRITE`：开放需求池建单/合并 `create_demand_task`（仅写待排需求池，不扣实物库存）
- **脱敏审计日志**：每次工具调用向 `stderr`（以及可选 `MCP_AUDIT_LOG_PATH` JSONL）写入白名单摘要（`timestamp` / `traceId` / `tool` / `inputHash` / `status` / `code` / `elapsedMs` / `resultId` / `transport`），绝不落盘原始多边形顶点、客户订单备注、PNG 图像数据或访问令牌。

---

## 各本机 Harness 一键接入配置（连接 `http://127.0.0.1:8080`）

请将示例中的 `/abs/path/to/CurDemoTwo` 替换为你的本机仓库绝对路径（Windows 路径可用正斜杠 `C:/path/to/CurDemoTwo`）。

### 1. Codex CLI（`~/.codex/config.toml`）

```toml
[mcp_servers.cutting]
command = "node"
args = ["/abs/path/to/CurDemoTwo/integrations/mcp/src/index.mjs"]

[mcp_servers.cutting.env]
CUTTING_API_URL = "http://127.0.0.1:8080"
CUTTING_MCP_COMPUTE = "true"
CUTTING_MCP_BUSINESS_READ = "true"
CUTTING_MCP_ALLOW_DRAFT_SCHEME = "true"
CUTTING_MCP_ALLOW_DEMAND_WRITE = "true"
```

### 2. Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "cutting": {
      "command": "node",
      "args": ["/abs/path/to/CurDemoTwo/integrations/mcp/src/index.mjs"],
      "env": {
        "CUTTING_API_URL": "http://127.0.0.1:8080",
        "CUTTING_MCP_COMPUTE": "true",
        "CUTTING_MCP_BUSINESS_READ": "true",
        "CUTTING_MCP_ALLOW_DRAFT_SCHEME": "true",
        "CUTTING_MCP_ALLOW_DEMAND_WRITE": "false"
      }
    }
  }
}
```

### 3. Cursor（项目 `.cursor/mcp.json` 或全局 MCP 设置）

```json
{
  "mcpServers": {
    "cutting": {
      "command": "node",
      "args": ["/abs/path/to/CurDemoTwo/integrations/mcp/src/index.mjs"],
      "env": {
        "CUTTING_API_URL": "http://127.0.0.1:8080",
        "CUTTING_MCP_COMPUTE": "true",
        "CUTTING_MCP_BUSINESS_READ": "true",
        "CUTTING_MCP_ALLOW_DRAFT_SCHEME": "true",
        "CUTTING_MCP_ALLOW_DEMAND_WRITE": "true"
      }
    }
  }
}
```

### 4. Pi（`~/.pi/agent/mcp.json` 或 `pi` MCP 插件配置）

```json
{
  "mcpServers": {
    "cutting": {
      "transport": "stdio",
      "command": "node",
      "args": ["/abs/path/to/CurDemoTwo/integrations/mcp/src/index.mjs"],
      "env": {
        "CUTTING_API_URL": "http://127.0.0.1:8080",
        "CUTTING_MCP_COMPUTE": "true",
        "CUTTING_MCP_BUSINESS_READ": "true",
        "CUTTING_MCP_ALLOW_DRAFT_SCHEME": "true",
        "CUTTING_MCP_ALLOW_DEMAND_WRITE": "true"
      }
    }
  }
}
```

### 5. 可选本机/内网 Streamable HTTP 模式（强制 Bearer 鉴权）

当 `MCP_TRANSPORT=http` 时启动 HTTP JSON-RPC 端点（默认 `POST http://127.0.0.1:3080/mcp`），强制要求至少 16 位字符的 `MCP_API_TOKEN`，支持通过 `CUTTING_API_TOKEN` 或请求头 `X-Cutting-Api-Token` 透传后端 Bearer 凭据：

```sh
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3080 \
MCP_API_TOKEN="<至少16位随机访问令牌>" \
CUTTING_API_URL=http://127.0.0.1:8080 \
CUTTING_MCP_COMPUTE=true \
CUTTING_MCP_BUSINESS_READ=true \
CUTTING_MCP_ALLOW_DRAFT_SCHEME=true \
CUTTING_MCP_ALLOW_DEMAND_WRITE=false \
MCP_AUDIT_LOG_PATH=./logs/mcp-audit.jsonl \
node integrations/mcp/src/index.mjs
```

---

## 全部 22 个工具总表

| # | 工具名称 | 开放开关 | 行为与安全边界 |
| --- | --- | --- | --- |
| 1 | `get_cutting_capabilities` | 默认只读 | 查询真实引擎可用性、支持问题类型与配额上限 |
| 2 | `validate_cutting_problem` | 默认只读 | 与标准 REST 相同的 `nesting-v1` / `slitting-v1` 校验；无业务写入 |
| 3 | `get_optimization_job` | 默认只读 | 查询作业真实阶段/状态与 `resultRef`，不伪造进度百分比 |
| 4 | `get_optimization_input` | 默认只读 | 读取作业不可变标准化输入快照 |
| 5 | `get_optimization_result` | 默认只读 | 默认 `detail=summary` 省略几何；`detail=full` 含完整排料坐标 |
| 6 | `compare_cutting_results` | 默认只读 | 服务端确定性比较已存结果，硬约束不同时抑制差值 |
| 7 | `render_cutting_preview` | 默认只读 | 零依赖渲染 2D（矩形/异形含内孔/疵点/计划料头）或 1D 分切高对比 PNG 预览图 + 完整 `workbenchUrl` |
| 8 | `submit_optimization_job` | `CUTTING_MCP_COMPUTE=true` | 提交持久化纯计算作业，支持 `idempotencyKey` 重试，不写库存 |
| 9 | `cancel_optimization_job` | `CUTTING_MCP_COMPUTE=true` | 请求协作取消计算作业；不是生产撤销，不回滚库存 |
| 10 | `get_cutting_task` | `CUTTING_MCP_BUSINESS_READ=true` | 只读查询任务详情与当前净履约进度 |
| 11 | `get_inventory_ledger` | `CUTTING_MCP_BUSINESS_READ=true` | 1–100 条/页内部库存流水查询，支持全量聚合枚举 |
| 12 | `find_material_candidates` | `CUTTING_MCP_BUSINESS_READ=true` | 只读选料与多料头/多母卷联合排产推荐，不占库 |
| 13 | `get_material_trace` | `CUTTING_MCP_BUSINESS_READ=true` | 查询母卷空间图、派生料头谱系与关联流水；辅助源失败显式输出 `partialErrors` |
| 14 | `analyze_production_insights` | `CUTTING_MCP_BUSINESS_READ=true` | 工厂运营归因（对账、成本、备料缺口、待排负荷）；失败显式输出 `partialErrors` |
| 15 | `list_demand_pool` | `CUTTING_MCP_BUSINESS_READ=true` | 多维待排需求池过滤查询，返回各任务履约统计与 `workbenchUrl` |
| 16 | `list_available_materials` | `CUTTING_MCP_BUSINESS_READ=true` | 并发查询母卷与料头（不吞错），明确区分 `PASSED` 可用卷与 `PENDING` 待检禁领卷 |
| 17 | `list_demand_templates` | `CUTTING_MCP_BUSINESS_READ=true` | 按维度/关键词筛选静态需求模板与纸样配方摘要 |
| 18 | `generate_cut_plan` | `CUTTING_MCP_BUSINESS_READ=true` | 服装颜色×尺码多床自动分床与拉布核算纯计算 |
| 19 | `compare_task_results` | `CUTTING_MCP_BUSINESS_READ=true` | 同任务双方案同口径对比：逐规格缺件明细、约束差异与双齐套占长节省 |
| 20 | `plan_task_on_material` | `COMPUTE=true` 且 `BUSINESS_READ=true` | 按任务剩余待排量在母卷/料头/自由画布上自动装配求解，默认有界轮询并附带 PNG 预览图与 `workbenchUrl` |
| 21 | `create_demand_task` | `CUTTING_MCP_ALLOW_DEMAND_WRITE=true` | 创建或 `mergeIntoTaskId` 合并 2D 矩形 / 2D 异形带孔 / 1D 分条待排需求族，绝不扣实物库存 |
| 22 | `save_draft_scheme` | `CUTTING_MCP_ALLOW_DRAFT_SCHEME=true` | 调用后端持久化接口 `POST /api/v2/workbench/drafts` 创建防篡改待审批草案与完整 `workbenchUrl`，绝不扣库存 |

---

## MCP Resources 与 Prompts 清单

### Resources（2 个）

| URI | MIME 类型 | 说明 |
| --- | --- | --- |
| `cutting://contracts/openapi` | `application/json` | 仓内 OpenAPI 权威契约与数据结构定义 |
| `cutting://guides/operations` | `text/markdown` | 工业搭切操作手册：单位（mm）、同缸防色差、方向约束（`FIXED`/`ROTATE_90`/`HALF_180`）、禁直扣库存红线与标准四步工作流 |

### Prompts（3 个）

| Prompt 名称 | 必填参数 | 适用场景 |
| --- | --- | --- |
| `import-order-to-demand` | `orderText` | 将原始客户订单/裁片清单换算为毫米制规格并调用 `create_demand_task` 入池 |
| `plan-afternoon-schedule` | 无（可选 `taskId`/`materialModel`/`shiftNote`） | 执行「查全景→选合格料→试排附预览图→保存持久化草案交付人工确认」标准四步工作流 |
| `compare-cutting-plans` | `taskId`, `leftResultId`, `rightResultId` | 同口径对比同一任务的两个排料候选方案并输出双方 PNG 预览图与深链 |

---

## 隔离烟测（严禁指向 8080）

```sh
# 必须指向独立非 8080 临时数据目录服务
CUTTING_TEST_API_URL=http://127.0.0.1:18090 node integrations/mcp/test/live-smoke.mjs
```
