#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { neon } from "@neondatabase/serverless";
// ──────────────────────────────────────
// Database connection
// ──────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("Error: DATABASE_URL environment variable is required.");
    process.exit(1);
}
const sql = neon(DATABASE_URL);
// ──────────────────────────────────────
// Infrastructure: Rate limiter
// ──────────────────────────────────────
const RATE_LIMIT = 60;
const callTimestamps = [];
function checkRateLimit() {
    const now = Date.now();
    const windowStart = now - 60_000;
    while (callTimestamps.length > 0 && callTimestamps[0] < windowStart) {
        callTimestamps.shift();
    }
    if (callTimestamps.length >= RATE_LIMIT) {
        return { allowed: false, error: `Rate limit exceeded: max ${RATE_LIMIT} calls per minute.` };
    }
    callTimestamps.push(now);
    return { allowed: true };
}
// ──────────────────────────────────────
// Infrastructure: API key auth
// ──────────────────────────────────────
const REQUIRED_API_KEY = process.env.API_KEY;
function authAndRateCheck(apiKey) {
    if (REQUIRED_API_KEY && (!apiKey || apiKey !== REQUIRED_API_KEY)) {
        return { allowed: false, error: "Invalid or missing API key." };
    }
    return checkRateLimit();
}
// ──────────────────────────────────────
// Input schemas
// ──────────────────────────────────────
const ApiKeyField = { api_key: z.string().optional() };
const SearchProductsSchema = z.object({
    ...ApiKeyField,
    query: z.string().optional(),
    category: z.string().optional(),
    brand: z.string().optional(),
    limit: z.number().min(1).max(25).default(10).optional(),
});
const GetLatestDropsSchema = z.object({
    ...ApiKeyField,
    category: z.string().optional(),
    limit: z.number().min(1).max(30).default(15).optional(),
});
const GetBrandInfoSchema = z.object({
    ...ApiKeyField,
    brand: z.string(),
});
const GetPriceComparisonSchema = z.object({
    ...ApiKeyField,
    product: z.string(),
});
const GetMarketTrendsSchema = z.object({
    ...ApiKeyField,
    category: z.string().optional(),
    timeframe: z.enum(["7d", "30d", "90d"]).default("30d").optional(),
});
const CheckAvailabilitySchema = z.object({
    ...ApiKeyField,
    product: z.string(),
});
// ──────────────────────────────────────
// Tool implementations
// ──────────────────────────────────────
async function searchProducts(input) {
    const { query, category, brand, limit = 10 } = input;
    const conditions = ["p.is_excluded = false"];
    const params = [];
    let paramIdx = 1;
    if (query) {
        conditions.push(`p.title ILIKE $${paramIdx}`);
        params.push(`%${query}%`);
        paramIdx++;
    }
    if (category) {
        conditions.push(`p.category ILIKE $${paramIdx}`);
        params.push(`%${category}%`);
        paramIdx++;
    }
    if (brand) {
        conditions.push(`b.name ILIKE $${paramIdx}`);
        params.push(`%${brand}%`);
        paramIdx++;
    }
    conditions.push(`p.price IS NOT NULL AND p.price != '0'`);
    const where = conditions.join(" AND ");
    const rows = await sql(`
    SELECT p.id, p.title, p.price, p.category, p.is_available, b.name AS brand_name,
      (SELECT src FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image_url
    FROM products p
    JOIN brands b ON b.id = p.brand_id
    WHERE ${where}
    ORDER BY p.popularity_score DESC NULLS LAST
    LIMIT ${limit}
  `, params);
    return rows.map((r) => ({
        title: r.title,
        brand: r.brand_name,
        price: r.price ? parseFloat(r.price) : null,
        category: r.category,
        isAvailable: r.is_available,
        url: `https://edc4me.com/drops/${r.id}`,
        imageUrl: r.image_url,
        source: "Data from Drop Beacon (edc4me.com)",
    }));
}
async function getLatestDrops(input) {
    const { category, limit = 15 } = input;
    let categoryFilter = "";
    const params = [];
    if (category) {
        categoryFilter = `AND p.category ILIKE $1`;
        params.push(`%${category}%`);
    }
    const rows = await sql(`
    SELECT p.id, p.title, p.price, p.category, p.first_seen_at, b.name AS brand_name,
      (SELECT src FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image_url
    FROM products p
    JOIN brands b ON b.id = p.brand_id
    WHERE p.is_drop = true AND p.is_available = true AND p.is_excluded = false
      AND p.first_seen_at > NOW() - INTERVAL '7 days'
      AND p.price IS NOT NULL AND p.price != '0'
      ${categoryFilter}
    ORDER BY p.first_seen_at DESC
    LIMIT ${limit}
  `, params);
    return rows.map((r) => ({
        title: r.title,
        brand: r.brand_name,
        price: r.price ? parseFloat(r.price) : null,
        category: r.category,
        firstSeenAt: r.first_seen_at,
        url: `https://edc4me.com/drops/${r.id}`,
        imageUrl: r.image_url,
        source: "Data from Drop Beacon (edc4me.com)",
    }));
}
async function getBrandInfo(input) {
    const { brand: brandQuery } = input;
    const slug = brandQuery.toLowerCase().replace(/\s+/g, "-");
    const brandRows = await sql(`
    SELECT id, name, slug, category FROM brands
    WHERE name ILIKE $1 OR slug = $2
    LIMIT 1
  `, [`%${brandQuery}%`, slug]);
    if (brandRows.length === 0) {
        return { error: `Brand not found: ${brandQuery}`, source: "Data from Drop Beacon (edc4me.com)" };
    }
    const b = brandRows[0];
    const [stats, available, categories, topProducts] = await Promise.all([
        sql(`SELECT COUNT(*)::int AS total, MIN(price::numeric) AS min_price, MAX(price::numeric) AS max_price, AVG(price::numeric)::numeric(10,2) AS avg_price FROM products WHERE brand_id = $1 AND is_excluded = false AND price IS NOT NULL AND price != '0'`, [b.id]),
        sql(`SELECT COUNT(*)::int AS count FROM products WHERE brand_id = $1 AND is_available = true AND is_excluded = false`, [b.id]),
        sql(`SELECT category, COUNT(*)::int AS count FROM products WHERE brand_id = $1 AND is_excluded = false GROUP BY category ORDER BY count DESC`, [b.id]),
        sql(`SELECT id, title, price, is_available, popularity_score FROM products WHERE brand_id = $1 AND is_excluded = false ORDER BY popularity_score DESC NULLS LAST LIMIT 5`, [b.id]),
    ]);
    const s = stats[0];
    return {
        name: b.name,
        category: b.category,
        productCount: s?.total ?? 0,
        availableCount: available[0]?.count ?? 0,
        priceRange: { min: s?.min_price ? parseFloat(s.min_price) : null, max: s?.max_price ? parseFloat(s.max_price) : null, avg: s?.avg_price ? parseFloat(s.avg_price) : null },
        categories: categories.map((r) => ({ category: r.category, count: r.count })),
        topProducts: topProducts.map((p) => ({ title: p.title, price: p.price ? parseFloat(p.price) : null, isAvailable: p.is_available, url: `https://edc4me.com/drops/${p.id}` })),
        url: `https://edc4me.com/brands/${b.slug}`,
        source: "Data from Drop Beacon (edc4me.com)",
    };
}
async function getPriceComparison(input) {
    const { product: productQuery } = input;
    const slug = productQuery.toLowerCase().replace(/\s+/g, "-");
    const productRows = await sql(`
    SELECT id, title, price, compare_at_price, is_available FROM products
    WHERE is_excluded = false AND (title ILIKE $1 OR slug = $2)
    LIMIT 1
  `, [`%${productQuery}%`, slug]);
    if (productRows.length === 0) {
        return { error: `Product not found: ${productQuery}`, source: "Data from Drop Beacon (edc4me.com)" };
    }
    const p = productRows[0];
    const listings = await sql(`
    SELECT b.name AS retailer_name, b.slug AS retailer_slug, pl.price, pl.compare_at_price, pl.is_available, pl.product_url
    FROM product_listings pl
    JOIN brands b ON b.id = pl.retailer_brand_id
    WHERE pl.product_id = $1
  `, [p.id]);
    const retailers = listings.map((l) => ({
        name: l.retailer_name,
        price: l.price ? parseFloat(l.price) : null,
        compareAtPrice: l.compare_at_price ? parseFloat(l.compare_at_price) : null,
        isAvailable: l.is_available,
        url: l.product_url ?? `https://edc4me.com/brands/${l.retailer_slug}`,
    }));
    const available = retailers.filter((r) => r.price != null && r.isAvailable);
    const best = available.length > 0 ? available.reduce((b, r) => (r.price < b.price ? r : b)) : null;
    return {
        productName: p.title,
        canonicalPrice: p.price ? parseFloat(p.price) : null,
        retailers,
        bestPrice: best ? { retailer: best.name, price: best.price } : null,
        source: "Data from Drop Beacon (edc4me.com)",
    };
}
async function getMarketTrends(input) {
    const { category, timeframe = "30d" } = input;
    const days = timeframe === "7d" ? 7 : timeframe === "90d" ? 90 : 30;
    const catFilter = category ? `AND p.category ILIKE '%${category.replace(/'/g, "''")}%'` : "";
    const [categoryStats, brandStats, priceTiers, newProducts] = await Promise.all([
        sql(`SELECT category, COUNT(*)::int AS total, SUM(CASE WHEN is_available THEN 1 ELSE 0 END)::int AS available FROM products p WHERE is_excluded = false ${catFilter} GROUP BY category ORDER BY total DESC`),
        sql(`SELECT b.name AS brand_name, COUNT(*)::int AS total, SUM(CASE WHEN NOT p.is_available THEN 1 ELSE 0 END)::int AS sold FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.is_excluded = false AND b.is_retailer = false ${catFilter} GROUP BY b.name HAVING COUNT(*) >= 5 ORDER BY SUM(CASE WHEN NOT p.is_available THEN 1 ELSE 0 END)::float / COUNT(*) DESC LIMIT 10`),
        sql(`SELECT CASE WHEN price::numeric < 50 THEN 'Under $50' WHEN price::numeric < 100 THEN '$50–$100' WHEN price::numeric < 200 THEN '$100–$200' WHEN price::numeric < 400 THEN '$200–$400' ELSE '$400+' END AS tier, COUNT(*)::int AS total, SUM(CASE WHEN is_available THEN 1 ELSE 0 END)::int AS available FROM products p WHERE is_excluded = false AND price IS NOT NULL ${catFilter} GROUP BY tier`),
        sql(`SELECT COUNT(*)::int AS count FROM products p WHERE is_excluded = false AND first_seen_at > NOW() - INTERVAL '${days} days' ${catFilter}`),
    ]);
    return {
        timeframe,
        categories: categoryStats.map((r) => ({ category: r.category ?? "unknown", total: r.total, available: r.available, sellThroughRate: r.total > 0 ? Math.round(((r.total - r.available) / r.total) * 100) : 0 })),
        topMovers: brandStats.map((r) => ({ brand: r.brand_name, total: r.total, sold: r.sold, sellThroughRate: r.total > 0 ? Math.round((r.sold / r.total) * 100) : 0 })),
        priceTiers: priceTiers.map((r) => ({ tier: r.tier, total: r.total, available: r.available, sellThroughRate: r.total > 0 ? Math.round(((r.total - r.available) / r.total) * 100) : 0 })),
        totalNewProducts: newProducts[0]?.count ?? 0,
        source: "Data from Drop Beacon (edc4me.com)",
    };
}
async function checkAvailability(input) {
    const { product: productQuery } = input;
    const slug = productQuery.toLowerCase().replace(/\s+/g, "-");
    const productRows = await sql(`
    SELECT id, title, is_available, last_seen_at FROM products
    WHERE is_excluded = false AND (title ILIKE $1 OR slug = $2)
    LIMIT 1
  `, [`%${productQuery}%`, slug]);
    if (productRows.length === 0) {
        return { error: `Product not found: ${productQuery}`, source: "Data from Drop Beacon (edc4me.com)" };
    }
    const p = productRows[0];
    const listings = await sql(`
    SELECT b.name AS retailer_name, b.slug AS retailer_slug, pl.price, pl.is_available, pl.product_url
    FROM product_listings pl
    JOIN brands b ON b.id = pl.retailer_brand_id
    WHERE pl.product_id = $1
  `, [p.id]);
    const retailers = listings.map((l) => ({
        name: l.retailer_name,
        price: l.price ? parseFloat(l.price) : null,
        inStock: l.is_available,
        url: l.product_url ?? `https://edc4me.com/brands/${l.retailer_slug}`,
    }));
    return {
        productName: p.title,
        isAvailable: p.is_available || retailers.some((r) => r.inStock),
        retailers,
        lastChecked: p.last_seen_at,
        source: "Data from Drop Beacon (edc4me.com)",
    };
}
// ──────────────────────────────────────
// MCP server factory
// ──────────────────────────────────────
const API_KEY_PARAM = {
    api_key: { type: "string", description: "Optional API key for authenticated access." },
};
const TOOLS_LIST = [
    {
        name: "search_products",
        description: "Search for EDC products by keyword, category, brand, or material. Returns matching products with prices, availability, and brand info.",
        inputSchema: { type: "object", properties: { ...API_KEY_PARAM, query: { type: "string", description: "Search keyword" }, category: { type: "string", description: "Filter by category (knives, wallets, flashlights, pens, fidgets_haptics)" }, brand: { type: "string", description: "Filter by brand name" }, limit: { type: "number", description: "Results to return (default: 10, max: 25)" } } },
    },
    {
        name: "get_latest_drops",
        description: "Get the latest EDC product drops from the last 7 days.",
        inputSchema: { type: "object", properties: { ...API_KEY_PARAM, category: { type: "string", description: "Filter by category" }, limit: { type: "number", description: "Results to return (default: 15, max: 30)" } } },
    },
    {
        name: "get_brand_info",
        description: "Get detailed info about an EDC brand including product count, price range, categories, and top products.",
        inputSchema: { type: "object", properties: { ...API_KEY_PARAM, brand: { type: "string", description: "Brand name or slug" } }, required: ["brand"] },
    },
    {
        name: "get_price_comparison",
        description: "Compare prices for the same product across multiple retailers.",
        inputSchema: { type: "object", properties: { ...API_KEY_PARAM, product: { type: "string", description: "Product name or slug" } }, required: ["product"] },
    },
    {
        name: "get_market_trends",
        description: "Get EDC market trends: sell-through velocity, top movers, price distribution.",
        inputSchema: { type: "object", properties: { ...API_KEY_PARAM, category: { type: "string", description: "Filter by category" }, timeframe: { type: "string", enum: ["7d", "30d", "90d"], description: "Lookback window (default: 30d)" } } },
    },
    {
        name: "check_availability",
        description: "Check if a specific EDC product is currently in stock at any retailer.",
        inputSchema: { type: "object", properties: { ...API_KEY_PARAM, product: { type: "string", description: "Product name or slug" } }, required: ["product"] },
    },
];
function handleToolCall(name, args) {
    const apiKey = args?.api_key;
    const guard = authAndRateCheck(apiKey);
    if (!guard.allowed) {
        return { content: [{ type: "text", text: `Error: ${guard.error}` }], isError: true };
    }
    switch (name) {
        case "search_products": return searchProducts(SearchProductsSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }));
        case "get_latest_drops": return getLatestDrops(GetLatestDropsSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }));
        case "get_brand_info": return getBrandInfo(GetBrandInfoSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }));
        case "get_price_comparison": return getPriceComparison(GetPriceComparisonSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }));
        case "get_market_trends": return getMarketTrends(GetMarketTrendsSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }));
        case "check_availability": return checkAvailability(CheckAvailabilitySchema.parse(args ?? {})).then(r => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }));
        default: return Promise.resolve({ content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    }
}
function createMCPServer() {
    const s = new Server({ name: "drop-beacon-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));
    s.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            return await handleToolCall(name, (args ?? {}));
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    });
    return s;
}
// ──────────────────────────────────────
// Start — stdio or HTTP based on PORT env
// ──────────────────────────────────────
const PORT = process.env.PORT;
if (PORT) {
    // HTTP mode for hosted deployment (Streamable HTTP + legacy SSE)
    const httpSessions = new Map();
    const httpServer = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
        res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
        // Streamable HTTP endpoint — per-session server+transport
        if (url.pathname === "/mcp") {
            const sessionId = req.headers["mcp-session-id"];
            if (req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => { body += chunk; });
                req.on("end", async () => {
                    try {
                        const parsed = JSON.parse(body);
                        const isInit = !Array.isArray(parsed) && parsed.method === "initialize";
                        if (isInit) {
                            // New session: create server + transport
                            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
                            const mcpServer = createMCPServer();
                            await mcpServer.connect(transport);
                            const newSessionId = transport.sessionId;
                            httpSessions.set(newSessionId, { server: mcpServer, transport });
                            transport.onclose = () => {
                                httpSessions.delete(newSessionId);
                            };
                            await transport.handleRequest(req, res, parsed);
                        }
                        else if (sessionId && httpSessions.has(sessionId)) {
                            // Existing session
                            await httpSessions.get(sessionId).transport.handleRequest(req, res, parsed);
                        }
                        else {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Bad Request: No valid session" }, id: null }));
                        }
                    }
                    catch {
                        res.writeHead(400);
                        res.end("Invalid JSON");
                    }
                });
                return;
            }
            if (req.method === "GET" || req.method === "DELETE") {
                if (sessionId && httpSessions.has(sessionId)) {
                    await httpSessions.get(sessionId).transport.handleRequest(req, res);
                }
                else {
                    res.writeHead(400);
                    res.end("Invalid or missing session");
                }
                return;
            }
        }
        // Legacy SSE endpoints
        if (req.method === "GET" && url.pathname === "/sse") {
            const transport = new SSEServerTransport("/messages", res);
            const mcpServer = createMCPServer();
            res.on("close", () => { mcpServer.close(); });
            await mcpServer.connect(transport);
            return;
        }
        if (req.method === "POST" && url.pathname === "/messages") {
            // SSE message handling not supported in per-session mode — clients should use /mcp
            res.writeHead(400);
            res.end("Use /mcp endpoint for Streamable HTTP");
            return;
        }
        if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version: "0.2.0", transport: "http+sse", sessions: httpSessions.size }));
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    });
    httpServer.listen(parseInt(PORT), () => {
        console.error(`Drop Beacon MCP server v0.2.0 running on HTTP+SSE at :${PORT}${REQUIRED_API_KEY ? " (auth enabled)" : ""}`);
    });
}
else {
    // stdio mode for local use
    const server = createMCPServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Drop Beacon MCP server v0.2.0 running on stdio${REQUIRED_API_KEY ? " (auth enabled)" : ""}`);
}
