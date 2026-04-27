#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');

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

async function loadSkillEnv() {
  const envPath = path.join(skillRoot, '.env');
  if (!existsSync(envPath)) return;
  const values = parseEnv(await readFile(envPath, 'utf-8'));
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
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
  '--extra-json',
  '--format',
  '--image',
  '--input',
  '--input-fidelity',
  '--mask',
  '--model',
  '--moderation',
  '--n',
  '--output',
  '--output-compression',
  '--output-format',
  '--partial-images',
  '--prompt',
  '--protocol',
  '--quality',
  '--response-format',
  '--size',
  '--stream',
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

function buildMultipartBody({ model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, mask, extraParams }) {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  if (size) form.set('size', size);
  if (quality) form.set('quality', quality);
  if (n) form.set('n', String(n));
  if (responseFormat) form.set('response_format', responseFormat);
  if (outputFormat) form.set('output_format', outputFormat);

  for (const image of inputImages) {
    form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.name);
  }

  if (mask) {
    if (mask === 'auto') {
      form.set('mask', 'auto');
    } else {
      form.set('mask', new Blob([mask.bytes], { type: mask.mimeType }), mask.name);
    }
  }

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

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
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
    images.push(decodeBase64Image(imageBase64, value.mime_type || value.mimeType || 'image/png'));
  }
  if (typeof value.url === 'string') addImageUrl(value.url, images);
  if (value.image_url && typeof value.image_url.url === 'string') addImageUrl(value.image_url.url, images);
  if (typeof value.image_url === 'string') addImageUrl(value.image_url, images);
  if (value.image && typeof value.image === 'object') addImageObject(value.image, images);
}

