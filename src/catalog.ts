import { z } from "zod";
export const API_ORIGIN = "https://edc4me.com";
export const USER_AGENT = "DropBeaconMCP/0.3.0 (+https://edc4me.com)";
export const VERSION = "0.3.0";
const text = z.string().trim().min(1).max(120);
const category = z.enum(["knife", "fidget", "flashlight", "pen", "wallet", "multi_tool", "patch", "other"]);
const schemas = {
  search_products: z.object({ query: text.optional(), category: category.optional(), brand: text.optional(), limit: z.number().int().min(1).max(25).default(10) }).strict(),
  get_latest_drops: z.object({ category: category.optional(), limit: z.number().int().min(1).max(25).default(15) }).strict(),
  get_brand_info: z.object({ brand: text }).strict(),
  check_availability: z.object({ product: text }).strict(),
};
type ToolName = keyof typeof schemas;
const catProp = { type: "string", enum: category.options };
const limitProp = { type: "integer", minimum: 1, maximum: 25 };
const textProp = { type: "string", minLength: 1, maxLength: 120 };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const TOOLS = [
  { name: "search_products", description: "Search currently available public EDC catalog listings. Prices may represent different configurations; verify the product page before comparing or purchasing.", inputSchema: { type: "object" as const, properties: { query: textProp, category: catProp, brand: textProp, limit: limitProp }, additionalProperties: false }, annotations },
  { name: "get_latest_drops", description: "Read in-stock listings first seen within seven days. First seen is a discovery date, not a manufacturer release date. Results are a bounded sample, not the entire market.", inputSchema: { type: "object" as const, properties: { category: catProp, limit: limitProp }, additionalProperties: false }, annotations },
  { name: "get_brand_info", description: "Find a public brand profile and its available-product count. No internal analytics or customer records.", inputSchema: { type: "object" as const, properties: { brand: textProp }, required: ["brand"], additionalProperties: false }, annotations },
  { name: "check_availability", description: "Find available catalog matches for a product name. No match does not mean unavailable everywhere. Confirm precise material, configuration, price and retailer stock on the linked page.", inputSchema: { type: "object" as const, properties: { product: textProp }, required: ["product"], additionalProperties: false }, annotations },
];
export class CatalogError extends Error {}
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === "string" ? v : null;
const safeUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try { const u = new URL(v, API_ORIGIN); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
};
// Explicit output fields: new upstream fields never silently become MCP data.
export function publicProduct(value: unknown) {
  const p = obj(value), b = obj(p.brand);
  const id = Number.isSafeInteger(p.id) ? p.id as number : null;
  const slug = str(p.slug);
  const price = (typeof p.price === "string" || typeof p.price === "number") && p.price !== "" ? Number(p.price) : NaN;
  return {
    id, title: str(p.title), brand: str(b.name), category: str(p.category),
    price: Number.isFinite(price) && price >= 0 ? price : null, currency: str(p.currency),
    isAvailable: typeof p.isAvailable === "boolean" ? p.isAvailable : null, firstSeenAt: str(p.firstSeenAt),
    url: slug ? `${API_ORIGIN}/product/${encodeURIComponent(slug)}` : id ? `${API_ORIGIN}/drops/${id}` : null,
    imageUrl: Array.isArray(p.images) ? safeUrl(obj(p.images[0]).src) : null,
  };
}
export class Catalog {
  constructor(private fetcher: typeof fetch = fetch) {}
  private async get(path: "/api/drops" | "/api/brands", params: Record<string, string>) {
    const url = new URL(path, API_ORIGIN);
    url.search = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    } catch { throw new CatalogError("The public catalog is temporarily unreachable. Try again later; no database credential is needed."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogError(response.status === 429 ? "The public API is rate-limited. Wait at least 60 seconds before retrying." : "The public catalog is temporarily unavailable. Check edc4me.com; do not supply database credentials.");
    }
    if (!response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw new CatalogError("The public API returned an unexpected response."); }
    const reader = response.body?.getReader();
    if (!reader) throw new CatalogError("The public API returned an empty response.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); throw new CatalogError("The public API response exceeded its size limit."); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (err) { if (err instanceof CatalogError) throw err; throw new CatalogError("The public API returned an incomplete or invalid response."); }
  }
  private async brands(query: string) {
    const data = obj(await this.get("/api/brands", {}));
    if (!Array.isArray(data.brands)) throw new CatalogError("Unexpected public brand catalog format.");
    const q = query.toLowerCase();
    return data.brands.map(obj).filter(b => String(b.name ?? "").toLowerCase().includes(q) || String(b.slug ?? "").toLowerCase() === q).slice(0, 10).map(b => ({ name: str(b.name), slug: str(b.slug), category: str(b.category), availableProductCount: typeof b.productCount === "number" && Number.isFinite(b.productCount) ? b.productCount : null, url: typeof b.slug === "string" ? `${API_ORIGIN}/brands/${encodeURIComponent(b.slug)}` : null }));
  }
  private async products(params: Record<string, string>, limit: number) {
    const data = obj(await this.get("/api/drops", { ...params, limit: String(limit), offset: "0", sort: "newest", tab: "all", sold_out: "false" }));
    if (!Array.isArray(data.drops)) throw new CatalogError("Unexpected public product catalog format.");
    return data.drops.slice(0, limit).map(publicProduct).filter(p => p.isAvailable === true);
  }
  async call(name: string, args: unknown) {
    if (!Object.hasOwn(schemas, name)) throw new CatalogError("Unknown or retired tool. Use search_products, get_latest_drops, get_brand_info, or check_availability.");
    const input = schemas[name as ToolName].safeParse(args);
    if (!input.success) throw new CatalogError("Invalid arguments. Use the advertised schema; text is limited to 120 characters and results to 25. Credentials and arbitrary URLs are not accepted.");
    const common = { source: "Drop Beacon public catalog (edc4me.com)", checkedAt: new Date().toISOString() };
    if (name === "get_brand_info") return { ...common, brands: await this.brands((input.data as z.infer<typeof schemas.get_brand_info>).brand) };
    if (name === "search_products") {
      const i = input.data as z.infer<typeof schemas.search_products>;
      const params: Record<string, string> = {};
      if (i.query) params.q = i.query; if (i.category) params.category = i.category;
      if (i.brand) {
        const brands = await this.brands(i.brand);
        const exact = brands.find(b => b.name?.toLowerCase() === i.brand!.toLowerCase() || b.slug === i.brand!.toLowerCase());
        if (!exact?.slug) return { ...common, products: [], note: "Brand did not resolve exactly. Use get_brand_info to choose a listed brand slug." };
        params.brand = exact.slug;
      }
      return { ...common, products: await this.products(params, i.limit), note: "Catalog matches may differ in configuration. Confirm current prices and stock on linked pages." };
    }
    if (name === "get_latest_drops") {
      const i = input.data as z.infer<typeof schemas.get_latest_drops>;
      const matches = await this.products(i.category ? { category: i.category } : {}, i.limit);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return { ...common, products: matches.filter(p => p.firstSeenAt && Date.parse(p.firstSeenAt) >= cutoff), note: "First-seen dates are discovery dates. Bounded sample, not a complete seven-day inventory." };
    }
    const i = input.data as z.infer<typeof schemas.check_availability>;
    return { ...common, matches: await this.products({ q: i.product }, 10), note: "Matching available listings only; no match does not mean unavailable everywhere. Match the exact configuration and confirm retailer stock." };
  }
}
