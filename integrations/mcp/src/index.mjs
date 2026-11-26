import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { configuration } from './api.mjs';
import { createServer } from './server.mjs';
import { startMcpHttpServer } from './http-server.mjs';

try {
  const config = configuration();
  if (config.transport === 'http') {
    const running = await startMcpHttpServer(config);
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'MCP_HTTP_STARTED',
        endpointUrl: running.endpointUrl,
        compute: config.compute,
        businessRead: config.businessRead,
        allowDraftScheme: config.allowDraftScheme
      }) + '\n'
    );
    process.once('SIGTERM', () => running.close());
    process.once('SIGINT', () => running.close());
  } else {
    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    process.once('SIGTERM', () => server.close());
    process.once('SIGINT', () => server.close());
  }
} catch (error) {
  process.stderr.write('Cutting MCP startup failed: ' + error.message + '\n');
  process.exitCode = 1;
}
