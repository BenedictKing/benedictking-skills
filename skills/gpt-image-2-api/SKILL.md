---
name: gpt-image-2-api
description: Generate images with gpt-image-2 through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Use when the user asks to create images, visual assets, illustrations, or image variations with a configurable API endpoint.
license: MIT
allowed-tools: Bash Read Write
---
# gpt-image-2-api

## Purpose
Generate images with gpt-image-2 through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Use when the user asks to create images, visual assets, illustrations, or image variations with a configurable API endpoint.

## Configuration
Require `.env` values managed by `skill-master env set`:

- `OPENAI_API_KEY`: API key for the third-party endpoint
- `OPENAI_BASE_URL`: OpenAI-compatible base URL, for example `http://127.0.0.1:3688/v1`
- `OPENAI_IMAGE_MODEL`: image model name, defaults to `gpt-image-2`
- `OPENAI_IMAGE_PROTOCOL`: `openai_images` or `openai_chat`, defaults to `openai_images`
- `OPENAI_IMAGE_SIZE`: image size for `openai_images`, defaults to `1024x1024`
- `OPENAI_IMAGE_QUALITY`: optional image quality for `openai_images`
- `OPENAI_IMAGE_EXTRA_JSON`: optional JSON object merged into the request body

## Workflow
1. Confirm `.env` is configured before making API calls.
2. Use `scripts/gpt-image-2-api.mjs` for text-to-image requests.
3. Use `OPENAI_IMAGE_PROTOCOL=openai_images` for `/images/generations`; use `OPENAI_IMAGE_PROTOCOL=openai_chat` for `/chat/completions`.
4. Save generated files under the user requested output directory, or the current working directory when unspecified.
5. Report saved file paths and any API errors exactly.

## Available Scripts

- `scripts/gpt-image-2-api.mjs` — Sends a text prompt to the configured OpenAI-compatible image generation endpoint and saves returned images.

## Generate Image

```bash
node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images --size 1024x1024
```

Use `--base-url`, `--model`, `--protocol`, `--size`, `--quality`, and `--extra-json` only when the user or endpoint requires overrides.

```bash
OPENAI_IMAGE_PROTOCOL=openai_chat node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images
```