function collectImages(protocol, payload) {
  if (protocol === 'openai_images') {
    return Array.isArray(payload.data)
      ? payload.data.flatMap((item) => {
          const images = [];
          addImageObject(item, images);
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
  return '.bin';
}

function parseOptionalInt(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function buildExtraParams({ operation, background, moderation, outputCompression, outputFormat, partialImages, inputFidelity, style, user }) {
  const extra = {};
  if (background) extra.background = background;
  if (moderation) extra.moderation = moderation;
  if (outputCompression !== undefined) extra.output_compression = outputCompression;
  if (outputFormat) extra.output_format = outputFormat;
  if (partialImages !== undefined) extra.partial_images = partialImages;
  if (operation === 'edit' && inputFidelity) extra.input_fidelity = inputFidelity;
  if (operation === 'generate' && style) extra.style = style;
  if (user) extra.user = user;
  return extra;
}

function validateArgs({ protocol, operation, n, responseFormat, outputFormat, background, partialImages, size, inputFidelity, style, stream, hasMask }) {
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('--n must be an integer between 1 and 10');
  if (background && !['transparent', 'opaque', 'auto'].includes(background)) {
    throw new Error('--background must be one of: transparent, opaque, auto');
  }
  if (responseFormat && !['url', 'b64_json'].includes(responseFormat)) {
    throw new Error('--response-format must be url or b64_json');
  }
  if (outputFormat && !['png', 'jpeg', 'webp'].includes(outputFormat)) {
    throw new Error('--output-format must be one of: png, jpeg, webp');
  }
  if (partialImages !== undefined && (partialImages < 0 || partialImages > 3)) {
    throw new Error('--partial-images must be an integer between 0 and 3');
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
    if (partialImages !== undefined) throw new Error('--partial-images is not supported with openai_chat');
    if (inputFidelity) throw new Error('--input-fidelity is not supported with openai_chat');
    if (style) throw new Error('--style is not supported with openai_chat');
    if (stream !== undefined) throw new Error('--stream is not supported with openai_chat');
    if (hasMask) throw new Error('--mask is not supported with openai_chat');
  }
  if (operation === 'edit' && size && !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(size)) {
    throw new Error('image edits only support --size auto, 1024x1024, 1536x1024, or 1024x1536');
  }
}

function mergeExtraParams(baseParams, cliExtraParams) {
  return { ...baseParams, ...cliExtraParams };
}

function buildRequestOptions({ protocol, operation, apiKey, baseUrl, model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, mask, extraParams }) {
  const endpoint = `${baseUrl}${endpointPath(protocol, operation)}`;
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (protocol === 'openai_images' && operation === 'edit') {
    return {
      url: endpoint,
      options: {
        method: 'POST',
        headers,
        body: buildMultipartBody({ model, prompt, size, quality, n, responseFormat, outputFormat, inputImages, mask, extraParams }),
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

function parseSseEvents(text) {
  const events = [];
  for (const chunk of text.split(/\n\n+/)) {
    const lines = chunk.split('\n');
    const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join('\n');
    if (!dataText || dataText === '[DONE]') continue;
    try {
      events.push(JSON.parse(dataText));
    } catch {
      continue;
    }
  }
  return events;
}

function normalizePayload(protocol, operation, text) {
  try {
    return JSON.parse(text);
  } catch {
    if (protocol !== 'openai_images') {
      throw new Error(`Image API returned non-JSON response: ${text.slice(0, 1000)}`);
    }
    const events = parseSseEvents(text);
    const finalEvent = [...events].reverse().find((event) => typeof event?.b64_json === 'string');
    if (!finalEvent) throw new Error(`Image API returned non-JSON response: ${text.slice(0, 1000)}`);
    const kind = operation === 'edit' ? 'image_edit' : 'image_generation';
    return {
      data: [{ b64_json: finalEvent.b64_json, mime_type: finalEvent.output_format ? `image/${finalEvent.output_format}` : 'image/png' }],
      usage: finalEvent.usage,
      output_format: finalEvent.output_format,
      background: finalEvent.background,
      quality: finalEvent.quality,
      size: finalEvent.size,
      stream_event_type: `${kind}.completed`,
    };
  }
}
function printHelp() {
  console.log(`Usage:
  node scripts/gpt-image-2-api.mjs --prompt "image prompt" [--output ./out] [--size 1024x1024] [--n 1] [--output-format png|jpeg|webp] [--quality low|medium|high|auto] [--protocol openai_images|openai_chat]
  node scripts/gpt-image-2-api.mjs --prompt "edit prompt" --image ./input.png [--image ./reference.png] [--mask ./mask.png|auto] [--output ./out]

Options:
  --n <int>                   Number of images (1-10), defaults to 1
  --size <str>                Image size; edits support auto, 1024x1024, 1536x1024, 1024x1536
  --quality <str>             Image quality: low, medium, high, auto
  --response-format <str>     Response format: url, b64_json
  --output-format <str>       Output format: png, jpeg, webp
  --output-compression <int>  Compression level 0-100 for jpeg/webp
  --background <str>          Background: transparent, opaque, auto
  --moderation <str>          Moderation: low, auto
  --partial-images <int>      Streaming partial images count: 0-3
  --input-fidelity <str>      Edit fidelity: high, low
  --style <str>               Generation style for dall-e-3: vivid, natural
  --user <str>                End-user identifier for abuse monitoring
  --format <str>              Legacy alias kept for compatibility

Environment:
  OPENAI_API_KEY              API key for the OpenAI-compatible endpoint
  OPENAI_BASE_URL             Base URL, for example http://127.0.0.1:3688/v1
  OPENAI_IMAGE_MODEL          Image model, defaults to gpt-image-2
  OPENAI_IMAGE_PROTOCOL       openai_images or openai_chat, defaults to openai_images
  OPENAI_IMAGE_SIZE           Image size, defaults to 1024x1024
  OPENAI_IMAGE_QUALITY        Optional image quality
  OPENAI_IMAGE_N              Number of images (1-10), defaults to 1
  OPENAI_IMAGE_FORMAT         Legacy output format alias: png, jpeg, webp
  OPENAI_IMAGE_RESPONSE_FORMAT Optional response format: url, b64_json
  OPENAI_IMAGE_BACKGROUND     Optional background: transparent, opaque, auto
  OPENAI_IMAGE_MODERATION     Optional moderation: low, auto
  OPENAI_IMAGE_EXTRA_JSON     Optional JSON object merged into the request body
`);
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }

  await loadSkillEnv();

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = readArg('--base-url', process.env.OPENAI_BASE_URL || 'http://127.0.0.1:3688/v1').replace(/\/+$/, '');
  const model = readArg('--model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');
  const protocol = normalizeProtocol(readArg('--protocol', process.env.OPENAI_IMAGE_PROTOCOL || 'openai_images'));
  const prompt = readArg('--prompt', collectPositionalPrompt()).trim();
  const size = readArg('--size', process.env.OPENAI_IMAGE_SIZE || '1024x1024');
  const quality = readArg('--quality', process.env.OPENAI_IMAGE_QUALITY);
  const n = parseInt(readArg('--n', process.env.OPENAI_IMAGE_N || '1'), 10);
  const legacyFormat = readArg('--format', process.env.OPENAI_IMAGE_FORMAT);
  const responseFormat = readArg('--response-format', process.env.OPENAI_IMAGE_RESPONSE_FORMAT);
  const outputFormat = readArg('--output-format', process.env.OPENAI_IMAGE_OUTPUT_FORMAT || legacyFormat);
  const background = readArg('--background', process.env.OPENAI_IMAGE_BACKGROUND);
  const moderation = readArg('--moderation', process.env.OPENAI_IMAGE_MODERATION);
  const outputCompression = parseOptionalInt(readArg('--output-compression', process.env.OPENAI_IMAGE_OUTPUT_COMPRESSION), '--output-compression');
  const partialImages = parseOptionalInt(readArg('--partial-images', process.env.OPENAI_IMAGE_PARTIAL_IMAGES), '--partial-images');
  const inputFidelity = readArg('--input-fidelity', process.env.OPENAI_IMAGE_INPUT_FIDELITY);
  const style = readArg('--style', process.env.OPENAI_IMAGE_STYLE);
  const streamValue = readArg('--stream', process.env.OPENAI_IMAGE_STREAM);
  const stream = streamValue === undefined ? undefined : streamValue === 'true';
  const user = readArg('--user', process.env.OPENAI_IMAGE_USER);
  const cliExtraParams = parseJsonObject(readArg('--extra-json', process.env.OPENAI_IMAGE_EXTRA_JSON), 'OPENAI_IMAGE_EXTRA_JSON');
  const outputDir = path.resolve(readArg('--output', process.cwd()));
  const imagePaths = [...readArgs('--image'), ...readArgs('--input')];
  const inputImages = await Promise.all(imagePaths.map(readImageInput));
  const maskValue = readArg('--mask');
  const mask = maskValue && maskValue !== 'auto' ? await readImageInput(maskValue) : maskValue;
  const operation = inputImages.length > 0 ? 'edit' : 'generate';

  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!prompt) throw new Error('Prompt is required. Use --prompt "..."');
  if (mask && operation !== 'edit') throw new Error('--mask requires at least one --image');

  validateArgs({ protocol, operation, n, responseFormat, outputFormat, background, partialImages, size, inputFidelity, style, stream, hasMask: Boolean(maskValue) });

  const baseExtraParams = buildExtraParams({
    operation,
    background,
    moderation,
    outputCompression,
    outputFormat,
    partialImages,
    inputFidelity,
    style,
    user,
  });
  if (stream !== undefined) baseExtraParams.stream = stream;
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
    extraParams,
  });

  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Image API failed with HTTP ${response.status}: ${text}`);
  }

  const payload = normalizePayload(protocol, operation, text);
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
