#!/usr/bin/env node
/**
 * select-review-model.mjs
 *
 * 从 codexradar (dradar) 获取模型智商/成本数据，
 * 为 codex-review skill 提供数据驱动的 model + effort 选型建议。
 *
 * 指标与 codexradar 站点图表（综合成本 × 智力）保持同一量纲：
 *   iq       = p / n * 150                                   （0-150 刻度）
 *   price    = mean(actual_cost_usd)                          （美元）
 *   minutes  = mean(duration_sec) / 60                         （分钟）
 *   combined = price * (minutes / 10) ^ (ln2.5 / ln1.35) * 100  （时间加权综合成本）
 *   costIndex = combined / max(combined) * 100                 （归一化，最高 = 100）
 *
 * 选型在**全部 model × effort 组合**上做全局比较（不再先锁定单一模型族）：
 *   normal    → 达标点中综合成本最低者为基准；每多 1 IQ 最多接受 2% 成本溢价后仍取更聪明的
 *   difficult → 同一规则，但使用更高的 IQ 门槛
 *   critical  → 取最高 IQ；与最高 IQ 差距在容差内视为并列，取其中成本最低者
 *
 * 用法:
 *   node select-review-model.mjs --difficulty normal
 *   node select-review-model.mjs --difficulty difficult
 *   node select-review-model.mjs --difficulty critical
 *
 * 输出 JSON:
 *   {
 *     "difficulty": "normal",
 *     "primary": { "model": "gpt-5.6-terra", "effort": "high",
 *                  "iq": 75.9, "price": 1.1, "minutes": 12.6, "costIndex": 0.085 },
 *     "fallback": [
 *       { "model": "gpt-5.6-sol", "effort": "low", ... }
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

// codex review 可用模型池（顺序不重要，选型在全局组合上比较）
const REVIEW_MODELS = Object.values(DRADAR_MODEL_MAP)

// 综合成本指数权重：2.5 倍价格可换 1.35 倍速度（与站点 combinedEfficiencyIndex 一致）
const SPEED_WEIGHT = Math.log(2.5) / Math.log(1.35)

// IQ 刻度：站点图表用 p / n * 150
const IQ_SCALE = 150

// 每多 1 IQ 可接受的成本溢价比例（与站点“后台自动化”推荐规则一致）
const COST_PREMIUM_PER_IQ = 0.02

// 判定“并列最高 IQ”的容差（0-150 刻度）
const IQ_TIE_TOLERANCE = 1.5

// 内置保守默认值（网络/缓存失败时兜底，IQ 为 0-150 刻度）
const BUILT_IN_DEFAULTS = {
  normal:   { model: 'gpt-5.6-terra', effort: 'high', iq: 76 },
  difficult:{ model: 'gpt-5.6-sol',   effort: 'high', iq: 91 },
  critical: { model: 'gpt-5.6-sol',   effort: 'max',  iq: 100 },
}

// ── CLI 参数解析 ──────────────────────────────────
function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : fallback
  }
  return {
    difficulty: get('--difficulty', 'normal'),
    // IQ 门槛为 0-150 刻度（站点图表同量纲）
    normalIq:   Number(get('--normal-iq',    '70')),
    difficultIq:Number(get('--difficult-iq', '88')),
    criticalIq: Number(get('--critical-iq',  '96')),
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
/**
 * 综合成本：价格 × 时间惩罚。与站点 combinedEfficiencyIndex 同公式。
 * 价格或耗时缺失时返回 null（该组合不参与成本敏感的选型）。
 */
function combinedCost(price, minutes) {
  if (!(price > 0) || !(minutes > 0)) return null
  return price * Math.pow(minutes / 10, SPEED_WEIGHT) * 100
}

function aggregate(data) {
  const cells = data?.cells || {}
  const agg = new Map() // key: "canonical|effort"

  for (const [key, cell] of Object.entries(cells)) {
    const parts = key.split('|')
    if (parts.length < 3) continue
    const [, dradarModel, effort] = parts
    const canonical = DRADAR_MODEL_MAP[dradarModel]
    if (!canonical) continue

    const graded = Number(cell?.n)
    const passed = Number(cell?.p)

    const mapKey = `${canonical}|${effort}`
    if (!agg.has(mapKey)) {
      agg.set(mapKey, {
        graded: 0,
        passed: 0,
        costSum: 0,
        costN: 0,
        minutesSum: 0,
        minutesN: 0,
      })
    }
    const a = agg.get(mapKey)

    // IQ 只统计有评分的格子
    if (Number.isFinite(graded) && graded > 0) {
      a.graded += graded
      a.passed += Number.isFinite(passed) ? passed : 0
    }

    // 价格与耗时取算术平均（与站点 averageActuals 一致）
    for (const run of cell.ran_by || []) {
      const c = run?.actual_cost_usd
      if (typeof c === 'number' && Number.isFinite(c)) {
        a.costSum += c
        a.costN += 1
      }
      const d = run?.duration_sec
      if (typeof d === 'number' && Number.isFinite(d)) {
        a.minutesSum += d / 60
        a.minutesN += 1
      }
    }
  }

  const result = []
  for (const [key, a] of agg.entries()) {
    const [canonical, effort] = key.split('|')
    if (a.graded <= 0) continue
    const price = a.costN > 0 ? a.costSum / a.costN : null
    const minutes = a.minutesN > 0 ? a.minutesSum / a.minutesN : null
    result.push({
      canonical,
      effort,
      iq: (a.passed / a.graded) * IQ_SCALE,
      price,
      minutes,
      combined: combinedCost(price, minutes),
      graded: a.graded,
      nCost: a.costN,
    })
  }
  return result
}

