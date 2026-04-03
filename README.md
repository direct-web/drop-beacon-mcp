# Drop Beacon MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants access to real-time EDC (everyday carry) product data from [Drop Beacon](https://edc4me.com) — 100,000+ products across 1,000+ brands.

## Tools

| Tool | Description |
|------|-------------|
| `search_products` | Search EDC products by keyword, category, brand, or material |
| `get_latest_drops` | Get new product drops from the last 7 days |
| `get_brand_info` | Brand stats, price range, categories, and top products |
| `get_price_comparison` | Compare prices for the same product across retailers |
| `get_market_trends` | Sell-through velocity, top movers, and price distribution |
| `check_availability` | Real-time stock check across all retailers |

## Quick Start

```bash
npx drop-beacon-mcp
```

Requires a `DATABASE_URL` environment variable pointing to the Drop Beacon database.

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "drop-beacon": {
      "command": "npx",
      "args": ["-y", "drop-beacon-mcp"],
      "env": {
        "DATABASE_URL": "your-neon-connection-string"
      }
    }
  }
}
```

## Categories

Products span these EDC categories:
- Knives
- Fidgets & Haptics
- Flashlights
- Pens & Writing
- Wallets & Organization
- Multitools & Pry Bars
- Watches
- Bags & Pouches

## Authentication

Set the `API_KEY` environment variable to require an API key for all requests. If not set, the server runs without authentication.

## Rate Limiting

60 requests per minute per process (in-memory, resets on restart).

## Examples

**"What titanium fidgets dropped this week?"**
Uses `get_latest_drops` with category filter.

**"Compare prices for the Spyderco Para 3"**
Uses `get_price_comparison` to show prices across retailers.

**"Is the Grimsmo Norseman in stock anywhere?"**
Uses `check_availability` to check all retailers.

**"What are the hottest EDC brands right now?"**
Uses `get_market_trends` to show sell-through velocity.

## License

MIT

## Links

- [Drop Beacon](https://edc4me.com)
- [npm](https://www.npmjs.com/package/drop-beacon-mcp)
