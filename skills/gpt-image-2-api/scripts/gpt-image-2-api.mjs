#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseEnv(content) {
  const data = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

let cachedSkillEnv;

async function readSkillEnv() {
  if (cachedSkillEnv) return cachedSkillEnv;
  const envPath = path.join(__dirname, '..', '.env');
  if (!existsSync(envPath)) {
    cachedSkillEnv = {};
    return cachedSkillEnv;
  }
  cachedSkillEnv = parseEnv(await readFile(envPath, 'utf-8'));
  return cachedSkillEnv;
}

function readEnvValue(skillEnv, key) {
  return process.env[key] || skillEnv[key];
}

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const VALUE_ARGS = new Set([
  '--background',
  '--base-url',
  '--complexity',
  '--extra-json',
  '--frame-count',
  '--frame-duration-ms',
  '--format',
  '--image',
  '--input',
  '--input-fidelity',
  '--markup',
  '--mask',
  '--model',
  '--moderation',
  '--n',
  '--output',
  '--output-compression',
  '--output-format',
  '--prompt',
  '--protocol',
  '--quality',
  '--response-format',
  '--safety-identifier',
  '--size',
  '--svg-model',
  '--svg-reasoning',
  '--style',
  '--user',
]);

function collectPositionalPrompt() {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (VALUE_ARGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    values.push(arg);
  }
  return values.join(' ');
}

function readArgs(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function normalizeProtocol(value) {
  const normalized = String(value || 'openai_images').trim().toLowerCase().replace(/-/g, '_');
  if (['image', 'images', 'openai_images'].includes(normalized)) return 'openai_images';
  if (['chat', 'chat_completions', 'openai_chat'].includes(normalized)) return 'openai_chat';
  throw new Error(`Unsupported OPENAI_IMAGE_PROTOCOL: ${value}. Use openai_images or openai_chat.`);
}

function parseJsonObject(value, source) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return parsed;
}

// 流式会被部分上游按分片多次计费，且本脚本只保存最终图片，因此禁止任何流式参数。
const STREAMING_KEYS = ['stream', 'partial_images'];

function assertNoStreaming(params, source) {
  const found = STREAMING_KEYS.filter((key) => key in params);
  if (found.length > 0) {
    throw new Error(`${source} must not set ${found.join(', ')}: streaming is disabled (it may be billed per chunk)`);
  }
}

function endpointPath(protocol, operation) {
  if (protocol === 'openai_chat') return '/chat/completions';
  return operation === 'edit' ? '/images/edits' : '/images/generations';
}

function buildRequestBody({ protocol, model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, extraParams }) {
  if (protocol === 'openai_chat') {
    const content = [{ type: 'text', text: prompt }];
    for (const image of inputImages) {
      content.push({
        type: 'image_url',
        image_url: { url: image.dataUrl },
      });
    }

    const chatBody = {
      model,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
      ...extraParams,
    };
    if (n && n !== 1) chatBody.n = n;
    return chatBody;
  }

  const body = { model, prompt, n };
  if (size) body.size = size;
  if (quality) body.quality = quality;
  if (responseFormat) body.response_format = responseFormat;
  if (outputFormat) body.output_format = outputFormat;
  return { ...body, ...extraParams };
}

function buildMultipartBody({ model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, mask, markup, extraParams }) {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  if (size) form.set('size', size);
  if (quality) form.set('quality', quality);
  if (n) form.set('n', String(n));
  if (responseFormat) form.set('response_format', responseFormat);
  if (outputFormat) form.set('output_format', outputFormat);

  // 与 OpenAI 官方 SDK 一致：单图用 image，多图用 image[]
  const imageField = inputImages.length > 1 ? 'image[]' : 'image';
  for (const image of inputImages) {
    form.append(imageField, new Blob([image.bytes], { type: image.mimeType }), image.name);
  }

  if (mask) {
    if (mask === 'auto') {
      form.set('mask', 'auto');
    } else {
      form.set('mask', new Blob([mask.bytes], { type: mask.mimeType }), mask.name);
    }
  }

  if (markup) form.set('markup', new Blob([markup.bytes], { type: markup.mimeType }), markup.name);

  for (const [key, value] of Object.entries(extraParams)) {
    appendFormValue(form, key, value);
  }

  return form;
}

