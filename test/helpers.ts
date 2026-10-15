export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export type Route = (req: RecordedRequest) => { status?: number; body: unknown };

/** In-memory stand-in for the APIfyn REST API, keyed by "METHOD /path". */
export function fakeApifynApi(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      return new Response(JSON.stringify({ success: false, error: "Route not found" }), { status: 404 });
    }
    const { status = 200, body } = route(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { fetch: fetchFn, requests };
}

export const sampleWorkflow = {
  id: "wf-1",
  name: "GitHub push to Slack",
  description: "Notify #deploys",
  definition: {
    blocks: [
      { id: "block-1", type: "github-trigger", config: { repository: "harsh/apifyn", eventType: "push" } },
      { id: "block-2", type: "slack-send", config: { channel: "#deploys", message: "{{commit.message}}" } },
    ],
    connections: [{ id: "conn-1", from: "block-1", to: "block-2" }],
  },
  category: "general",
  triggerType: "WEBHOOK",
  isActive: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  totalRuns: 4,
};

export function parseText(result: any): any {
  const text = result.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
