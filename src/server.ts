import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApifynClient, type ApifynClientOptions } from "./client.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "apifyn";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `APIfyn is a workflow automation platform: a trigger (GitHub push, Stripe payment, Typeform submission, inbound webhook...) runs a chain of actions (Slack, Gmail, Google Sheets, Notion, Discord, WhatsApp, OpenAI, HTTP).
Typical flow: list_integrations to see what's connected → create_workflow → set_workflow_active → run_workflow → get_execution.
Running a workflow performs real actions, and delete_workflow is permanent, so confirm with the user before either.`;

export function createApifynMcpServer(options: ApifynClientOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, new ApifynClient(options));
  return server;
}
