import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createGasClient } from './gas-client.js';
import { createServer } from './server.js';
import { createHttpApp } from './http.js';

try {
  const config = readConfig();
  const callGas = createGasClient(config);
  if (config.transport === 'stdio') {
    await createServer(callGas, config).connect(new StdioServerTransport());
    console.error('Trade monitor MCP ready (stdio).');
  } else {
    const listener = createHttpApp(config, callGas).listen(config.port, config.host, () => {
      console.error(`Trade monitor MCP ready (HTTP, port ${config.port}).`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => listener.close(() => process.exit(0)));
  }
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
}