function appendFormValue(form, key, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(form, `${key}[]`, item);
    return;
  }
  if (typeof value === 'object') {
    form.set(key, JSON.stringify(value));
    return;
  }
  form.set(key, String(value));
}

function decodeDataUrl(value) {
  if (!value.startsWith('data:') || !value.includes(';base64,')) return undefined;
  const [header, data] = value.split(',', 2);
  const mimeType = header.replace(/^data:/, '').split(';', 1)[0] || 'image/png';
  return decodeBase64Image(data, mimeType);
}

function decodeBase64Image(base64, mimeType = 'image/png') {
  return {
    bytes: Buffer.from(base64, 'base64'),
    mimeType,
  };
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function readImageInput(filePath) {
  const resolvedPath = path.resolve(filePath);
  const bytes = await readFile(resolvedPath);
  const mimeType = mimeTypeForPath(resolvedPath);
  const base64 = bytes.toString('base64');
  return {
    name: path.basename(resolvedPath),
    mimeType,
    bytes,
    base64,
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}

function extractMarkdownImageUrl(text) {
  const match = text.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  return match?.[1];
}

function addImageUrl(value, images) {
  if (typeof value !== 'string' || !value) return;
  const decoded = decodeDataUrl(value);
  images.push(decoded || { url: value });
}

function addImageObject(value, images) {
  if (!value || typeof value !== 'object') return;
  const imageBase64 = value.b64_json || value.image_base64;
  if (typeof imageBase64 === 'string' && imageBase64) {
    const mimeType = value.mime_type || value.mimeType || mimeTypeForOutputFormat(value.output_format) || 'image/png';
    images.push(decodeBase64Image(imageBase64, mimeType));
  }
  if (typeof value.url === 'string') addImageUrl(value.url, images);
  if (value.image_url && typeof value.image_url.url === 'string') addImageUrl(value.image_url.url, images);
  if (typeof value.image_url === 'string') addImageUrl(value.image_url, images);
  if (value.image && typeof value.image === 'object') addImageObject(value.image, images);
}

function mimeTypeForOutputFormat(outputFormat) {
  if (!outputFormat) return undefined;
  return outputFormat === 'svg' ? 'image/svg+xml' : `image/${outputFormat}`;
}

function collectImages(protocol, payload) {
  if (protocol === 'openai_images') {
    const payloadMimeType = mimeTypeForOutputFormat(payload.output_format);
    return Array.isArray(payload.data)
      ? payload.data.flatMap((item) => {
          const images = [];
          addImageObject({ mime_type: payloadMimeType, ...item }, images);
          return images;
        })
      : [];
  }

  const message = Array.isArray(payload.choices) ? payload.choices[0]?.message : undefined;
  const images = [];
  if (!message || typeof message !== 'object') return images;
  if (typeof message.content === 'string') addImageUrl(extractMarkdownImageUrl(message.content), images);
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      addImageObject(part, images);
      if (part && typeof part.text === 'string') addImageUrl(extractMarkdownImageUrl(part.text), images);
    }
  }
  if (Array.isArray(message.images)) {
    for (const image of message.images) addImageObject(image, images);
  }
  return images;
}

function extractChatText(payload) {
  const message = Array.isArray(payload.choices) ? payload.choices[0]?.message : undefined;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';

  const texts = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (!['text', 'output_text'].includes(part.type)) continue;
    if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text.trim());
  }
  return texts.join('\n');
}

function summarizeNoImagePayload(protocol, payload) {
  const chatText = protocol === 'openai_chat' ? extractChatText(payload) : '';
  const summary = chatText || JSON.stringify(payload);
  return summary.length > 1000 ? `${summary.slice(0, 1000)}...` : summary;
}

