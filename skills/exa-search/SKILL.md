---
name: exa-search
description: Use this skill when users need semantic web search, similar-page discovery, result content retrieval, research-paper lookup, GitHub discovery, or structured Exa-powered research.
license: MIT
compatibility: Designed for Claude Code; requires Node.js and network access to the Exa API.
metadata:
  author: BenedictKing
  version: "1.0.1"
  user-invocable: "true"
allowed-tools: Bash Read
---

# Exa Search Skill

## Trigger Conditions & Endpoint Selection

Choose Exa endpoint based on user intent:

- **search**: Need semantic search / find web pages / research topics
- **contents**: Given result IDs, need to extract full content
- **findsimilar**: Given URL, need to find similar pages
- **answer**: Need direct answer to a question
- **research**: Need structured research output following given `output_schema`

## Recommended Architecture (Main Skill + Sub-skill)

This skill uses a two-phase architecture:

1. **Main skill (current context)**: Understand user question → Choose endpoint → Assemble JSON payload
2. **Sub-skill (fork context)**: Only responsible for HTTP call execution, avoiding conversation history token waste

## Execution Method

Use Task tool to invoke `exa-fetcher` sub-skill, passing command and JSON (stdin):

```
Task parameters:
- subagent_type: Bash
- description: "Call Exa API"
- prompt: cat <<'JSON' | node scripts/exa-api.cjs <search|contents|findsimilar|answer|research>
  { ...payload... }
  JSON
```

## Payload Examples

### 1) Search

```bash
cat <<'JSON' | node scripts/exa-api.cjs search
{
  "query": "Latest research in LLMs",
  "type": "auto",
  "numResults": 10,
  "category": "research paper",
  "includeDomains": [],
  "excludeDomains": [],
  "startPublishedDate": "2025-01-01",
  "endPublishedDate": "2025-12-31",
  "includeText": [],
  "excludeText": [],
  "context": true,
  "contents": {
    "text": true,
    "highlights": true,
    "summary": true
  }
}
JSON
```

**Search Types:**
- `neural`: Semantic search using embeddings
- `fast`: Quick keyword-based search
- `auto`: Automatically choose best method (default)
- `deep`: Comprehensive deep search

**Categories:**
- `company`, `people`, `research paper`, `news`, `pdf`, `github`, `tweet`, etc.

### 2) Contents

```bash
cat <<'JSON' | node scripts/exa-api.cjs contents
{
  "ids": ["result-id-1", "result-id-2"],
  "text": true,
  "highlights": true,
  "summary": true
}
JSON
```

### 3) Find Similar

```bash
cat <<'JSON' | node scripts/exa-api.cjs findsimilar
{
  "url": "https://example.com/article",
  "numResults": 10,
  "category": "news",
  "includeDomains": [],
  "excludeDomains": [],
  "startPublishedDate": "2025-01-01",
  "contents": {
    "text": true,
    "summary": true
  }
}
JSON
```

### 4) Answer

```bash
cat <<'JSON' | node scripts/exa-api.cjs answer
{
  "query": "What is the capital of France?",
  "numResults": 5,
  "includeDomains": [],
  "excludeDomains": []
}
JSON
```

### 5) Research

```bash
cat <<'JSON' | node scripts/exa-api.cjs research
{
  "input": "What are the latest developments in AI?",
  "model": "auto",
  "stream": false,
  "output_schema": {
    "properties": {
      "topic": {
        "type": "string",
        "description": "The main topic"
      },
      "key_findings": {
        "type": "array",
        "description": "List of key findings",
        "items": {
          "type": "string"
        }
      }
    },
    "required": ["topic"]
  },
  "citation_format": "numbered"
}
JSON
```

## Environment Variables & API Key

Two ways to configure API Key (priority: environment variable > `.env`):

1. Environment variable: `EXA_API_KEY`
2. `.env` file: Place in `.env`, can copy from `.env.example`

## Response Format

All endpoints return JSON with:
- `requestId`: Unique request identifier
- `results`: Array of search results
- `searchType`: Type of search performed (for search endpoint)
- `context`: LLM-friendly context string (if requested)
- `costDollars`: Detailed cost breakdown
