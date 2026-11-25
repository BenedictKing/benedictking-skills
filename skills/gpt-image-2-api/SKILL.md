---
name: gpt-image-2-api
description: Generate and edit images with gpt-image-2 family models (gpt-image-2 / 2.5 / 2.6, defaulting to gpt-image-2.6) through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Never uses streaming. Use when the user asks to create images, edit reference images, create visual assets, illustrations, or image variations with a configurable API endpoint.
license: MIT
compatibility: Designed for Claude Code; requires Node.js and access to an OpenAI-compatible image API.
metadata:
  author: BenedictKing
  version: "1.5.0"
  user-invocable: "true"
allowed-tools: Bash Read Write
---
# gpt-image-2-api

## Purpose
Generate and edit images with gpt-image-2 family models (gpt-image-2 / 2.5 / 2.6, defaulting to gpt-image-2.6) through a third-party OpenAI-compatible API using .env-configured OPENAI_API_KEY and OPENAI_BASE_URL values. Never uses streaming. Use when the user asks to create images, edit reference images, create visual assets, illustrations, or image variations with a configurable API endpoint.

## Environment Variables & API Key

Two ways to configure API settings (priority: environment variable > `.env`):

1. Environment variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and optional `OPENAI_IMAGE_*` overrides
2. `.env` file: Place in `.env`, can copy from `.env.example`

You can manage the `.env` file manually or through `skill-master env set`.

## Configuration

