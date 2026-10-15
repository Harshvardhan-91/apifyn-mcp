import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApifynMcpServer } from "../src/server.js";
import { type Route, fakeApifynApi, parseText, sampleWorkflow } from "./helpers.js";

const API_KEY = "apf_test_key";
let client: Client | undefined;

async function connect(routes: Record<string, Route>) {
  const api = fakeApifynApi(routes);
  const server = createApifynMcpServer({ baseUrl: "https://api.test", apiKey: API_KEY, fetch: api.fetch });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, api };
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("tool catalog", () => {
  it("exposes the APIfyn tools with safety annotations", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual([
      "create_workflow",
      "delete_workflow",
      "get_execution",
      "get_workflow",
      "list_executions",
      "list_integrations",
      "list_workflows",
      "run_workflow",
      "set_workflow_active",
    ]);
    expect(byName.list_workflows?.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_workflow?.annotations?.destructiveHint).toBe(true);
    expect(byName.run_workflow?.annotations?.readOnlyHint).toBe(false);
  });

  it("sends server instructions to the client", async () => {
    const { client } = await connect({});
    expect(client.getInstructions()).toContain("APIfyn is a workflow automation platform");
  });
});

describe("list_workflows", () => {
  it("returns compact summaries and authenticates with the API key", async () => {
    const { client, api } = await connect({
      "GET /api/workflow": () => ({ body: { success: true, workflows: [sampleWorkflow] } }),
    });

    const result = await client.callTool({ name: "list_workflows", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toEqual({
      count: 1,
      workflows: [
        {
          id: "wf-1",
          name: "GitHub push to Slack",
          description: "Notify #deploys",
          isActive: true,
          trigger: "github-trigger",
          steps: ["github-trigger", "slack-send"],
          totalRuns: 4,
          updatedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
    });
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("explains a rejected API key instead of throwing", async () => {
    const { client } = await connect({
      "GET /api/workflow": () => ({ status: 401, body: { error: "Invalid API key" } }),
    });

    const result = await client.callTool({ name: "list_workflows", arguments: {} });

    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("Settings → API keys");
  });
});

describe("create_workflow", () => {
  it("generates blocks from a description and creates the workflow paused by default", async () => {
    const generated = {
      name: "Push to Slack",
      blocks: [
        { id: "block-1", type: "github-trigger", config: { repository: "harsh/apifyn" } },
        { id: "block-2", type: "slack-send", config: { channel: "#deploys" } },
      ],
      connections: [{ id: "conn-1", from: "block-1", to: "block-2" }],
    };
    const { client, api } = await connect({
      "POST /api/ai/generate": () => ({ body: { success: true, definition: generated } }),
      "POST /api/workflow": (req) => ({
        body: { success: true, workflow: { ...sampleWorkflow, ...req.body, id: "wf-new" } },
      }),
    });

    const result = await client.callTool({
      name: "create_workflow",
      arguments: { description: "When someone pushes to harsh/apifyn, post to #deploys on Slack" },
    });

    expect(result.isError).toBeFalsy();
    const [generate, create] = api.requests;
    expect(generate?.body).toEqual({ prompt: "When someone pushes to harsh/apifyn, post to #deploys on Slack" });
    expect(create?.body).toMatchObject({ name: "Push to Slack", isActive: false, triggerType: "WEBHOOK" });
    expect(create?.body.definition.blocks[1].position).toEqual({ x: 400, y: 200 });
    expect(parseText(result).message).toContain("paused");
  });

  it("uses an explicit definition without calling the AI builder", async () => {
    const { client, api } = await connect({
      "POST /api/workflow": (req) => ({
        body: { success: true, workflow: { ...sampleWorkflow, ...req.body, id: "wf-new" } },
      }),
    });

    await client.callTool({
      name: "create_workflow",
      arguments: {
        name: "Inbound to Discord",
        activate: true,
        definition: {
          blocks: [
            { id: "b1", type: "webhook-trigger", config: {} },
            { id: "b2", type: "discord-send", config: { message: "{{payload.text}}" } },
          ],
          connections: [{ id: "c1", from: "b1", to: "b2" }],
        },
      },
    });

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.path).toBe("/api/workflow");
    expect(api.requests[0]?.body).toMatchObject({ name: "Inbound to Discord", isActive: true });
  });

  it("asks for a description or definition when given neither", async () => {
    const { client, api } = await connect({});

    const result = await client.callTool({ name: "create_workflow", arguments: {} });

    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("surfaces the plan limit message from the API", async () => {
    const { client } = await connect({
      "POST /api/ai/generate": () => ({
        body: { success: true, definition: { name: "x", blocks: [{ id: "b", type: "webhook-trigger" }], connections: [] } },
      }),
      "POST /api/workflow": () => ({
        status: 403,
        body: { success: false, error: "You've reached the 3 workflow limit on the Starter plan.", code: "WORKFLOW_LIMIT_REACHED" },
      }),
    });

    const result = await client.callTool({
      name: "create_workflow",
      arguments: { description: "Forward inbound webhooks to Discord" },
    });

    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("workflow limit");
  });
});

describe("run_workflow and get_execution", () => {
  it("queues a run with the payload and points to get_execution", async () => {
    const { client, api } = await connect({
      "POST /api/workflow/wf-1/run": () => ({
        status: 202,
        body: { success: true, executionId: "exec-1", status: "PENDING" },
      }),
    });

    const result = await client.callTool({
      name: "run_workflow",
      arguments: { workflowId: "wf-1", payload: { customer: { email: "a@b.com" } } },
    });

    expect(api.requests[0]?.body).toEqual({ payload: { customer: { email: "a@b.com" } } });
    expect(parseText(result)).toMatchObject({ executionId: "exec-1", status: "PENDING" });
    expect(parseText(result).next).toContain("get_execution");
  });

  it("reports a paused workflow as a tool error", async () => {
    const { client } = await connect({
      "POST /api/workflow/wf-1/run": () => ({
        status: 409,
        body: { success: false, error: "Workflow is paused. Activate it before running.", code: "WORKFLOW_INACTIVE" },
      }),
    });

    const result = await client.callTool({ name: "run_workflow", arguments: { workflowId: "wf-1" } });

    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("paused");
  });

  it("fetches a single execution", async () => {
    const execution = {
      id: "exec-1",
      status: "FAILED",
      startedAt: "2026-10-09T10:00:00.000Z",
      completedAt: "2026-10-09T10:00:02.000Z",
      duration: 2000,
      errorMessage: "channel_not_found",
      inputData: {},
      outputData: null,
    };
    const { client, api } = await connect({
      "GET /api/workflow/wf-1/executions/exec-1": () => ({ body: { success: true, execution } }),
    });

    const result = await client.callTool({
      name: "get_execution",
      arguments: { workflowId: "wf-1", executionId: "exec-1" },
    });

    expect(api.requests[0]?.path).toBe("/api/workflow/wf-1/executions/exec-1");
    expect(parseText(result)).toEqual(execution);
  });
});

describe("list_executions", () => {
  it("passes status, limit and cursor as query parameters", async () => {
    const { client, api } = await connect({
      "GET /api/workflow/wf-1/executions": () => ({
        body: { success: true, executions: [], pagination: { nextCursor: null, hasMore: false, limit: 5 } },
      }),
    });

    await client.callTool({
      name: "list_executions",
      arguments: { workflowId: "wf-1", status: "FAILED", limit: 5, cursor: "exec-9" },
    });

    expect(api.requests[0]?.path).toBe("/api/workflow/wf-1/executions?status=FAILED&limit=5&cursor=exec-9");
  });

  it("rejects an unknown status before calling the API", async () => {
    const { client, api } = await connect({});

    const result = await client.callTool({
      name: "list_executions",
      arguments: { workflowId: "wf-1", status: "BROKEN" },
    });

    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });
});

describe("other tools", () => {
  it("set_workflow_active toggles through the status endpoint", async () => {
    const { client, api } = await connect({
      "PATCH /api/workflow/wf-1/status": () => ({ body: { success: true } }),
    });

    await client.callTool({ name: "set_workflow_active", arguments: { workflowId: "wf-1", active: false } });

    expect(api.requests[0]).toMatchObject({ method: "PATCH", body: { isActive: false } });
  });

  it("list_integrations reduces the status payload to connected flags", async () => {
    const { client } = await connect({
      "GET /api/integrations/status": () => ({
        body: {
          success: true,
          integrations: {
            github: { connected: true, user: { login: "harsh", token: "secret" }, loading: false },
            slack: { connected: false, workspaces: [], loading: false },
          },
        },
      }),
    });

    const result = await client.callTool({ name: "list_integrations", arguments: {} });

    expect(parseText(result)).toEqual({ github: { connected: true }, slack: { connected: false } });
  });

  it("delete_workflow calls DELETE", async () => {
    const { client, api } = await connect({
      "DELETE /api/workflow/wf-1": () => ({ body: { success: true } }),
    });

    const result = await client.callTool({ name: "delete_workflow", arguments: { workflowId: "wf-1" } });

    expect(api.requests[0]?.method).toBe("DELETE");
    expect(parseText(result)).toEqual({ workflowId: "wf-1", deleted: true });
  });
});
