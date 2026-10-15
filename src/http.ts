import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION, createApifynMcpServer } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;
const API_KEY_PATTERN = /^Bearer (apf_[A-Za-z0-9_-]+)$/;

export interface HttpServerOptions {
  apiUrl: string;
  port: number;
  host?: string;
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Stateless Streamable HTTP server. Each request carries the caller's own APIfyn key,
 * so one deployment serves every user and holds no credentials of its own.
 */
export function createHttpServer({ apiUrl }: Pick<HttpServerOptions, "apiUrl">): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health" && req.method === "GET") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJsonRpcError(res, 405, "Method not allowed: this server is stateless, use POST.");
      return;
    }

    const apiKey = API_KEY_PATTERN.exec(req.headers.authorization ?? "")?.[1];
    if (!apiKey) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="apifyn"');
      sendJsonRpcError(
        res,
        401,
        "Missing APIfyn API key. Send 'Authorization: Bearer apf_...' (create one in APIfyn → Settings → API keys).",
      );
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJsonRpcError(res, 400, error instanceof Error ? error.message : "Invalid JSON body");
      return;
    }

    const server = createApifynMcpServer({ baseUrl: apiUrl, apiKey });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("[apifyn-mcp] request failed:", error);
      if (!res.headersSent) sendJsonRpcError(res, 500, "Internal server error");
    }
  });
}

export async function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const server = createHttpServer(options);
  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "0.0.0.0", resolve));
  console.error(`[apifyn-mcp] listening on http://${options.host ?? "0.0.0.0"}:${options.port}/mcp → ${options.apiUrl}`);
  return server;
}