async function resolveImageBytes(image) {
  if (image.bytes) return image;
  if (!image.url) throw new Error('Image response item has neither bytes nor url');
  const response = await fetch(image.url);
  if (!response.ok) throw new Error(`Failed to download image URL: HTTP ${response.status}`);
  const contentType = response.headers?.get?.('content-type') || 'image/png';
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: contentType.split(';', 1)[0].trim() || 'image/png',
  };
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg')) return '.jpg';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('svg') || normalized.includes('xml')) return '.svg';
  return '.bin';
}

function parseOptionalInt(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function buildExtraParams({ operation, background, moderation, outputCompression, outputFormat, inputFidelity, style, user, complexity, safetyIdentifier, frameCount, frameDurationMs, svgModel, svgReasoning }) {
  const extra = {};
  if (background) extra.background = background;
  if (moderation) extra.moderation = moderation;
  if (outputCompression !== undefined) extra.output_compression = outputCompression;
  if (outputFormat) extra.output_format = outputFormat;
  if (operation === 'edit' && inputFidelity) extra.input_fidelity = inputFidelity;
  if (operation === 'generate' && style) extra.style = style;
  if (user) extra.user = user;
  if (complexity) extra.complexity = complexity;
  if (safetyIdentifier) extra.safety_identifier = safetyIdentifier;
  if (frameCount !== undefined) extra.frame_count = frameCount;
  if (frameDurationMs !== undefined) extra.frame_duration_ms = frameDurationMs;
  if (svgModel || svgReasoning) {
    extra.svg = {};
    if (svgModel) extra.svg.model = svgModel;
    if (svgReasoning) extra.svg.reasoning = { effort: svgReasoning };
  }
  return extra;
}

function validateArgs({ protocol, operation, n, responseFormat, outputFormat, background, inputFidelity, style, hasMask, complexity, frameCount, frameDurationMs, svgModel, svgReasoning, markup }) {
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('--n must be an integer between 1 and 10');
  if (background && !['transparent', 'opaque', 'auto'].includes(background)) {
    throw new Error('--background must be one of: transparent, opaque, auto');
  }
  if (responseFormat && !['url', 'b64_json'].includes(responseFormat)) {
    throw new Error('--response-format must be url or b64_json');
  }
  if (outputFormat && !['png', 'jpeg', 'webp', 'gif', 'svg'].includes(outputFormat)) {
    throw new Error('--output-format must be one of: png, jpeg, webp, gif, svg');
  }
  if (complexity && !['low', 'medium', 'high'].includes(complexity)) {
    throw new Error('--complexity must be low, medium or high');
  }
  if (outputFormat === 'gif') {
    if (frameCount !== undefined && (frameCount < 2 || frameCount > 16)) throw new Error('--frame-count must be 2-16');
    if (frameDurationMs !== undefined && (frameDurationMs < 20 || frameDurationMs > 2000)) throw new Error('--frame-duration-ms must be 20-2000');
  } else if (frameCount !== undefined || frameDurationMs !== undefined) {
    throw new Error('--frame-count and --frame-duration-ms require --output-format gif');
  }
  if (svgModel || svgReasoning || outputFormat === 'svg') {
    if (operation !== 'generate') throw new Error('SVG output is only supported for generation, not edits');
    if (outputFormat !== 'svg') throw new Error('--svg-model and --svg-reasoning require --output-format svg');
    if (n !== 1) throw new Error('SVG output requires --n 1');
  }
  if (inputFidelity && !['high', 'low'].includes(inputFidelity)) {
    throw new Error('--input-fidelity must be high or low');
  }
  if (style && !['vivid', 'natural'].includes(style)) {
    throw new Error('--style must be vivid or natural');
  }
  if (background === 'transparent' && outputFormat && !['png', 'webp'].includes(outputFormat)) {
    throw new Error('transparent background requires --output-format to be png or webp');
  }
  if (protocol === 'openai_chat') {
    if (responseFormat) throw new Error('--response-format is not supported with openai_chat');
    if (outputFormat) throw new Error('--output-format is not supported with openai_chat');
    if (background) throw new Error('--background is not supported with openai_chat');
    if (inputFidelity) throw new Error('--input-fidelity is not supported with openai_chat');
    if (style) throw new Error('--style is not supported with openai_chat');
    if (hasMask) throw new Error('--mask is not supported with openai_chat');
    if (markup) throw new Error('--markup is not supported with openai_chat');
    if (complexity) throw new Error('--complexity is not supported with openai_chat');
    if (frameCount !== undefined || frameDurationMs !== undefined) throw new Error('GIF options are not supported with openai_chat');
    if (svgModel || svgReasoning) throw new Error('SVG options are not supported with openai_chat');
  }
}

function mergeExtraParams(baseParams, cliExtraParams) {
  return { ...baseParams, ...cliExtraParams };
}

function buildRequestOptions({ protocol, operation, apiKey, baseUrl, model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, mask, markup, extraParams }) {
  const endpoint = `${baseUrl}${endpointPath(protocol, operation)}`;
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (protocol === 'openai_images' && operation === 'edit') {
    return {
      url: endpoint,
      options: {
        method: 'POST',
        headers,
        body: buildMultipartBody({ model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, mask, markup, extraParams }),
      },
    };
  }

  headers['Content-Type'] = 'application/json';
  return {
    url: endpoint,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequestBody({ protocol, model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, extraParams })),
    },
  };
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Image API returned non-JSON response: ${text.slice(0, 1000)}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/gpt-image-2-api.mjs --prompt "image prompt" [--output ./out] [--size 1024x1024] [--n 1] [--output-format png|jpeg|webp|gif|svg] [--quality low|medium|high|xhigh|max|auto] [--protocol openai_images|openai_chat]
  node scripts/gpt-image-2-api.mjs --prompt "edit prompt" --image ./input.png [--image ./reference.png] [--mask ./mask.png|auto | --markup ./overlay.png] [--output ./out]

