import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { apiClient, createAuditLogger } from './api.mjs';
import { createServer as createMcpServer } from './server.mjs';

const MAX_BODY_BYTES = 524_288; // 512 KiB
const REQUEST_TIMEOUT_MS = 65_000;

function constantTimeTokenMatch(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = createHash('sha256').update(String(expected)).digest();
  const b = createHash('sha256').update(String(supplied)).digest();
  return timingSafeEqual(a, b);
}

function extractBearer(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length > 8192) return '';
  if (!headerValue.toLowerCase().startsWith('bearer ')) return '';
  return headerValue.slice(7).trim();
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('请求体超过 512 KiB 上限');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        const err = new Error('请求正文不能为空');
        err.status = 400;
        err.code = 'INVALID_JSON';
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('请求正文不是合法的 JSON');
        err.status = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });
    req.on('error', (error) => reject(error));
  });
}

/**
 * 内部单会话桥接：将标准 JSON-RPC 消息通过官方 InMemoryTransport 送入 McpServer 并关联返回同 id 响应。
 */
async function createBridgeSession(config, { apiFactory, audit }) {
  const sessionId = randomUUID();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let initialized = false;

  clientTransport.onmessage = (message) => {
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  };

  clientTransport.onerror = (error) => {
    for (const [key, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      pending.delete(key);
    }
  };

  const mcpServer = createMcpServer(config, {
    api: apiFactory(),
    audit,
    transport: 'streamable-http'
  });

  await mcpServer.connect(serverTransport);
  await clientTransport.start();

  async function sendRpc(message) {
    const isNotification =
      !Object.prototype.hasOwnProperty.call(message, 'id') || message.id === undefined;

    // 若调用方跳过 initialize 直接发业务 JSON-RPC，自动完成一次内部协议握手，便于简易 HTTP 客户端联调
    if (!initialized && message.method !== 'initialize' && message.method !== 'notifications/initialized') {
      await sendRpc({
        jsonrpc: '2.0',
        id: '__auto_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'streamable-http-bridge', version: '0.2.0' }
        }
      });
      await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      initialized = true;
    }

    if (isNotification) {
      if (message.method === 'notifications/initialized') initialized = true;
      await clientTransport.send(message);
      return null;
    }

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new Error('MCP 会话处理超时'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(message.id, { resolve, reject, timer });
    });

    await clientTransport.send(message);
    const response = await responsePromise;
    if (message.method === 'initialize' && !response?.error) {
      initialized = true;
    }
    return response;
  }

  async function close() {
    for (const [key, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('MCP HTTP 服务已关闭'));
      pending.delete(key);
    }
    await clientTransport.close().catch(() => {});
    await mcpServer.close().catch(() => {});
  }

  return { sessionId, sendRpc, close };
}

/**
 * 构建零新增重型依赖的 Streamable HTTP MCP 服务端：
 * - 强制要求 MCP_API_TOKEN（>=16 字符），未配置直接拒绝启动防裸奔；
 * - 强制校验 Authorization: Bearer <MCP_API_TOKEN>；
 * - 支持透传 CUTTING_API_TOKEN（或请求头 X-Cutting-Api-Token）给后端受保护 REST；
 * - 支持配置 MCP_AUDIT_LOG_PATH 追加脱敏 JSONL 审计日志。
 */
export function createMcpHttpServer(config, options = {}) {
  const expectedToken = String(options.apiToken ?? config.httpToken ?? '').trim();
  if (expectedToken.length < 16) {
    throw new Error('启动 Streamable HTTP MCP 服务必须提供至少 16 位字符的 MCP_API_TOKEN，拒绝无鉴权启动');
  }

  const endpointPath = options.path || '/mcp';
  const audit =
    options.audit ||
    createAuditLogger({
      auditLogPath: config.auditLogPath || '',
      transport: 'streamable-http'
    });

  // 按后端透传 token 分桶复用桥接会话，避免跨调用方串用后端凭据
  const sessions = new Map();

  async function resolveSession(sessionKey, backendToken) {
    if (sessions.has(sessionKey)) return sessions.get(sessionKey);
    const apiFactory = () =>
      options.api
        ? options.api
        : apiClient(config, {
            fetchImpl: options.fetchImpl,
            authToken: backendToken || config.apiToken || ''
          });
    const session = await createBridgeSession(config, { apiFactory, audit });
    sessions.set(sessionKey, session);
    return session;
  }

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'UP', transport: 'streamable-http', endpoint: endpointPath });
    }

    if (url.pathname !== endpointPath) {
      return sendJson(res, 404, { code: 'NOT_FOUND', message: '未知的 MCP 端点路径' });
    }

    // 强制 Bearer 鉴权校验
    const suppliedToken = extractBearer(req.headers.authorization);
    if (!constantTimeTokenMatch(expectedToken, suppliedToken)) {
      return sendJson(
        res,
        401,
        { code: 'UNAUTHORIZED', message: '缺少或无效的 MCP Bearer 访问令牌' },
        { 'WWW-Authenticate': 'Bearer realm="cutting-mcp"' }
      );
    }

    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] || '').trim();
      if (sid) {
        for (const [key, sess] of sessions.entries()) {
          if (sess.sessionId === sid) {
            sessions.delete(key);
            await sess.close();
            break;
          }
        }
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST / DELETE 请求' }, { Allow: 'POST, DELETE' });
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return sendJson(res, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type 必须为 application/json' });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err.message }
      });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.jsonrpc !== '2.0') {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: '仅支持单个标准 JSON-RPC 2.0 对象请求' }
      });
    }

    const headerBackendToken = String(req.headers['x-cutting-api-token'] || '').trim();
    const backendToken = headerBackendToken || config.apiToken || '';
    const requestedSid = String(req.headers['mcp-session-id'] || '').trim();
    const tokenKey = createHash('sha256').update(backendToken).digest('hex').slice(0, 12);
    const sessionKey = requestedSid ? `${requestedSid}:${tokenKey}` : `default:${tokenKey}`;

    try {
      const session = await resolveSession(sessionKey, backendToken);
      const response = await session.sendRpc(payload);
      if (response === null) {
        res.writeHead(202, { 'Mcp-Session-Id': session.sessionId });
        res.end();
        return;
      }

      const accept = String(req.headers.accept || '').toLowerCase();
      if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Mcp-Session-Id': session.sessionId
        });
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }

      return sendJson(res, 200, response, { 'Mcp-Session-Id': session.sessionId });
    } catch (err) {
      return sendJson(res, 500, {
        jsonrpc: '2.0',
        id: payload.id ?? null,
        error: { code: -32603, message: 'MCP 适配器处理异常' }
      });
    }
  });

  async function close() {
    for (const sess of sessions.values()) {
      await sess.close();
    }
    sessions.clear();
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  }

  return { httpServer, close };
}

export async function startMcpHttpServer(config, options = {}) {
  const { httpServer, close } = createMcpHttpServer(config, options);
  const host = options.host ?? config.httpHost ?? '127.0.0.1';
  const port = options.port ?? config.httpPort ?? 3080;
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
  return {
    httpServer,
    origin,
    endpointUrl: `${origin}${options.path || '/mcp'}`,
    port: actualPort,
    close
  };
}
