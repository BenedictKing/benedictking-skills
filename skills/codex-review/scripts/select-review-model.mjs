#!/usr/bin/env node
/**
 * select-review-model.mjs
 *
 * 从 codexradar (dradar) 获取模型智商/成本数据，
 * 为 codex-review skill 提供数据驱动的 model + effort 选型建议。
 *
 * 用法:
 *   node select-review-model.mjs --difficulty normal
 *   node select-review-model.mjs --difficulty difficult
 *   node select-review-model.mjs --difficulty critical
 *
 * 输出 JSON:
 *   {
 *     "difficulty": "normal",
 *     "primary": { "model": "gpt-5.6-sol", "effort": "medium", "iq": 0.607, "cost": 3.63 },
 *     "fallback": [
 *       { "model": "gpt-5.6-terra", "effort": "xhigh", ... }
 *     ]
 *   }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 配置 ──────────────────────────────────────────
const CACHE_DIR = join(homedir(), '.cache', 'codex-review')
const CACHE_PATH = join(CACHE_DIR, 'radar.json')
const TTL_MS = 60 * 60 * 1000 // 1 小时

const BASE_URL = 'https://api.codexradar.com'
const SITE_URL = 'https://deng.codexradar.com/'
const FETCH_TIMEOUT_MS = 30_000

// dradar 模型名 -> canonical 模型名映射
const DRADAR_MODEL_MAP = {
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5-4': 'gpt-5.4',
  'gpt-5-4-mini': 'gpt-5.4-mini',
}

// codex review 可用模型池（按偏好顺序不重要，脚本会按智商排序）
const REVIEW_MODELS = Object.values(DRADAR_MODEL_MAP)

// 内置保守默认值（网络/缓存失败时兜底）
const BUILT_IN_DEFAULTS = {
  normal:   { model: 'gpt-5.6-terra', effort: 'high',  iq: 0.55 },
  difficult:{ model: 'gpt-5.6-sol',   effort: 'high',  iq: 0.67 },
  critical: { model: 'gpt-5.6-sol',   effort: 'max',   iq: 0.68 },
}

// ── CLI 参数解析 ──────────────────────────────────
function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : fallback
  }
  return {
    difficulty: get('--difficulty', 'normal'),
    normalIq:   Number(get('--normal-iq',   '0.55')),
    difficultIq:Number(get('--difficult-iq', '0.65')),
    criticalIq: Number(get('--critical-iq', '0.70')),
  }
}

// ── HTTP 工具 ─────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal })
    return resp
  } finally {
    clearTimeout(timer)
  }
}

// ── 缓存 ──────────────────────────────────────────
function loadCache() {
  if (!existsSync(CACHE_PATH)) return null
  try {
    const raw = readFileSync(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed?.lastFetch || !parsed?.data) return null
    return parsed
  } catch {
    return null
  }
}

function saveCache(data) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  const payload = { lastFetch: new Date().toISOString(), data }
  writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

function cacheAgeMs() {
  const c = loadCache()
  if (!c?.lastFetch) return Infinity
  return Date.now() - new Date(c.lastFetch).getTime()
}

// ── 数据抓取 ──────────────────────────────────────
async function fetchTableCacheVersion() {
  const resp = await fetchWithTimeout(SITE_URL, {
    headers: {
      'User-Agent': 'codex-review-skill/1.0',
      Accept: 'text/html',
    },
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${SITE_URL}`)
  const html = await resp.text()
  const match = html.match(/TABLE_CACHE_VERSION\s*=\s*["']([^"']+)["']/)
  if (!match?.[1]) throw new Error('TABLE_CACHE_VERSION not found on CodexRadar site')
  return match[1]
}

async function fetchTable() {
  const cacheVersion = await fetchTableCacheVersion()
  const url = `${BASE_URL}/api/v1/table?ui=${encodeURIComponent(cacheVersion)}`

  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'codex-review-skill/1.0',
      Accept: 'application/json',
    },
  }, 45_000)

  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`)
  return resp.json()
}

// ── 数据聚合 ──────────────────────────────────────
function aggregate(data) {
  const cells = data?.cells || {}
  const agg = new Map() // key: "canonical|effort"

  for (const [key, cell] of Object.entries(cells)) {
    const parts = key.split('|')
    if (parts.length < 3) continue
    const [, dradarModel, effort] = parts
    const canonical = DRADAR_MODEL_MAP[dradarModel]
    const graded = Number(cell?.n)
    const passed = Number(cell?.p)
    if (!canonical || !Number.isFinite(graded) || graded <= 0) continue

    const mapKey = `${canonical}|${effort}`
    if (!agg.has(mapKey)) {
      agg.set(mapKey, {
        graded: 0,
        passed: 0,
        cells: 0,
        cellsPassed: 0,
        costs: [],
        durations: [],
      })
    }
    const a = agg.get(mapKey)
    a.graded += graded
    a.passed += Number.isFinite(passed) ? passed : 0
    a.cells += 1
    if (Number.isFinite(passed) && passed * 2 > graded) a.cellsPassed += 1

    for (const run of cell.ran_by || []) {
      const c = run?.actual_cost_usd
      if (typeof c === 'number' && Number.isFinite(c)) a.costs.push(c)
      const d = run?.duration_sec
      if (typeof d === 'number' && Number.isFinite(d)) a.durations.push(d)
    }
  }

  const result = []
  for (const [key, a] of agg.entries()) {
    const [canonical, effort] = key.split('|')
    const iq = a.cells > 0 ? a.cellsPassed / a.cells : 0
    const cost = a.costs.length > 0 ? median(a.costs) : null
    const duration = a.durations.length > 0 ? median(a.durations) : null
    result.push({
      canonical,
      effort,
      iq,
      cost,
      duration,
      nCost: a.costs.length,
      cells: a.cells,
    })
  }
  return result
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// 按模型分组，只保留 REVIEW_MODELS
function groupByModel(aggregated) {
  const groups = {}
  for (const r of aggregated) {
    if (!REVIEW_MODELS.includes(r.canonical)) continue
    if (!groups[r.canonical]) groups[r.canonical] = []
    groups[r.canonical].push(r)
  }
  return groups
}

// ── 选型逻辑 ──────────────────────────────────────
function pickLeadModel(groups) {
  let bestModel = null
  let bestIq = -1
  for (const [model, efforts] of Object.entries(groups)) {
    const maxIq = Math.max(...efforts.map(e => e.iq))
    if (maxIq > bestIq) {
      bestIq = maxIq
      bestModel = model
    }
  }
  return bestModel
}

/**
 * 在单个模型的 effort 列表中，选 IQ >= threshold 的最便宜 effort（最左达标点）
 * 若都不达标，返回该模型中 IQ 最高的 effort（保底）
 */
