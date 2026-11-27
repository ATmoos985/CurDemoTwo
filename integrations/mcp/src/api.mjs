import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EXTRA_CONTENT_SYMBOL = Symbol('mcpExtraContent');

export class ToolFailure extends Error {
  constructor(code, message, retryable = false, status = null) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * 为工具结果附加额外 MCP content 块（例如 image/png），同时保留 structuredContent.data 的纯结构化语义。
 */
export function withExtraContent(data, extraContent = []) {
  return {
    [EXTRA_CONTENT_SYMBOL]: true,
    data,
    extraContent: Array.isArray(extraContent) ? extraContent : []
  };
}

export function unwrapToolOutput(raw) {
  if (raw && typeof raw === 'object' && raw[EXTRA_CONTENT_SYMBOL] === true) {
    return { data: raw.data, extraContent: raw.extraContent };
  }
  return { data: raw, extraContent: [] };
}

export function configuration(env = process.env) {
  const url = new URL(env.CUTTING_API_URL || 'http://127.0.0.1:8080');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'CUTTING_API_URL must be a literal loopback origin. Remote multi-user access requires the later authenticated adapter.'
    );
  }

  for (const flag of [
    'CUTTING_MCP_COMPUTE',
    'CUTTING_MCP_BUSINESS_READ',
    'CUTTING_MCP_ALLOW_DRAFT_SCHEME',
    'CUTTING_MCP_ALLOW_DEMAND_WRITE'
  ]) {
    if (env[flag] && !['true', 'false'].includes(env[flag])) {
      throw new Error(`${flag} must be true or false`);
    }
  }

  const transport = (env.MCP_TRANSPORT || 'stdio').trim().toLowerCase();
  if (!['stdio', 'http'].includes(transport)) {
    throw new Error('MCP_TRANSPORT must be stdio or http');
  }

  const httpHost = (env.MCP_HTTP_HOST || '127.0.0.1').trim();
  const rawPort = env.MCP_HTTP_PORT === undefined || env.MCP_HTTP_PORT === '' ? 3080 : Number(env.MCP_HTTP_PORT);
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new Error('MCP_HTTP_PORT must be an integer between 0 and 65535');
  }

  const httpToken = String(env.MCP_API_TOKEN || '').trim();
  if (transport === 'http' && httpToken.length < 16) {
    throw new Error('MCP_TRANSPORT=http 必须配置至少 16 位字符的 MCP_API_TOKEN，禁止无鉴权暴露远程端点');
  }

  const agentToken = String(env.CUTTING_AGENT_TOKEN || '').trim();
  const apiToken = agentToken || String(env.CUTTING_API_TOKEN || '').trim();
  const auditLogPath = String(env.MCP_AUDIT_LOG_PATH || '').trim();

  return {
    origin: url.origin,
    compute: env.CUTTING_MCP_COMPUTE === 'true',
    businessRead: env.CUTTING_MCP_BUSINESS_READ === 'true',
    allowDraftScheme: env.CUTTING_MCP_ALLOW_DRAFT_SCHEME === 'true',
    allowDemandWrite: env.CUTTING_MCP_ALLOW_DEMAND_WRITE === 'true',
    apiToken,
    hasAgentToken: Boolean(agentToken),
    transport,
    httpHost,
    httpPort: rawPort,
    httpToken,
    auditLogPath
  };
}

