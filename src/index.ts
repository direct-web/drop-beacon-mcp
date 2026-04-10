#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
const callTimestamps: number[] = [];

function checkRateLimit(): { allowed: boolean; error?: string } {
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

function authAndRateCheck(apiKey?: string): { allowed: boolean; error?: string } {
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

async function searchProducts(input: z.infer<typeof SearchProductsSchema>) {
  const { query, category, brand, limit = 10 } = input;

  const conditions: string[] = ["p.is_excluded = false"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (query) { conditions.push(`p.title ILIKE $${paramIdx}`); params.push(`%${query}%`); paramIdx++; }
  if (category) { conditions.push(`p.category ILIKE $${paramIdx}`); params.push(`%${category}%`); paramIdx++; }
  if (brand) { conditions.push(`b.name ILIKE $${paramIdx}`); params.push(`%${brand}%`); paramIdx++; }

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

  return rows.map((r: any) => ({
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

async function getLatestDrops(input: z.infer<typeof GetLatestDropsSchema>) {
  const { category, limit = 15 } = input;

  let categoryFilter = "";
  const params: unknown[] = [];
  if (category) { categoryFilter = `AND p.category ILIKE $1`; params.push(`%${category}%`); }

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

  return rows.map((r: any) => ({
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

async function getBrandInfo(input: z.infer<typeof GetBrandInfoSchema>) {
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

  const b = brandRows[0] as any;

  const [stats, available, categories, topProducts] = await Promise.all([
    sql(`SELECT COUNT(*)::int AS total, MIN(price::numeric) AS min_price, MAX(price::numeric) AS max_price, AVG(price::numeric)::numeric(10,2) AS avg_price FROM products WHERE brand_id = $1 AND is_excluded = false AND price IS NOT NULL AND price != '0'`, [b.id]),
    sql(`SELECT COUNT(*)::int AS count FROM products WHERE brand_id = $1 AND is_available = true AND is_excluded = false`, [b.id]),
    sql(`SELECT category, COUNT(*)::int AS count FROM products WHERE brand_id = $1 AND is_excluded = false GROUP BY category ORDER BY count DESC`, [b.id]),
    sql(`SELECT id, title, price, is_available, popularity_score FROM products WHERE brand_id = $1 AND is_excluded = false ORDER BY popularity_score DESC NULLS LAST LIMIT 5`, [b.id]),
  ]);

  const s = stats[0] as any;
  return {
    name: b.name,
    category: b.category,
    productCount: s?.total ?? 0,
    availableCount: (available[0] as any)?.count ?? 0,
    priceRange: { min: s?.min_price ? parseFloat(s.min_price) : null, max: s?.max_price ? parseFloat(s.max_price) : null, avg: s?.avg_price ? parseFloat(s.avg_price) : null },
    categories: categories.map((r: any) => ({ category: r.category, count: r.count })),
    topProducts: topProducts.map((p: any) => ({ title: p.title, price: p.price ? parseFloat(p.price) : null, isAvailable: p.is_available, url: `https://edc4me.com/drops/${p.id}` })),
    url: `https://edc4me.com/brands/${b.slug}`,
    source: "Data from Drop Beacon (edc4me.com)",
  };
}

async function getPriceComparison(input: z.infer<typeof GetPriceComparisonSchema>) {
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

  const p = productRows[0] as any;

  const listings = await sql(`
    SELECT b.name AS retailer_name, b.slug AS retailer_slug, pl.price, pl.compare_at_price, pl.is_available, pl.product_url
    FROM product_listings pl
    JOIN brands b ON b.id = pl.retailer_brand_id
    WHERE pl.product_id = $1
  `, [p.id]);

  const retailers = listings.map((l: any) => ({
    name: l.retailer_name,
    price: l.price ? parseFloat(l.price) : null,
    compareAtPrice: l.compare_at_price ? parseFloat(l.compare_at_price) : null,
    isAvailable: l.is_available,
    url: l.product_url ?? `https://edc4me.com/brands/${l.retailer_slug}`,
  }));

  const available = retailers.filter((r) => r.price != null && r.isAvailable);
  const best = available.length > 0 ? available.reduce((b, r) => (r.price! < b.price! ? r : b)) : null;

  return {
    productName: p.title,
    canonicalPrice: p.price ? parseFloat(p.price) : null,
    retailers,
    bestPrice: best ? { retailer: best.name, price: best.price } : null,
    source: "Data from Drop Beacon (edc4me.com)",
  };
}

async function getMarketTrends(input: z.infer<typeof GetMarketTrendsSchema>) {
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
    categories: categoryStats.map((r: any) => ({ category: r.category ?? "unknown", total: r.total, available: r.available, sellThroughRate: r.total > 0 ? Math.round(((r.total - r.available) / r.total) * 100) : 0 })),
    topMovers: brandStats.map((r: any) => ({ brand: r.brand_name, total: r.total, sold: r.sold, sellThroughRate: r.total > 0 ? Math.round((r.sold / r.total) * 100) : 0 })),
    priceTiers: priceTiers.map((r: any) => ({ tier: r.tier, total: r.total, available: r.available, sellThroughRate: r.total > 0 ? Math.round(((r.total - r.available) / r.total) * 100) : 0 })),
    totalNewProducts: (newProducts[0] as any)?.count ?? 0,
    source: "Data from Drop Beacon (edc4me.com)",
  };
}

async function checkAvailability(input: z.infer<typeof CheckAvailabilitySchema>) {
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

  const p = productRows[0] as any;

  const listings = await sql(`
    SELECT b.name AS retailer_name, b.slug AS retailer_slug, pl.price, pl.is_available, pl.product_url
    FROM product_listings pl
    JOIN brands b ON b.id = pl.retailer_brand_id
    WHERE pl.product_id = $1
  `, [p.id]);

  const retailers = listings.map((l: any) => ({
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
    description: "Search for EDC (everyday carry) products by keyword, category, brand, or material. Returns matching products with titles, prices, availability status, brand names, product images, and direct links to edc4me.com. Searches across 100,000+ tracked products from 1,000+ brands.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...API_KEY_PARAM,
        query: { type: "string", description: "Search keyword to match against product titles (e.g., 'titanium knife', 'Olight flashlight', 'fidget spinner')" },
        category: { type: "string", description: "Filter by product category. Options: knives, wallets, flashlights, pens, fidgets_haptics, multi_tools, watches, bags" },
        brand: { type: "string", description: "Filter by brand name (e.g., 'Spyderco', 'Benchmade', 'Olight', 'Magnus')" },
        limit: { type: "number", description: "Number of results to return (default: 10, max: 25)" },
      },
    },
    annotations: { title: "Search Products", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_latest_drops",
    description: "Get the latest EDC product drops and new releases from the last 7 days. Shows newly available products with prices, brands, release dates, and images. Useful for staying current on what's new in the EDC market.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...API_KEY_PARAM,
        category: { type: "string", description: "Filter drops by product category (e.g., 'knives', 'flashlights', 'fidgets_haptics')" },
        limit: { type: "number", description: "Number of results to return (default: 15, max: 30)" },
      },
    },
    annotations: { title: "Latest Drops", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_brand_info",
    description: "Get detailed information about an EDC brand including total product count, number of available products, price range (min/max/avg), product categories, and top 5 products by popularity. Useful for brand research and comparison.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...API_KEY_PARAM,
        brand: { type: "string", description: "Brand name or URL slug to look up (e.g., 'Spyderco', 'chris-reeve', 'Benchmade')" },
      },
      required: ["brand"],
    },
    annotations: { title: "Brand Info", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_price_comparison",
    description: "Compare prices for the same EDC product across multiple retailers. Returns each retailer's current price, compare-at price, availability status, and direct product links. Identifies the best available price.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...API_KEY_PARAM,
        product: { type: "string", description: "Product name or URL slug to compare prices for (e.g., 'Spyderco Para 3', 'Benchmade 940')" },
      },
      required: ["product"],
    },
    annotations: { title: "Price Comparison", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_market_trends",
    description: "Get EDC market trend data including sell-through rates by category, top 10 fastest-selling brands, price tier distribution, and new product counts. Useful for market analysis and understanding what's hot in the EDC space.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...API_KEY_PARAM,
        category: { type: "string", description: "Filter trends by product category (e.g., 'knives', 'flashlights')" },
        timeframe: { type: "string", enum: ["7d", "30d", "90d"], description: "Lookback window for new product counts (default: '30d')" },
      },
    },
    annotations: { title: "Market Trends", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "check_availability",
    description: "Check if a specific EDC product is currently in stock at any tracked retailer. Returns per-retailer availability, prices, and direct purchase links. Useful for finding where to buy a specific product.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...API_KEY_PARAM,
        product: { type: "string", description: "Product name or URL slug to check availability for (e.g., 'Chris Reeve Sebenza', 'hinderer-xm-18')" },
      },
      required: ["product"],
    },
    annotations: { title: "Check Availability", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// ──────────────────────────────────────
// Prompts
// ──────────────────────────────────────

const PROMPTS_LIST = [
  {
    name: "product_research",
    description: "Research an EDC product category — get current drops, market trends, top brands, and pricing data.",
    arguments: [
      { name: "category", description: "Product category to research (e.g., knives, flashlights, fidgets_haptics, wallets)", required: true },
    ],
  },
  {
    name: "brand_comparison",
    description: "Compare two EDC brands side-by-side — product counts, price ranges, sell-through rates, and top products.",
    arguments: [
      { name: "brand1", description: "First brand name (e.g., Spyderco)", required: true },
      { name: "brand2", description: "Second brand name (e.g., Benchmade)", required: true },
    ],
  },
  {
    name: "deal_finder",
    description: "Find the best deals and in-stock products in a category or from a specific brand.",
    arguments: [
      { name: "query", description: "What to search for — a category, brand, or product type (e.g., 'titanium knives under $200')", required: true },
    ],
  },
];

function handleGetPrompt(name: string, args: Record<string, string>) {
  switch (name) {
    case "product_research":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Research the ${args.category} category in the EDC market. Use the Drop Beacon tools to:\n1. Get the latest drops in ${args.category}\n2. Get market trends for ${args.category}\n3. Search for top products in ${args.category}\n\nProvide a comprehensive summary with current trends, notable new releases, price ranges, and top brands.`,
            },
          },
        ],
      };
    case "brand_comparison":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Compare ${args.brand1} vs ${args.brand2} in the EDC market. Use the Drop Beacon tools to:\n1. Get brand info for ${args.brand1}\n2. Get brand info for ${args.brand2}\n3. Search for products from each brand\n\nProvide a side-by-side comparison covering product range, pricing, availability, and market position.`,
            },
          },
        ],
      };
    case "deal_finder":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Find the best deals and in-stock products for: ${args.query}. Use the Drop Beacon tools to:\n1. Search for matching products\n2. Check availability for top results\n3. Compare prices across retailers\n\nList the best options with prices, availability, and where to buy.`,
            },
          },
        ],
      };
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

// ──────────────────────────────────────
// Resources
// ──────────────────────────────────────

const RESOURCES_LIST = [
  {
    uri: "https://edc4me.com",
    name: "Drop Beacon",
    description: "EDC product discovery platform — browse all tracked products, brands, drops, and market data.",
    mimeType: "text/html",
  },
  {
    uri: "https://edc4me.com/drops",
    name: "Latest Drops",
    description: "Browse the latest EDC product drops and new releases.",
    mimeType: "text/html",
  },
  {
    uri: "https://edc4me.com/brands",
    name: "Brand Directory",
    description: "Browse all 1,000+ tracked EDC brands with product counts and categories.",
    mimeType: "text/html",
  },
];

function handleToolCall(name: string, args: Record<string, unknown>) {
  const apiKey = args?.api_key as string | undefined;
  const guard = authAndRateCheck(apiKey);
  if (!guard.allowed) {
    return { content: [{ type: "text" as const, text: `Error: ${guard.error}` }], isError: true };
  }

  switch (name) {
    case "search_products": return searchProducts(SearchProductsSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] }));
    case "get_latest_drops": return getLatestDrops(GetLatestDropsSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] }));
    case "get_brand_info": return getBrandInfo(GetBrandInfoSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] }));
    case "get_price_comparison": return getPriceComparison(GetPriceComparisonSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] }));
    case "get_market_trends": return getMarketTrends(GetMarketTrendsSchema.parse(args ?? {})).then(r => ({ content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] }));
    case "check_availability": return checkAvailability(CheckAvailabilitySchema.parse(args ?? {})).then(r => ({ content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] }));
    default: return Promise.resolve({ content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true });
  }
}

function createMCPServer(): Server {
  const s = new Server(
    { name: "drop-beacon-mcp", version: "0.2.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(name, (args ?? {}) as Record<string, unknown>);
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  s.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS_LIST }));

  s.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleGetPrompt(name, (args ?? {}) as Record<string, string>);
  });

  s.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES_LIST }));

  return s;
}

// ──────────────────────────────────────
// Start — stdio or HTTP based on PORT env
// ──────────────────────────────────────

const PORT = process.env.PORT;

if (PORT) {
  // HTTP mode for hosted deployment (Streamable HTTP + legacy SSE)
  // Stateless: each request gets a fresh server+transport. All tools are read-only
  // so no session state is needed between requests.

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

    // Streamable HTTP endpoint — stateless, per-request server+transport
    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            const mcpServer = createMCPServer();
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, parsed);
          } catch {
            if (!res.headersSent) {
              res.writeHead(400);
              res.end("Invalid JSON");
            }
          }
        });
        return;
      }

      if (req.method === "GET") {
        res.writeHead(405);
        res.end("Method not allowed in stateless mode");
        return;
      }

      if (req.method === "DELETE") {
        res.writeHead(405);
        res.end("Method not allowed in stateless mode");
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
      res.writeHead(400);
      res.end("Use /mcp endpoint for Streamable HTTP");
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.2.0", transport: "http" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(parseInt(PORT), () => {
    console.error(`Drop Beacon MCP server v0.2.0 running on HTTP at :${PORT}${REQUIRED_API_KEY ? " (auth enabled)" : ""}`);
  });
} else {
  // stdio mode for local use
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Drop Beacon MCP server v0.2.0 running on stdio${REQUIRED_API_KEY ? " (auth enabled)" : ""}`);
}
