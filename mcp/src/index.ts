#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createBackendClient, resolveBaseUrl } from './client.js';
import { createDeleteTokenStore } from './deleteTokens.js';
import { buildTools } from './tools.js';

// Spawned by Claude Desktop / Claude Code over stdio. stdout is the protocol
// channel — never console.log here; diagnostics go to stderr.
const server = new McpServer({ name: 'applyt', version: '1.1.0' });
const client = createBackendClient(resolveBaseUrl(process.env));

for (const tool of buildTools(client, createDeleteTokenStore())) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    tool.handler,
  );
}

await server.connect(new StdioServerTransport());
console.error(`[applyt-mcp] ready, backend ${client.baseUrl}`);
