#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.js";
import { createApifynMcpServer } from "./server.js";

const DEFAULT_API_URL = "http://localhost:5000";
const DEFAULT_PORT = 3333;

// stdout carries the MCP protocol in stdio mode, so all logging goes to stderr.
async function main(): Promise<void> {
  const apiUrl = process.env.APIFYN_API_URL ?? DEFAULT_API_URL;

  if (process.argv.includes("--http")) {
    const port = Number(process.env.PORT ?? DEFAULT_PORT);
    await startHttpServer({ apiUrl, port });
    return;
  }

  const apiKey = process.env.APIFYN_API_KEY;
  if (!apiKey?.startsWith("apf_")) {
    console.error(
      "[apifyn-mcp] APIFYN_API_KEY is missing or invalid. Create a key in APIfyn → Settings → API keys and set it in your MCP client config.",
    );
    process.exit(1);
  }

  const server = createApifynMcpServer({ baseUrl: apiUrl, apiKey });
  await server.connect(new StdioServerTransport());
  console.error(`[apifyn-mcp] connected over stdio → ${apiUrl}`);
}

main().catch((error) => {
  console.error("[apifyn-mcp] fatal:", error);
  process.exit(1);
});
