# BenedictKing Skills

A curated Agent Skills collection published by BenedictKing.

## Included skills

- `context7-auto-research` — Fetch current library and framework docs from Context7
- `exa-search` — Semantic web search and related-content research via Exa
- `firecrawl-scraper` — Scrape pages, extract structured data, screenshots, and PDFs via Firecrawl
- `tavily-web` — Web research, extraction, crawl, map, and structured research via Tavily
- `codex-review` — Codex-based code review workflow for pending changes or recent commits

## Repository layout

```text
.claude-plugin/plugin.json
skills/
  context7-auto-research/
  exa-search/
  firecrawl-scraper/
  tavily-web/
  codex-review/
```

Each skill follows the Agent Skills layout:
- `SKILL.md`
- optional `scripts/`
- optional `references/`
- optional `.env.example`

## Validation

Validate the whole collection:

```bash
gh skill publish . --dry-run
```

Validate a single script entrypoint if needed:

```bash
node skills/exa-search/scripts/exa-api.cjs --help
```

## Publishing

```bash
gh skill publish . --tag v1.0.0
```

## License

MIT