export function apiClient(
  config,
  { fetchImpl = fetch, timeoutMs = 20000, maxResponseBytes = 4194304, authToken } = {}
) {
  const bearerToken = (authToken ?? config.apiToken ?? '').trim();
  return async (path, body, key, requestOptions = {}) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 262144) {
      throw new ToolFailure('PAYLOAD_TOO_LARGE', 'Input exceeds the API limit of 262144 bytes.');
    }
    const method = requestOptions?.method
      ? String(requestOptions.method).trim().toUpperCase()
      : encoded === undefined
      ? 'GET'
      : 'POST';
    const effectiveTimeoutMs =
      Number.isFinite(requestOptions?.timeoutMs) && requestOptions.timeoutMs > 0
        ? requestOptions.timeoutMs
        : timeoutMs;
    try {
      const headers = {
        Accept: 'application/json',
        ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        ...(requestOptions?.headers && typeof requestOptions.headers === 'object' ? requestOptions.headers : {})
      };
      const response = await fetchImpl(config.origin + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(effectiveTimeoutMs),
        headers,
        body: encoded
      });
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxResponseBytes) {
            throw new ToolFailure(
              'RESPONSE_TOO_LARGE',
              'Response exceeds the adapter limit; use a narrower query.'
            );
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new ToolFailure('INVALID_RESPONSE', 'The service did not return JSON.', false, response.status);
      }
      if (!response.ok) {
        throw new ToolFailure(
          typeof data.code === 'string' ? data.code : 'HTTP_' + response.status,
          typeof data.message === 'string'
            ? data.message.slice(0, 1000)
            : 'Service rejected the request.',
          data.retryable === true,
          response.status
        );
      }
      return data;
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure(
        'SERVICE_UNAVAILABLE',
        'Service connection failed. A submitted job may already exist: retry with the SAME idempotency key and identical request.',
        true
      );
    }
  };
}

/**
 * 脱敏审计事件白名单裁剪：仅保留摘要元数据，绝不落盘原始业务明细、几何顶点或访问凭据。
 */
export function sanitizeAuditEvent(event) {
  const safe = {
    timestamp: event.timestamp || new Date().toISOString(),
    traceId: String(event.traceId || ''),
    tool: String(event.tool || ''),
    inputHash: String(event.inputHash || ''),
    status: String(event.status || 'UNKNOWN'),
    elapsedMs: Number.isFinite(event.elapsedMs) ? Math.max(0, Math.round(event.elapsedMs)) : 0,
    resultId: event.resultId ? String(event.resultId).slice(0, 128) : null
  };
  if (event.code) safe.code = String(event.code).slice(0, 64);
  if (event.transport) safe.transport = String(event.transport).slice(0, 32);
  return safe;
}

/**
 * 创建脱敏审计日志写入器：默认输出到 stderr；配置 auditLogPath 后同时追加持久化 JSONL。
 */
export function createAuditLogger({
  auditLogPath = '',
  transport = 'stdio',
  stderrWrite = (line) => process.stderr.write(line)
} = {}) {
  let dirReady = false;
  return (event) => {
    const safe = sanitizeAuditEvent({ ...event, transport });
    const line = JSON.stringify(safe) + '\n';
    stderrWrite(line);
    if (auditLogPath) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(auditLogPath), { recursive: true });
          dirReady = true;
        }
        appendFileSync(auditLogPath, line, 'utf8');
      } catch {
        // 文件审计异常不得反向中断只读/计算主链路，已在 stderr 留存
      }
    }
  };
}

export function audited(
  tool,
  handler,
  audit = (event) => process.stderr.write(JSON.stringify(sanitizeAuditEvent(event)) + '\n')
) {
  return async (args) => {
    const started = Date.now();
    const traceId = randomUUID();
    const inputHash = createHash('sha256')
      .update(JSON.stringify(args ?? {}))
      .digest('hex');
    try {
      const raw = await handler(args);
      const { data, extraContent } = unwrapToolOutput(raw);
      audit({
        traceId,
        tool,
        inputHash,
        status: 'SUCCEEDED',
        elapsedMs: Date.now() - started,
        resultId: data?.id || data?.draftId || data?.resultId || data?.batchGroupId || data?.job?.id || null
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }, ...extraContent],
        structuredContent: { data }
      };
    } catch (error) {
      const failure =
        error instanceof ToolFailure
          ? error
          : new ToolFailure('ADAPTER_ERROR', 'Adapter failed; check the local trace log.');
      audit({
        traceId,
        tool,
        inputHash,
        status: 'FAILED',
        code: failure.code,
        elapsedMs: Date.now() - started
      });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable,
              traceId
            })
          }
        ]
      };
    }
  };
}
