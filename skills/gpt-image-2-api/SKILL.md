---
name: gpt-image-2-api
description: Generate and edit images with gpt-image-2 through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Use when the user asks to create images, edit reference images, create visual assets, illustrations, or image variations with a configurable API endpoint.
license: MIT
compatibility: Designed for Claude Code; requires Node.js and access to an OpenAI-compatible image API.
metadata:
  author: BenedictKing
  version: "1.3.0"
  user-invocable: "true"
allowed-tools: Bash Read Write
---
# gpt-image-2-api

## Purpose
Generate and edit images with gpt-image-2 through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Use when the user asks to create images, edit reference images, create visual assets, illustrations, or image variations with a configurable API endpoint.

## Environment Variables & API Key

Two ways to configure API settings (priority: environment variable > `.env`):

1. Environment variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and optional `OPENAI_IMAGE_*` overrides
2. `.env` file: Place in `.env`, can copy from `.env.example`

You can manage the `.env` file manually or through `skill-master env set`.

## Configuration

- `OPENAI_API_KEY`: API key for the third-party endpoint
- `OPENAI_BASE_URL`: OpenAI-compatible base URL, for example `http://127.0.0.1:3688/v1`
- `OPENAI_IMAGE_MODEL`: image model name, defaults to `gpt-image-2`
- `OPENAI_IMAGE_PROTOCOL`: `openai_images` or `openai_chat`, defaults to `openai_images`
- `OPENAI_IMAGE_SIZE`: image size, defaults to `1024x1024`
- `OPENAI_IMAGE_QUALITY`: optional image quality
- `OPENAI_IMAGE_N`: number of images (1-10), defaults to `1`
- `OPENAI_IMAGE_OUTPUT_FORMAT`: optional output format (`png`, `jpeg`, `webp`)
- `OPENAI_IMAGE_FORMAT`: legacy alias for `OPENAI_IMAGE_OUTPUT_FORMAT`
- `OPENAI_IMAGE_RESPONSE_FORMAT`: optional response format (`url`, `b64_json`)
- `OPENAI_IMAGE_BACKGROUND`: optional background (`transparent`, `opaque`, `auto`)
- `OPENAI_IMAGE_MODERATION`: optional moderation level (`low`, `auto`)
- `OPENAI_IMAGE_OUTPUT_COMPRESSION`: optional compression level `0`–`100` for `jpeg` / `webp`
- `OPENAI_IMAGE_PARTIAL_IMAGES`: optional streaming partial image count `0`–`3`
- `OPENAI_IMAGE_INPUT_FIDELITY`: optional edit fidelity (`high`, `low`)
- `OPENAI_IMAGE_STYLE`: optional generation style for `dall-e-3` (`vivid`, `natural`)
- `OPENAI_IMAGE_STREAM`: optional `openai_images` SSE toggle (`true`, `false`)
- `OPENAI_IMAGE_USER`: optional end-user identifier
- `OPENAI_IMAGE_EXTRA_JSON`: optional JSON object merged into the request body

## Workflow
1. Use `scripts/gpt-image-2-api.mjs` for text-to-image and image-edit requests.
2. If required `OPENAI_*` settings are not available from the current environment or this skill's `.env`, stop and tell the user which variables need to be configured.
3. `openai_images` generation uses `/images/generations` with JSON; `openai_images` editing uses `/images/edits` with `multipart/form-data`.
4. Use `OPENAI_IMAGE_PROTOCOL=openai_chat` only when the endpoint lacks `/images/*` support; it does not support `--mask`, `--background`, `--output-format`, or streaming image events.
5. Add one or more `--image <path>` arguments to edit/reference an input image.
6. Use `--mask <path>` or `--mask auto` only with `openai_images` edits.
7. Save generated files under the user requested output directory, or the current working directory when unspecified.
8. Report saved file paths and any API errors exactly.

## Available Scripts

- `scripts/gpt-image-2-api.mjs` — Sends a text prompt, optionally with input images, to the configured OpenAI-compatible endpoint and saves returned images.

## Generate Image

```bash
node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images --size 1024x1024 --n 1 --output-format png
```

Use `--base-url`, `--model`, `--protocol`, `--size`, `--quality`, `--n`, `--output-format`, `--background`, `--moderation`, `--response-format`, and `--extra-json` only when the user or endpoint requires overrides.

## Edit Image

```bash
node scripts/gpt-image-2-api.mjs --prompt "make the dog wear a red scarf" --image ./input.png --output ./edited-images
```

Multiple input images are supported by repeating `--image`. `--input` is accepted as an alias for `--image`.

Mask example for `openai_images`:

```bash
node scripts/gpt-image-2-api.mjs --protocol openai_images --prompt "replace the background" --image ./input.png --mask ./mask.png --output ./edited-images
```

Auto-mask example for `openai_images`:

```bash
node scripts/gpt-image-2-api.mjs --protocol openai_images --prompt "remove the background" --image ./input.png --mask auto --background transparent --output-format png --output ./edited-images
```

Fallback example when the endpoint only supports chat completions:

```bash
OPENAI_IMAGE_PROTOCOL=openai_chat node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images
```

## Parameters

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | yes | string | — | Text description for generation or edit |
| `model` | no | string | `gpt-image-2` | Image model name |
| `n` | no | integer | `1` | Number of images, range 1–10 |
| `size` | no | string | `1024x1024` | Output size passed through to the upstream endpoint |
| `quality` | no | string | endpoint default | `low`, `medium`, `high`, `auto` |
| `output-format` | no | string | endpoint default | `png`, `jpeg`, `webp` |
| `response-format` | no | string | endpoint default | `url`, `b64_json`; mainly for DALL·E-compatible responses |
| `background` | no | string | endpoint default | `transparent`, `opaque`, `auto` |
| `moderation` | no | string | endpoint default | `low`, `auto` |
| `output-compression` | no | integer | endpoint default | Compression 0–100 for `jpeg`/`webp` |
| `partial-images` | no | integer | endpoint default | Streaming partial image count `0`–`3` |
| `input-fidelity` | no | string | endpoint default | Edit fidelity: `high`, `low` |
| `style` | no | string | endpoint default | Generation style for `dall-e-3`: `vivid`, `natural` |
| `user` | no | string | — | End-user identifier |
| `format` | no | string | — | Legacy alias for `output-format` |

### Size Behavior

The script does not hard-validate `size`; values are passed through so OpenAI-compatible upstream endpoints can decide what they support.

For the Yunwu-compatible docs currently checked in this project:
- `/images/generations` documents `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, and `2160x3840`
- `/images/edits` currently documents the classic GPT image set: `auto`, `1024x1024`, `1536x1024`, `1024x1536`
- `dall-e-2` documents `256x256`, `512x512`, `1024x1024`
- `dall-e-3` documents `1024x1024`, `1792x1024`, `1024x1792`
- Chat-compatible fallbacks remain endpoint-specific

Because provider behavior may differ by endpoint and documentation may lag behind the implementation, this skill forwards `size` unchanged and lets the upstream API accept or reject it.

### Size Constraints

1. Max side length ≤ 3840px
2. Both sides must be multiples of 16px
3. Aspect ratio ≤ 3:1 (long/short)
4. Total pixels: min 655360, max 8294400
