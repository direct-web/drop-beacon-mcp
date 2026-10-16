# Drop Beacon MCP

Read-only EDC product discovery through Drop Beacon's public HTTPS catalog API.
**No database password, DATABASE_URL, or API key is required.**

## Install

Requires Node.js 20 or newer. Configure your MCP client:

```json
{
  "mcpServers": {
    "drop-beacon": {
      "command": "npx",
      "args": ["-y", "drop-beacon-mcp@0.3.0"]
    }
  }
}
```

## Tools

| Tool | Public data returned |
| --- | --- |
| `search_products` | Up to 25 currently available catalog matches |
| `get_latest_drops` | Recent in-stock listings first seen within seven days |
| `get_brand_info` | Public brand profile and available-product count |
| `check_availability` | Up to 10 matching available listings |

Categories: `knife`, `fidget`, `flashlight`, `pen`, `wallet`, `multi_tool`, `patch`, `other`.
Search arguments accept up to 120 characters. Results are catalog snapshots, not guarantees of current retailer stock. Compare the exact material, configuration and condition on the linked product page. No match does not mean unavailable everywhere. First seen means discovered by Drop Beacon, not released by the manufacturer.

## Migration from 0.2.x

Remove DATABASE_URL and API_KEY from client and hosted-service settings. Upgrade any cached installation to 0.3.0 or newer. If a real database password was ever shared, revoke it with the database provider; editing a listing alone cannot revoke access.

Direct SQL access, arbitrary URLs, private records, and internal market analytics are not supported. `get_market_trends` and `get_price_comparison` have been retired from this public MCP; use the [market pages](https://edc4me.com/market/yield) and [product comparison](https://edc4me.com/compare) on the website. The old optional API_KEY gate and legacy SSE endpoints are removed. Do not send credentials as tool arguments.

## Security boundary

The package has no database driver and only performs credential-free GET requests to `https://edc4me.com/api/drops` and `/api/brands`. Explicit output allowlists prevent new upstream fields from silently becoming MCP output. Requests reject redirects, time out after 15 seconds, cap response bodies at 2 MB, and return generic errors without upstream response bodies. Tool arguments cannot override the origin, endpoint, HTTP method, or headers.

The process allows 60 tool calls per minute, shared across clients and reset on restart; this is a best-effort local limit, not a distributed quota. The public API also applies its own edge protections. A 429 response asks the client to wait, never to supply database access.

Stdio is the default. Optional stateless HTTP uses `PORT`, binds to loopback by default, and serves POST `/mcp` plus GET `/health`. Hosted services can explicitly set `HOST=0.0.0.0`. Browser origins other than `https://edc4me.com` are rejected, request bodies are limited to 64 KB, and batched requests are rejected. No customer-specific authentication is needed because only public catalog data is available.

## Development

`npm ci && npm test`

`npm run security:scan` scans tracked files, including documentation and environment examples, without printing secret values. See `SECURITY.md` for limitations and local hook setup.

[Drop Beacon](https://edc4me.com) · [Public API](https://edc4me.com/.well-known/openapi.yaml) · MIT
