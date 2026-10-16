#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { Catalog, CatalogError, TOOLS, VERSION } from "./catalog.js";
const catalog = new Catalog();
let windowStart = Date.now(), calls = 0;
function allowed() { const now = Date.now(); if (now - windowStart >= 60_000) { windowStart = now; calls = 0; } return ++calls <= 60; }
function server() {
  const s = new Server({ name: "drop-beacon-mcp", version: VERSION }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async req => {
    if (!allowed()) return { isError: true, content: [{ type: "text", text: "Rate limit reached. Wait 60 seconds before retrying." }] };
    try { return { content: [{ type: "text", text: JSON.stringify(await catalog.call(req.params.name, req.params.arguments ?? {})) }] }; }
    catch (err) { return { isError: true, content: [{ type: "text", text: err instanceof CatalogError ? err.message : "Catalog request failed. Try again later." }] }; }
  });
  return s;
}
// Never reads DATABASE_URL or API_KEY. No database driver is installed.
const port = process.env.PORT;
if (!port) { await server().connect(new StdioServerTransport()); }
else {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) throw new Error("Invalid PORT");
  const app = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== "https://edc4me.com") { res.writeHead(403).end("Origin not allowed"); return; }
    if (req.url === "/health" && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", version: VERSION, dataSource: "public-api" })); return; }
    if (req.url !== "/mcp") { res.writeHead(404).end("Not found"); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end("Use POST /mcp"); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { res.writeHead(415).end("JSON required"); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65_536) { res.writeHead(413).end("Request too large"); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (Array.isArray(body)) { res.writeHead(400).end("Batch requests are not supported"); return; }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const s = server();
      res.on("close", () => { void transport.close(); void s.close(); });
      await s.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(400).end("Invalid request"); }
  });
  app.requestTimeout = 20_000; app.headersTimeout = 15_000;
  app.listen(parsedPort, process.env.HOST ?? "127.0.0.1");
}