- `OPENAI_API_KEY`: API key for the third-party endpoint
- `OPENAI_BASE_URL`: OpenAI-compatible base URL, for example `http://127.0.0.1:3688/v1`
- `OPENAI_IMAGE_MODEL`: image model name, defaults to `gpt-image-2.6` (see [Models](#models))
- `OPENAI_IMAGE_PROTOCOL`: `openai_images` or `openai_chat`, defaults to `openai_images`
- `OPENAI_IMAGE_SIZE`: image size, defaults to `1024x1024`
- `OPENAI_IMAGE_QUALITY`: optional image quality (`low`, `medium`, `high`, `xhigh`, `max`, `auto`; `xhigh` / `max` need 2.5 or 2.6)
- `OPENAI_IMAGE_COMPLEXITY`: optional planning effort `low` / `medium` / `high`, separate from quality; 2.5/2.6 default to `high`
- `OPENAI_IMAGE_SAFETY_IDENTIFIER`: optional end-user identifier (hash it), replaces deprecated `OPENAI_IMAGE_USER`
- `OPENAI_IMAGE_N`: number of images (1-10), defaults to `1`
- `OPENAI_IMAGE_OUTPUT_FORMAT`: optional output format (`png`, `jpeg`, `webp`, `gif`, `svg`)
- `OPENAI_IMAGE_FRAME_COUNT` / `OPENAI_IMAGE_FRAME_DURATION_MS`: GIF only, 2–16 frames and 20–2000 ms per frame
- `OPENAI_IMAGE_SVG_MODEL` / `OPENAI_IMAGE_SVG_REASONING`: optional SVG author model and reasoning effort
- `OPENAI_IMAGE_MARKUP`: optional transparent PNG annotation layer path for edits
- `OPENAI_IMAGE_FORMAT`: legacy alias for `OPENAI_IMAGE_OUTPUT_FORMAT`
- `OPENAI_IMAGE_RESPONSE_FORMAT`: legacy `dall-e-*` only (`url`, `b64_json`); GPT image models always return base64
- `OPENAI_IMAGE_BACKGROUND`: optional background (`transparent`, `opaque`, `auto`)
- `OPENAI_IMAGE_MODERATION`: optional moderation level (`low`, `auto`)
- `OPENAI_IMAGE_OUTPUT_COMPRESSION`: optional compression level `0`–`100` for `jpeg` / `webp`
- `OPENAI_IMAGE_INPUT_FIDELITY`: optional edit fidelity (`high`, `low`); for `gpt-image-1.5` / `gpt-image-1-mini` only, omit for `gpt-image-2.x`
- `OPENAI_IMAGE_STYLE`: legacy `dall-e-3` only (`vivid`, `natural`); unsupported for GPT image models
- `OPENAI_IMAGE_USER`: deprecated, use `OPENAI_IMAGE_SAFETY_IDENTIFIER`
- `OPENAI_IMAGE_EXTRA_JSON`: optional JSON object merged into the request body (must not contain `stream` or `partial_images`)

## Models

| Model | Notes |
|-------|-------|
| `gpt-image-2.6` | Default. **Provider alias**, not an official OpenAI model id. Latest generation |
| `gpt-image-2.6-flare` / `gpt-image-2.6-sunburst` | Official ids. Flare = fast iteration, Sunburst = precise / detailed edits. Official `/images/edits` default is `gpt-image-2.6-sunburst` |
| `gpt-image-2.5` | **Provider alias**. Previous generation |
| `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | Official ids, each also has a `-2026-09-08` snapshot |
| `gpt-image-2` | Official id, also `gpt-image-2-2026-04-21` |
| `nano-banana-pro` / `nano-banana-2.1` | Google models on some OpenAI-compatible gateways; if `/images/*` rejects them, retry with `--protocol openai_chat` |

Model availability depends on the configured endpoint. Pass `--model` or set `OPENAI_IMAGE_MODEL` to switch.

Against the official OpenAI API, bare names such as `gpt-image-2.6` / `gpt-image-2.5` are not valid: set `OPENAI_IMAGE_MODEL=gpt-image-2.6-sunburst` (or `-flare`). `gpt-image-1` was shut down on 2026-10-23. `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest`, `dall-e-2` and `dall-e-3` also exist upstream.

Parameter notes from the official docs (verify against your gateway before relying on them):
- `quality` `xhigh` / `max` and `complexity` apply to 2.5/2.6 Sunburst and Flare; omitting `complexity` means `high`, with no separate fee.
- `--mask auto` is a gateway extension; the official API expects a mask file upload or a `{image_url | file_id}` object.
- `/images/edits` also accepts a JSON body with `images: [{image_url | file_id}]` (up to 16 images); this script uses multipart uploads, which remain supported.

## No Streaming

Streaming is intentionally unsupported. Some providers bill each streamed chunk as a separate request, and this script only saves the final image anyway. The script never sends `stream` / `partial_images`, and rejects them if they appear in `--extra-json` or `OPENAI_IMAGE_EXTRA_JSON`. Do not work around this with raw `curl` calls that set `stream: true`.

## Workflow
1. Use `scripts/gpt-image-2-api.mjs` for text-to-image and image-edit requests.
2. If required `OPENAI_*` settings are not available from the current environment or this skill's `.env`, stop and tell the user which variables need to be configured.
3. `openai_images` generation uses `/images/generations` with JSON; `openai_images` editing uses `/images/edits` with `multipart/form-data`.
4. Use `OPENAI_IMAGE_PROTOCOL=openai_chat` only when the endpoint lacks `/images/*` support; it does not support `--mask`, `--markup`, `--background`, `--output-format`, `--complexity`, or GIF/SVG options.
5. Add one or more `--image <path>` arguments to edit/reference an input image.
6. Use `--mask <path>`, `--mask auto`, or `--markup <path>` only with `openai_images` edits. `--mask` and `--markup` are mutually exclusive.
7. Save generated files under the user requested output directory, or the current working directory when unspecified.
8. Report saved file paths and any API errors exactly.

## Available Scripts

- `scripts/gpt-image-2-api.mjs` — Sends a text prompt, optionally with input images, to the configured OpenAI-compatible endpoint and saves returned images.

## Generate Image

```bash
node scripts/gpt-image-2-api.mjs --prompt "a concise image prompt" --output ./generated-images --size 1024x1024 --n 1 --output-format png
```

Use `--base-url`, `--model`, `--protocol`, `--size`, `--quality`, `--n`, `--output-format`, `--background`, `--moderation`, `--response-format`, and `--extra-json` only when the user or endpoint requires overrides.

## GIF / SVG Output

Gateway support for these is unverified; expect the upstream to reject them if it has not caught up.

```bash
node scripts/gpt-image-2-api.mjs --prompt "a lantern swinging in the wind, looping" --output-format gif --frame-count 9 --frame-duration-ms 200 --output ./generated-images
node scripts/gpt-image-2-api.mjs --prompt "a flat bakery logo" --output-format svg --n 1 --output ./generated-images
```

`svg` is generation-only and requires `--n 1`; the saved file is `.svg`. GIF output needs no streaming.

Markup-guided edit (2.5/2.6): a transparent PNG annotation layer over the **first** input image, same dimensions, not flattened into it.

```bash
node scripts/gpt-image-2-api.mjs --prompt "recolor the circled vase" --image ./kitchen.png --markup ./overlay.png --output ./edited-images
```

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
| `model` | no | string | `gpt-image-2.6` | Image model name |
| `n` | no | integer | `1` | Number of images, range 1–10 |
| `size` | no | string | `1024x1024` | Output size passed through to the upstream endpoint |
| `quality` | no | string | endpoint default | `low`, `medium`, `high`, `xhigh`, `max`, `auto`; `xhigh`/`max` need 2.5/2.6 |
| `complexity` | no | string | `high` on 2.5/2.6 | Planning effort: `low`, `medium`, `high` |
| `output-format` | no | string | endpoint default | `png`, `jpeg`, `webp`, `gif`, `svg` |
| `frame-count` | no | integer | `9` | GIF only: 2–16 frames |
| `frame-duration-ms` | no | integer | `200` | GIF only: 20–2000 ms per frame |
| `svg-model` | no | string | — | SVG only: author model |
| `svg-reasoning` | no | string | — | SVG only: author reasoning effort |
| `markup` | no | path | — | Edits only: transparent PNG annotation layer over the first input image, same dimensions; mutually exclusive with `mask` |
| `safety-identifier` | no | string | — | Hashed end-user identifier, replaces `user` |
| `response-format` | no | string | endpoint default | Legacy `dall-e-*` only: `url`, `b64_json` |
| `background` | no | string | endpoint default | `transparent`, `opaque`, `auto` |
| `moderation` | no | string | endpoint default | `low`, `auto` |
| `output-compression` | no | integer | endpoint default | Compression 0–100 for `jpeg`/`webp` |
| `input-fidelity` | no | string | endpoint default | `gpt-image-1.5` / `1-mini` only: `high`, `low`; omit for 2.x |
| `style` | no | string | endpoint default | Legacy `dall-e-3` only: `vivid`, `natural` |
| `user` | no | string | — | Deprecated, use `safety-identifier` |
| `format` | no | string | — | Legacy alias for `output-format` |

### Size Behavior

Official limits match the Size Constraints below; resolutions above `2560x1440` are experimental.

The script does not hard-validate `size`; values are passed through so OpenAI-compatible upstream endpoints can decide what they support.

For the Yunwu-compatible docs currently checked in this project:
- `/images/generations` documents `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, and `2160x3840`
- `/images/edits` accepts the same arbitrary `WIDTHxHEIGHT` strings as generation on 2.x models
- `dall-e-2` documents `256x256`, `512x512`, `1024x1024`
- `dall-e-3` documents `1024x1024`, `1792x1024`, `1024x1792`
- Chat-compatible fallbacks remain endpoint-specific

Because provider behavior may differ by endpoint and documentation may lag behind the implementation, this skill forwards `size` unchanged and lets the upstream API accept or reject it.

### Size Constraints

1. Max side length ≤ 3840px
2. Both sides must be multiples of 16px
3. Aspect ratio ≤ 3:1 (long/short)
4. Total pixels: min 655360, max 8294400