Options:
  --n <int>                   Number of images (1-10), defaults to 1
  --size <str>                Image size passed through to the upstream endpoint
  --quality <str>             Image quality: low, medium, high, xhigh, max, auto
  --complexity <str>          Planning effort (2.5/2.6): low, medium, high; defaults to high
  --response-format <str>     Legacy dall-e models only: url, b64_json
  --output-format <str>       Output format: png, jpeg, webp, gif, svg
  --frame-count <int>         GIF only: 2-16 frames, defaults to 9
  --frame-duration-ms <int>   GIF only: 20-2000 ms per frame, defaults to 200
  --svg-model <str>           SVG only: author model for output_format=svg
  --svg-reasoning <str>       SVG only: author reasoning effort, e.g. low, high, max
  --output-compression <int>  Compression level 0-100 for jpeg/webp
  --background <str>          Background: transparent, opaque, auto
  --moderation <str>          Moderation: low, auto
  --markup <path>             Edit only: transparent PNG annotation layer; mutually exclusive with --mask
  --input-fidelity <str>      Edit fidelity: high, low (gpt-image-1.5 / 1-mini; omit for gpt-image-2.x)
  --style <str>               Legacy dall-e-3 only: vivid, natural
  --safety-identifier <str>   End-user identifier (hash it); replaces deprecated --user
  --user <str>                Deprecated: use --safety-identifier
  --format <str>              Legacy alias kept for compatibility

Streaming is intentionally unsupported: some providers bill each streamed chunk.

