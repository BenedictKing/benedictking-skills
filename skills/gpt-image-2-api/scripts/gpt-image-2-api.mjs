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
  '--base-url',
  '--extra-json',
  '--format',
  '--image',
  '--input',
  '--mask',
  '--model',
  '--n',
  '--output',
  '--prompt',
  '--protocol',
  '--quality',
  '--size',
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

function buildRequestBody({ protocol, operation, model, prompt, size, quality, n, format, inputImages, mask, extraParams }) {
  if (protocol === 'openai_chat') {
    if (mask) throw new Error('mask is not supported when using openai_chat protocol');
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

  if (operation === 'edit') {
    const body = {
      model,
      prompt,
      image: inputImages.map((image) => ({
        name: image.name,
        mime_type: image.mimeType,
        data: image.base64,
      })),
    };
    if (mask) {
      body.mask = {
        name: mask.name,
        mime_type: mask.mimeType,
        data: mask.base64,
      };
    }
    if (size) body.size = size;
    if (quality) body.quality = quality;
    if (n && n !== 1) body.n = n;
    if (format) body.format = format;
    return { ...body, ...extraParams };
  }

  const body = { model, prompt, n };
  if (size) body.size = size;
  if (quality) body.quality = quality;
  if (format) body.format = format;
  return { ...body, ...extraParams };
}

function decodeBase64Image(value, mimeType = 'image/png') {
  return { bytes: Buffer.from(value, 'base64'), mimeType };
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

function printHelp() {
  console.log(`Usage:
  node scripts/gpt-image-2-api.mjs --prompt "image prompt" [--output ./out] [--size 1024x1024] [--n 1] [--format png|jpeg|webp] [--quality low|medium|high|auto] [--protocol openai_images|openai_chat]
  node scripts/gpt-image-2-api.mjs --prompt "edit prompt" --image ./input.png [--image ./reference.png] [--mask ./mask.png] [--output ./out]

Options:
  --n <int>           Number of images (1-10), defaults to 1
  --format <str>      Image format: png, jpeg, webp
  --quality <str>     Image quality: low, medium, high, auto
  --size <str>        Image size: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840, auto

Environment:
  OPENAI_API_KEY        API key for the OpenAI-compatible endpoint
  OPENAI_BASE_URL       Base URL, for example http://127.0.0.1:3688/v1
  OPENAI_IMAGE_MODEL    Image model, defaults to gpt-image-2
  OPENAI_IMAGE_PROTOCOL openai_images or openai_chat, defaults to openai_images
  OPENAI_IMAGE_SIZE     Image size, defaults to 1024x1024
  OPENAI_IMAGE_QUALITY  Optional image quality
  OPENAI_IMAGE_N        Number of images (1-10), defaults to 1
  OPENAI_IMAGE_FORMAT   Optional image format: png, jpeg, webp
  OPENAI_IMAGE_EXTRA_JSON  Optional JSON object merged into the request body
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
  const format = readArg('--format', process.env.OPENAI_IMAGE_FORMAT);
  const extraParams = parseJsonObject(readArg('--extra-json', process.env.OPENAI_IMAGE_EXTRA_JSON), 'OPENAI_IMAGE_EXTRA_JSON');
  const outputDir = path.resolve(readArg('--output', process.cwd()));
  const imagePaths = [...readArgs('--image'), ...readArgs('--input')];
  const inputImages = await Promise.all(imagePaths.map(readImageInput));
  const maskPath = readArg('--mask');
  const mask = maskPath ? await readImageInput(maskPath) : undefined;
  const operation = inputImages.length > 0 ? 'edit' : 'generate';

  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!prompt) throw new Error('Prompt is required. Use --prompt "..."');
  if (mask && operation !== 'edit') throw new Error('--mask requires at least one --image');

  const body = buildRequestBody({ protocol, operation, model, prompt, size, quality, n, format, inputImages, mask, extraParams });

  const response = await fetch(`${baseUrl}${endpointPath(protocol, operation)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Image API failed with HTTP ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text);
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
