# BenedictKing Skills

English | [简体中文](./README_CN.md)

A curated Agent Skills collection published by BenedictKing.

## Included skills

- `context7-auto-research` — Fetch current library and framework docs from Context7
- `exa-search` — Semantic web search and related-content research via Exa
- `firecrawl-scraper` — Scrape pages, extract structured data, screenshots, and PDFs via Firecrawl
- `tavily-web` — Web research, extraction, crawl, map, and structured research via Tavily
- `codex-review` — Codex-based code review workflow for pending changes or recent commits
- `gpt-image-2-api` — Generate and edit images with gpt-image-2 via OpenAI-compatible image or chat APIs

## Repository layout

```text
.claude-plugin/plugin.json
skills/
  context7-auto-research/
  exa-search/
  firecrawl-scraper/
  tavily-web/
  codex-review/
  gpt-image-2-api/
```

Each skill follows the Agent Skills layout:
- `SKILL.md`
- optional `scripts/`
- optional `references/`
- optional `.env.example`

## Installation

Install the whole collection:

```bash
gh skill install BenedictKing/benedictking-skills
```

Install a single skill:

```bash
gh skill install BenedictKing/benedictking-skills exa-search
```

Pin a specific release:

```bash
gh skill install BenedictKing/benedictking-skills exa-search --pin v1.0.0
```

## Validation

Validate the whole collection:

```bash
gh skill publish . --dry-run
```

Validate a single script entrypoint if needed:

```bash
node skills/exa-search/scripts/exa-api.cjs --help
```

## Release checklist

### Before publishing

- [ ] Confirm each `skills/<name>/SKILL.md` has a matching `name`
- [ ] Confirm required frontmatter fields are present
- [ ] Keep executable code under `skills/<name>/scripts/`
- [ ] Keep supporting docs under `skills/<name>/references/`
- [ ] Run `gh skill publish . --dry-run`

### Publish

```bash
gh skill publish . --tag v1.0.0
```

### After publishing

- [ ] Check the GitHub release page
- [ ] Spot-check `gh skill install` commands
- [ ] Update README examples if the pinned version changes

## License

MIT