Environment:
  OPENAI_API_KEY              API key for the OpenAI-compatible endpoint
  OPENAI_BASE_URL             Base URL, for example http://127.0.0.1:3688/v1
  OPENAI_IMAGE_MODEL          Image model, defaults to gpt-image-2.6 (provider alias;
                            official API names are gpt-image-2.6-sunburst / -flare)
  OPENAI_IMAGE_PROTOCOL       openai_images or openai_chat, defaults to openai_images
  OPENAI_IMAGE_SIZE           Image size, defaults to 1024x1024
  OPENAI_IMAGE_QUALITY        Optional image quality: low, medium, high, xhigh, max, auto
  OPENAI_IMAGE_COMPLEXITY     Optional planning effort: low, medium, high
  OPENAI_IMAGE_SAFETY_IDENTIFIER Optional end-user identifier; replaces OPENAI_IMAGE_USER
  OPENAI_IMAGE_N              Number of images (1-10), defaults to 1
  OPENAI_IMAGE_OUTPUT_FORMAT  Optional output format: png, jpeg, webp, gif, svg
  OPENAI_IMAGE_FORMAT         Legacy alias for OPENAI_IMAGE_OUTPUT_FORMAT
  OPENAI_IMAGE_FRAME_COUNT    Optional GIF frame count 2-16
  OPENAI_IMAGE_FRAME_DURATION_MS Optional GIF frame delay 20-2000 ms
  OPENAI_IMAGE_SVG_MODEL      Optional SVG author model
  OPENAI_IMAGE_SVG_REASONING  Optional SVG author reasoning effort
  OPENAI_IMAGE_MARKUP         Optional markup overlay path for edits
  OPENAI_IMAGE_RESPONSE_FORMAT Legacy dall-e models only: url, b64_json
  OPENAI_IMAGE_BACKGROUND     Optional background: transparent, opaque, auto
  OPENAI_IMAGE_MODERATION     Optional moderation: low, auto
  OPENAI_IMAGE_OUTPUT_COMPRESSION Optional compression 0-100 for jpeg/webp
  OPENAI_IMAGE_INPUT_FIDELITY Optional edit fidelity: high, low (omit for gpt-image-2.x)
  OPENAI_IMAGE_STYLE          Legacy dall-e-3 only: vivid, natural
  OPENAI_IMAGE_USER           Deprecated: use OPENAI_IMAGE_SAFETY_IDENTIFIER
  OPENAI_IMAGE_EXTRA_JSON     Optional JSON object merged into the request body
