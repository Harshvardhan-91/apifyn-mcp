export type ExecutionStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface WorkflowBlock {
  id: string;
  type: string;
  name?: string;
  description?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  blocks: WorkflowBlock[];
  connections: Array<{ id: string; from: string; to: string }>;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  category: string | null;
  triggerType: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  totalRuns?: number;
}

export interface ExecutionSummary {
  id: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string | null;
  duration?: number | null;
  errorMessage: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  avgExecutionTime: number | null;
  executions: ExecutionSummary[];
}

export interface ExecutionDetail extends ExecutionSummary {
  inputData: unknown;
  outputData: unknown;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
  isActive: boolean;
}

export class ApifynApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApifynApiError";
  }
}

type FetchFn = typeof fetch;

export interface ApifynClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchFn;
}

/** Thin typed wrapper over the APIfyn REST API, authenticated with a personal `apf_` key. */
export class ApifynClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(options: ApifynClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
  }

  async listWorkflows(): Promise<WorkflowSummary[]> {
    const res = await this.request<{ workflows: WorkflowSummary[] }>("GET", "/api/workflow");
    return res.workflows;
  }

  async getWorkflow(id: string): Promise<WorkflowDetail> {
    const res = await this.request<{ workflow: WorkflowDetail }>(
      "GET",
      `/api/workflow/${encodeURIComponent(id)}`,
    );
    return res.workflow;
  }

  async generateDefinition(
    prompt: string,
  ): Promise<WorkflowDefinition & { name: string }> {
    const res = await this.request<{
      definition: WorkflowDefinition & { name: string };
    }>("POST", "/api/ai/generate", { prompt });
    return res.definition;
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowSummary> {
    const res = await this.request<{ workflow: WorkflowSummary }>("POST", "/api/workflow", {
      name: input.name,
      description: input.description ?? "",
      definition: input.definition,
      triggerType: "WEBHOOK",
      isActive: input.isActive,
    });
    return res.workflow;
  }

  async setWorkflowActive(id: string, isActive: boolean): Promise<void> {
    await this.request("PATCH", `/api/workflow/${encodeURIComponent(id)}/status`, {
      isActive,
    });
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.request("DELETE", `/api/workflow/${encodeURIComponent(id)}`);
  }

  async runWorkflow(
    id: string,
    payload: Record<string, unknown>,
  ): Promise<{ executionId: string; status: ExecutionStatus }> {
    return this.request("POST", `/api/workflow/${encodeURIComponent(id)}/run`, {
      payload,
    });
  }

  async listExecutions(
    workflowId: string,
    options: { status?: ExecutionStatus; limit?: number; cursor?: string } = {},
  ): Promise<{
    executions: ExecutionSummary[];
    pagination: { nextCursor: string | null; hasMore: boolean };
  }> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size > 0 ? `?${params}` : "";
    return this.request(
      "GET",
      `/api/workflow/${encodeURIComponent(workflowId)}/executions${query}`,
    );
  }

  async getExecution(workflowId: string, executionId: string): Promise<ExecutionDetail> {
    const res = await this.request<{ execution: ExecutionDetail }>(
      "GET",
      `/api/workflow/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`,
    );
    return res.execution;
  }

  async getIntegrationStatus(): Promise<Record<string, { connected: boolean }>> {
    const res = await this.request<{
      integrations: Record<string, { connected: boolean }>;
    }>("GET", "/api/integrations/status");
    return res.integrations;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApifynApiError(0, `Could not reach the APIfyn API at ${this.baseUrl} (${reason}).`);
    }

    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (!res.ok || data?.success === false) {
      throw new ApifynApiError(res.status, describeError(res.status, data), data?.code);
    }

    return data as T;
  }
}

function describeError(status: number, data: any): string {
  const serverMessage: string | undefined = data?.error ?? data?.message;
  if (status === 401) {
    return "APIfyn rejected the API key. Create a new one in APIfyn → Settings → API keys and update your MCP config.";
  }
  if (status === 429) {
    return serverMessage ?? "APIfyn rate limit reached. Wait a minute and try again.";
  }
  return serverMessage ?? `APIfyn API request failed with status ${status}.`;
}
