import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {configuration} from './api.mjs';
import {createServer} from './server.mjs';

try{
    const server=createServer(configuration());
    await server.connect(new StdioServerTransport());
    process.once('SIGTERM',()=>server.close());
    process.once('SIGINT',()=>server.close());
}catch(error){process.stderr.write('Cutting MCP startup failed: '+error.message+'\n');process.exitCode=1;}