`);
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }

  const skillEnv = await readSkillEnv();

  const apiKey = readEnvValue(skillEnv, 'OPENAI_API_KEY');
  const baseUrl = readArg('--base-url', readEnvValue(skillEnv, 'OPENAI_BASE_URL') || 'http://127.0.0.1:3688/v1').replace(/\/+$/, '');
  const model = readArg('--model', readEnvValue(skillEnv, 'OPENAI_IMAGE_MODEL') || 'gpt-image-2.6');
  const protocol = normalizeProtocol(readArg('--protocol', readEnvValue(skillEnv, 'OPENAI_IMAGE_PROTOCOL') || 'openai_images'));
  const prompt = readArg('--prompt', collectPositionalPrompt()).trim();
  const size = readArg('--size', readEnvValue(skillEnv, 'OPENAI_IMAGE_SIZE') || '1024x1024');
  const quality = readArg('--quality', readEnvValue(skillEnv, 'OPENAI_IMAGE_QUALITY'));
  const n = parseInt(readArg('--n', readEnvValue(skillEnv, 'OPENAI_IMAGE_N') || '1'), 10);
  const legacyFormat = readArg('--format', readEnvValue(skillEnv, 'OPENAI_IMAGE_FORMAT'));
  const responseFormat = readArg('--response-format', readEnvValue(skillEnv, 'OPENAI_IMAGE_RESPONSE_FORMAT'));
  const outputFormat = readArg('--output-format', readEnvValue(skillEnv, 'OPENAI_IMAGE_OUTPUT_FORMAT') || legacyFormat);
  const background = readArg('--background', readEnvValue(skillEnv, 'OPENAI_IMAGE_BACKGROUND'));
  const moderation = readArg('--moderation', readEnvValue(skillEnv, 'OPENAI_IMAGE_MODERATION'));
  const outputCompression = parseOptionalInt(readArg('--output-compression', readEnvValue(skillEnv, 'OPENAI_IMAGE_OUTPUT_COMPRESSION')), '--output-compression');
  const inputFidelity = readArg('--input-fidelity', readEnvValue(skillEnv, 'OPENAI_IMAGE_INPUT_FIDELITY'));
  const style = readArg('--style', readEnvValue(skillEnv, 'OPENAI_IMAGE_STYLE'));
  const complexity = readArg('--complexity', readEnvValue(skillEnv, 'OPENAI_IMAGE_COMPLEXITY'));
  const safetyIdentifier = readArg('--safety-identifier', readEnvValue(skillEnv, 'OPENAI_IMAGE_SAFETY_IDENTIFIER'));
  const frameCount = parseOptionalInt(readArg('--frame-count', readEnvValue(skillEnv, 'OPENAI_IMAGE_FRAME_COUNT')), '--frame-count');
  const frameDurationMs = parseOptionalInt(readArg('--frame-duration-ms', readEnvValue(skillEnv, 'OPENAI_IMAGE_FRAME_DURATION_MS')), '--frame-duration-ms');
  const svgModel = readArg('--svg-model', readEnvValue(skillEnv, 'OPENAI_IMAGE_SVG_MODEL'));
  const svgReasoning = readArg('--svg-reasoning', readEnvValue(skillEnv, 'OPENAI_IMAGE_SVG_REASONING'));
  const user = readArg('--user', readEnvValue(skillEnv, 'OPENAI_IMAGE_USER'));
  const cliExtraParams = parseJsonObject(readArg('--extra-json', readEnvValue(skillEnv, 'OPENAI_IMAGE_EXTRA_JSON')), 'OPENAI_IMAGE_EXTRA_JSON');
  assertNoStreaming(cliExtraParams, '--extra-json / OPENAI_IMAGE_EXTRA_JSON');
  const outputDir = path.resolve(readArg('--output', process.cwd()));
  const imagePaths = [...readArgs('--image'), ...readArgs('--input')];
  const inputImages = await Promise.all(imagePaths.map(readImageInput));
  const maskValue = readArg('--mask');
  const mask = maskValue && maskValue !== 'auto' ? await readImageInput(maskValue) : maskValue;
  const markupPath = readArg('--markup', readEnvValue(skillEnv, 'OPENAI_IMAGE_MARKUP'));
  const markup = markupPath ? await readImageInput(markupPath) : undefined;
  const operation = inputImages.length > 0 ? 'edit' : 'generate';

  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!prompt) throw new Error('Prompt is required. Use --prompt "..."');
  if (mask && operation !== 'edit') throw new Error('--mask requires at least one --image');
  if (markup && operation !== 'edit') throw new Error('--markup requires at least one --image');
  if (markup && mask) throw new Error('--markup and --mask are mutually exclusive');

  validateArgs({ protocol, operation, n, responseFormat, outputFormat, background, inputFidelity, style, hasMask: Boolean(maskValue), markup, complexity, frameCount, frameDurationMs, svgModel, svgReasoning });

  const baseExtraParams = buildExtraParams({
    operation,
    background,
    moderation,
    outputCompression,
    outputFormat,
    inputFidelity,
    style,
    user,
    complexity,
    safetyIdentifier,
    frameCount,
    frameDurationMs,
    svgModel,
    svgReasoning,
  });
  const extraParams = mergeExtraParams(baseExtraParams, cliExtraParams);
  const { url, options } = buildRequestOptions({
    protocol,
    operation,
    apiKey,
    baseUrl,
    model,
    prompt,
    size,
    quality,
    n,
    responseFormat,
    outputFormat,
    inputImages,
    mask,
    markup,
    extraParams,
  });

  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Image API failed with HTTP ${response.status}: ${text}`);
  }

  const payload = parsePayload(text);
  await mkdir(outputDir, { recursive: true });
  const saved = [];
  const images = collectImages(protocol, payload);

  for (const [index, image] of images.entries()) {
    const resolved = await resolveImageBytes(image);
    const filePath = path.join(outputDir, `gpt-image-2-${Date.now()}-${index + 1}${extensionForMimeType(resolved.mimeType)}`);
    await writeFile(filePath, resolved.bytes);
    saved.push(filePath);
  }

  if (saved.length === 0) {
    throw new Error(`Image API response returned no image for ${protocol}. Upstream response: ${summarizeNoImagePayload(protocol, payload)}`);
  }

  console.log(JSON.stringify({ files: saved }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
