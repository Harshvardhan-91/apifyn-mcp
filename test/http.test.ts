import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.js";
import { parseText, sampleWorkflow } from "./helpers.js";

const seenAuthHeaders: string[] = [];
let fakeApi: Server;
let mcpServer: Server;
let mcpUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  fakeApi = createServer((req, res) => {
    seenAuthHeaders.push(req.headers.authorization ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, workflows: [sampleWorkflow] }));
  });
  const apiUrl = await listen(fakeApi);

  mcpServer = createHttpServer({ apiUrl });
  mcpUrl = `${await listen(mcpServer)}/mcp`;
});

afterAll(async () => {
  await new Promise((r) => mcpServer.close(r));
  await new Promise((r) => fakeApi.close(r));
});

async function connectAs(apiKey: string) {
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }),
  );
  return client;
}

describe("hosted HTTP mode", () => {
  it("serves health checks", async () => {
    const res = await fetch(mcpUrl.replace("/mcp", "/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", name: "apifyn" });
  });

  it("rejects requests without an APIfyn key", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("forwards each caller's own key to the APIfyn API", async () => {
    const alice = await connectAs("apf_alice");
    const bob = await connectAs("apf_bob");

    const result = await alice.callTool({ name: "list_workflows", arguments: {} });
    await bob.callTool({ name: "list_workflows", arguments: {} });

    expect(parseText(result).workflows[0].id).toBe("wf-1");
    expect(seenAuthHeaders).toEqual(["Bearer apf_alice", "Bearer apf_bob"]);

    await alice.close();
    await bob.close();
  });

  it("returns 405 for GET because the server is stateless", async () => {
    const res = await fetch(mcpUrl, { headers: { Authorization: "Bearer apf_alice" } });
    expect(res.status).toBe(405);
  });
});
