---
name: gpt-image-2-api
description: Generate and edit images with gpt-image-2 through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Use when the user asks to create images, edit reference images, create visual assets, illustrations, or image variations with a configurable API endpoint.
license: MIT
compatibility: Designed for Claude Code; requires Node.js and access to an OpenAI-compatible image API.
metadata:
  author: BenedictKing
  version: "1.1.1"
  user-invocable: "true"
allowed-tools: Bash Read Write
---
# gpt-image-2-api

## Purpose
Generate and edit images with gpt-image-2 through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Use when the user asks to create images, edit reference images, create visual assets, illustrations, or image variations with a configurable API endpoint.

## Configuration
Require `.env` values managed by `skill-master env set`:

- `OPENAI_API_KEY`: API key for the third-party endpoint
- `OPENAI_BASE_URL`: OpenAI-compatible base URL, for example `http://127.0.0.1:3688/v1`
- `OPENAI_IMAGE_MODEL`: image model name, defaults to `gpt-image-2`
- `OPENAI_IMAGE_PROTOCOL`: `openai_images` or `openai_chat`, defaults to `openai_images`
- `OPENAI_IMAGE_SIZE`: image size for `openai_images`, defaults to `1024x1024`
- `OPENAI_IMAGE_QUALITY`: optional image quality for `openai_images`
- `OPENAI_IMAGE_N`: number of images (1-10), defaults to `1`
- `OPENAI_IMAGE_FORMAT`: optional image format (`png`, `jpeg`, `webp`)
- `OPENAI_IMAGE_EXTRA_JSON`: optional JSON object merged into the request body

## Workflow
1. Confirm `.env` is configured before making API calls.
2. Use `scripts/gpt-image-2-api.mjs` for text-to-image and image-edit requests.
3. Use `OPENAI_IMAGE_PROTOCOL=openai_images` for `/images/generations`; use `OPENAI_IMAGE_PROTOCOL=openai_chat` for `/chat/completions`.
4. Add one or more `--image <path>` arguments to edit/reference an input image.
5. Use `--mask <path>` only with `openai_images`; `openai_chat` does not support masks.
6. Save generated files under the user requested output directory, or the current working directory when unspecified.
7. Report saved file paths and any API errors exactly.

## Available Scripts

- `scripts/gpt-image-2-api.mjs` — Sends a text prompt, optionally with input images, to the configured OpenAI-compatible endpoint and saves returned images.

## Generate Image

```bash
node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images --size 1024x1024 --n 1
```

Use `--base-url`, `--model`, `--protocol`, `--size`, `--quality`, `--n`, `--format`, and `--extra-json` only when the user or endpoint requires overrides.

## Edit Image

```bash
node scripts/gpt-image-2-api.mjs --prompt "make the dog wear a red scarf" --image ./input.png --output ./edited-images
```

Multiple input images are supported by repeating `--image`. `--input` is accepted as an alias for `--image`.

Mask example for `openai_images`:

```bash
node scripts/gpt-image-2-api.mjs --protocol openai_images --prompt "replace the background" --image ./input.png --mask ./mask.png --output ./edited-images
```

```bash
OPENAI_IMAGE_PROTOCOL=openai_chat node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images
```

## Parameters

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | yes | string | — | Text description, max 1000 characters |
| `model` | yes | string | `gpt-image-2` | Model name |
| `n` | yes | integer | `1` | Number of images, range 1–10 |
| `size` | no | string | `1024x1024` | See [valid sizes](#valid-sizes) |
| `quality` | no | string | `auto` | `low`, `medium`, `high`, `auto` |
| `format` | no | string | — | `png`, `jpeg`, `webp` |

### Valid Sizes

| Size | Resolution |
|------|------------|
| `1024x1024` | Square (default) |
| `1536x1024` | Landscape |
| `1024x1536` | Portrait |
| `2048x2048` | 2K Square |
| `2048x1152` | 2K Landscape |
| `3840x2160` | 4K Landscape |
| `2160x3840` | 4K Portrait |
| `auto` | Auto-determined |

### Size Constraints

1. Max side length ≤ 3840px
2. Both sides must be multiples of 16px
3. Aspect ratio ≤ 3:1 (long/short)
4. Total pixels: min 655360, max 8294400