function selectEffortForModel(efforts, threshold) {
  const withCost = efforts.filter(e => e.cost !== null)
  if (withCost.length === 0) return efforts[0] || null

  const sortedByCost = [...withCost].sort((a, b) => a.cost - b.cost)
  const eligible = sortedByCost.filter(e => e.iq >= threshold)

  if (eligible.length > 0) {
    return eligible[0] // 最便宜的达标点（靠左）
  }

  // 都不达标，返回 IQ 最高的 effort
  return [...sortedByCost].sort((a, b) => b.iq - a.iq)[0]
}

/**
 * 构建 fallback 链：按各模型 bestEffort IQ 降序，排除 lead model
 * 每个 fallback 执行相同的 threshold 逻辑
 */
function buildFallback(groups, leadModel, threshold) {
  const others = Object.keys(groups).filter(m => m !== leadModel)
  others.sort((a, b) => {
    const ma = Math.max(...groups[a].map(e => e.iq))
    const mb = Math.max(...groups[b].map(e => e.iq))
    return mb - ma
  })

  const result = []
  for (const m of others) {
    const effort = selectEffortForModel(groups[m], threshold)
    if (effort) {
      result.push({
        model: m,
        effort: effort.effort,
        iq: effort.iq,
        cost: effort.cost,
      })
    }
  }
  return result
}

// ── 默认输出 ──────────────────────────────────────
function defaultOutput(difficulty) {
  const d = BUILT_IN_DEFAULTS[difficulty] || BUILT_IN_DEFAULTS.normal
  return {
    difficulty,
    primary: { ...d },
    fallback: [],
  }
}

// ── 主流程 ────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const difficulty = args.difficulty
  const thresholds = {
    normal:    args.normalIq,
    difficult: args.difficultIq,
    critical:  args.criticalIq,
  }
  const threshold = thresholds[difficulty] ?? thresholds.normal

  // 1. 获取数据（缓存优先）
  let data
  const age = cacheAgeMs()
  if (age < TTL_MS) {
    data = loadCache().data
  } else {
    try {
      data = await fetchTable()
      saveCache(data)
    } catch (err) {
      const cache = loadCache()
      if (cache?.data) {
        data = cache.data // 即使过期也复用，比失败强
      } else {
        console.log(JSON.stringify(defaultOutput(difficulty), null, 2))
        process.exit(0)
      }
    }
  }

  // 2. 聚合
  const aggregated = aggregate(data)
  const groups = groupByModel(aggregated)

  const lead = pickLeadModel(groups)
  if (!lead || !groups[lead]) {
    console.log(JSON.stringify(defaultOutput(difficulty), null, 2))
    return
  }

  // 3. 选型
  const primaryEffort = selectEffortForModel(groups[lead], threshold)
  const fallback = buildFallback(groups, lead, threshold)

  const output = {
    difficulty,
    primary: {
      model: lead,
      effort: primaryEffort?.effort || 'high',
      iq: primaryEffort?.iq ?? 0,
      cost: primaryEffort?.cost ?? null,
    },
    fallback,
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch(err => {
  const difficulty = parseArgs(process.argv.slice(2)).difficulty
  console.error(JSON.stringify({
    error: err.message,
    ...defaultOutput(difficulty),
  }, null, 2))
  process.exit(1)
})