// 过滤出候选池：仅保留 REVIEW_MODELS 且有综合成本数据的组合
function buildCandidates(aggregated) {
  return aggregated
    .filter(r => REVIEW_MODELS.includes(r.canonical))
    .filter(r => r.combined !== null)
}

// 归一化成本指数（最高 = 100），仅用于输出可读性，不影响排序
function withCostIndex(candidates) {
  const maxCombined = Math.max(...candidates.map(c => c.combined))
  return candidates.map(c => ({
    ...c,
    costIndex: maxCombined > 0 ? (c.combined / maxCombined) * 100 : 0,
  }))
}

// ── 选型逻辑 ──────────────────────────────────────

/**
 * 成本感知选型（用于 normal / difficult）：
 * 1. 取 IQ >= threshold 的组合中综合成本最低者为基准
 * 2. 在达标组合里找“更聪明且溢价可接受”的：每多 1 IQ 最多接受 2% 成本溢价
 * 3. 若无组合达标，退化为全局 IQ 最高者（保证不会因门槛过高而无解）
 */
function selectCostAware(candidates, threshold) {
  const eligible = candidates.filter(c => c.iq >= threshold)
  if (eligible.length === 0) return selectHighestIq(candidates)

  const baseline = [...eligible].sort(
    (a, b) => a.combined - b.combined || b.iq - a.iq
  )[0]

  const upgrades = eligible
    .filter(c => {
      const gain = c.iq - baseline.iq
      if (gain < IQ_TIE_TOLERANCE) return false
      return c.combined <= baseline.combined * (1 + gain * COST_PREMIUM_PER_IQ)
    })
    .sort((a, b) => b.iq - a.iq || a.combined - b.combined)

  return upgrades.length > 0 ? upgrades[0] : baseline
}

/**
 * 最高智力选型（用于 critical）：
 * 取全局最高 IQ；与最高 IQ 差距在容差内视为并列，并列中取综合成本最低者。
 * 这样可以避免为 <1.5 IQ 的噪声级差异付出数倍成本。
 */
function selectHighestIq(candidates) {
  if (candidates.length === 0) return null
  const topIq = Math.max(...candidates.map(c => c.iq))
  return [...candidates]
    .filter(c => c.iq >= topIq - IQ_TIE_TOLERANCE)
    .sort((a, b) => a.combined - b.combined || b.iq - a.iq)[0]
}

function selectPrimary(candidates, difficulty, threshold) {
  return difficulty === 'critical'
    ? selectHighestIq(candidates)
    : selectCostAware(candidates, threshold)
}

/**
 * 构建 fallback 链：每个**其他模型族**贡献一个候选，按 IQ 降序。
 * fallback 用于 primary 模型不可用时重试，因此必须换模型族，
 * 同族换 effort 无法绕过“模型不可用”这类失败。
 */
function buildFallback(candidates, primary, difficulty, threshold) {
  const others = [...new Set(candidates.map(c => c.canonical))]
    .filter(m => m !== primary.canonical)

  const picks = []
  for (const model of others) {
    const pick = selectPrimary(
      candidates.filter(c => c.canonical === model),
      difficulty,
      threshold
    )
    if (pick) picks.push(pick)
  }
  return picks.sort((a, b) => b.iq - a.iq || a.combined - b.combined)
}

// 输出格式化：保留数据便于人工核对选型是否合理
function formatPick(pick) {
  const round = (v, d) => (v === null || v === undefined ? null : Number(v.toFixed(d)))
  return {
    model: pick.canonical,
    effort: pick.effort,
    iq: round(pick.iq, 1),
    price: round(pick.price, 3),
    minutes: round(pick.minutes, 1),
    costIndex: round(pick.costIndex, 3),
  }
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

  // 2. 聚合并构建全局候选池
  const candidates = buildCandidates(aggregate(data))
  if (candidates.length === 0) {
    console.log(JSON.stringify(defaultOutput(difficulty), null, 2))
    return
  }
  const scored = withCostIndex(candidates)

  // 3. 全局选型（跨模型族比较，成本参与决策）
  const primary = selectPrimary(scored, difficulty, threshold)
  if (!primary) {
    console.log(JSON.stringify(defaultOutput(difficulty), null, 2))
    return
  }

  const output = {
    difficulty,
    threshold,
    primary: formatPick(primary),
    fallback: buildFallback(scored, primary, difficulty, threshold).map(formatPick),
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
