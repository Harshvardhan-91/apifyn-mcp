import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type ApifynClient,
  ApifynApiError,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "./client.js";

const TRIGGER_SUFFIX = "-trigger";

const executionStatus = z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]);

const blockSchema = z
  .object({
    id: z.string(),
    type: z.string().describe("Block type, e.g. github-trigger, slack-send, gmail-send, filter, delay"),
    name: z.string().optional(),
    description: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .passthrough();

const definitionSchema = z.object({
  blocks: z.array(blockSchema).min(1),
  connections: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })),
});

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof ApifynApiError || error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function summarize(workflow: WorkflowSummary) {
  const blocks = workflow.definition?.blocks ?? [];
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || undefined,
    isActive: workflow.isActive,
    trigger: blocks.find((b) => b.type.endsWith(TRIGGER_SUFFIX))?.type ?? null,
    steps: blocks.map((b) => b.type),
    totalRuns: workflow.totalRuns ?? 0,
    updatedAt: workflow.updatedAt,
  };
}

function withPositions(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    blocks: definition.blocks.map((block, index) => ({
      ...block,
      position: block.position ?? { x: 100 + index * 300, y: 200 },
    })),
  };
}

export function registerTools(server: McpServer, client: ApifynClient): void {
  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description:
        "List the user's APIfyn workflows with their trigger, steps, active state and run count. Call this first to find a workflow ID.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const workflows = await client.listWorkflows();
        return json({ count: workflows.length, workflows: workflows.map(summarize) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get workflow details",
      description:
        "Get one workflow's full definition (blocks, their config and connections), success/failure counts, average run time and its 10 most recent runs.",
      inputSchema: { workflowId: z.string().describe("Workflow ID from list_workflows") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workflowId }) => {
      try {
        return json(await client.getWorkflow(workflowId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_integrations",
    {
      title: "List connected integrations",
      description:
        "Show which third-party apps (GitHub, Slack, Google, Notion) the user has connected. Workflows using an unconnected app will fail, so check this before creating one. Connecting an app has to be done by the user in the APIfyn web app.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const integrations = await client.getIntegrationStatus();
        return json(
          Object.fromEntries(
            Object.entries(integrations).map(([name, info]) => [name, { connected: info.connected }]),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_workflow",
    {
      title: "Create workflow",
      description: [
        "Create a new APIfyn workflow. Either pass `description` in plain English (APIfyn's AI builder turns it into blocks),",
        "or pass an explicit `definition` if you already know the blocks.",
        "Workflows are created paused unless `activate` is true; activating a GitHub-triggered workflow registers a webhook on that repo.",
        "Describe the trigger, the actions, and any concrete values (repo, Slack channel, email address).",
      ].join(" "),
      inputSchema: {
        description: z
          .string()
          .min(10)
          .optional()
          .describe(
            'Plain-English description, e.g. "When someone pushes to harsh/apifyn, post the commit message to #deploys on Slack"',
          ),
        definition: definitionSchema
          .optional()
          .describe("Explicit workflow definition. Use instead of description when you know the exact blocks."),
        name: z.string().max(100).optional().describe("Workflow name. Generated from the description if omitted."),
        activate: z.boolean().default(false).describe("Start the workflow immediately. Defaults to false (paused)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ description, definition, name, activate }) => {
      if (!description && !definition) {
        return failure(new Error("Provide either `description` or `definition`."));
      }
      try {
        let finalDefinition: WorkflowDefinition;
        let finalName = name;
        if (definition) {
          finalDefinition = definition as WorkflowDefinition;
        } else {
          const generated = await client.generateDefinition(description as string);
          finalDefinition = { blocks: generated.blocks, connections: generated.connections };
          finalName ??= generated.name;
        }

        const workflow = await client.createWorkflow({
          name: finalName ?? "Workflow created via MCP",
          description,
          definition: withPositions(finalDefinition),
          isActive: activate,
        });

        return json({
          message: activate
            ? "Workflow created and active."
            : "Workflow created in a paused state. Call set_workflow_active to start it.",
          workflow: summarize(workflow),
          blocks: workflow.definition.blocks.map((b) => ({ id: b.id, type: b.type, config: b.config })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "set_workflow_active",
    {
      title: "Activate or pause workflow",
      description:
        "Turn a workflow on (it reacts to its trigger) or pause it (it ignores events and can't be run).",
      inputSchema: {
        workflowId: z.string(),
        active: z.boolean().describe("true to activate, false to pause"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workflowId, active }) => {
      try {
        await client.setWorkflowActive(workflowId, active);
        return json({ workflowId, isActive: active });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run workflow now",
      description: [
        "Queue a run of an active workflow right now, as if its trigger had fired.",
        "`payload` becomes the trigger data that {{template}} variables read from, e.g. {\"customer\": {\"email\": \"a@b.com\"}}.",
        "Runs are asynchronous: this returns an executionId; call get_execution to see the result.",
        "This performs the workflow's real actions (sends messages, emails, etc.).",
      ].join(" "),
      inputSchema: {
        workflowId: z.string(),
        payload: z.record(z.unknown()).default({}).describe("Trigger data for this run"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflowId, payload }) => {
      try {
        const result = await client.runWorkflow(workflowId, payload);
        return json({
          ...result,
          next: `Call get_execution with workflowId "${workflowId}" and executionId "${result.executionId}" to check the result.`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_executions",
    {
      title: "List workflow runs",
      description:
        "List recent runs of a workflow, newest first, with status, duration and error message. Filter by status to find failures.",
      inputSchema: {
        workflowId: z.string(),
        status: executionStatus.optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional().describe("nextCursor from a previous call, to get older runs"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workflowId, status, limit, cursor }) => {
      try {
        return json(await client.listExecutions(workflowId, { status, limit, cursor }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_execution",
    {
      title: "Get run result",
      description:
        "Get one run's status, input (trigger payload), output and error message. Use it to check a run started with run_workflow or to debug a failure.",
      inputSchema: { workflowId: z.string(), executionId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workflowId, executionId }) => {
      try {
        return json(await client.getExecution(workflowId, executionId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete workflow",
      description:
        "Permanently delete a workflow and its run history. This can't be undone; confirm with the user first.",
      inputSchema: { workflowId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workflowId }) => {
      try {
        await client.deleteWorkflow(workflowId);
        return json({ workflowId, deleted: true });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
