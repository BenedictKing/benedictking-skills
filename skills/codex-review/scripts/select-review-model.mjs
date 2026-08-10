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
 *   costIndex = 时间加权综合成本，归一化最高=100（仅展示，不参与选型）
 *
 * 选型主约束是**实测平均耗时**（时间预算），配合每档一个目标函数：
 *   normal    → 耗时<=上限且 IQ>=下限 里最便宜者（日常审查省钱优先）
 *   difficult → 耗时<=上限里 IQ 最高者，IQ 并列容差内取便宜者
 *   critical  → 同 difficult，时间预算更大（当前数据下同落 sol xhigh 拐点）
 * 时间预算天然排除慢档，也让“贵而不智”的档（如 sol max 之于 sol xhigh）不会中选。
 * 超时不再写死，而是 timeout = ceil(minutes * 2)，随选型走。
 *
 * 用法:
 *   node select-review-model.mjs --difficulty normal
 *   node select-review-model.mjs --difficulty difficult
 *   node select-review-model.mjs --difficulty critical
 *   node select-review-model.mjs --difficulty difficult --max-minutes 35 --iq-floor 90
 *
 * 输出 JSON:
 *   {
 *     "difficulty": "difficult",
 *     "tier": { "maxMinutes": 28, "iqFloor": 88 },
 *     "primary": { "model": "gpt-5.6-sol", "effort": "xhigh", "iq": 103.6,
 *                  "price": 6.26, "minutes": 26.4, "costIndex": 30,
 *                  "timeoutMinutes": 53, "timeoutMs": 3180000 },
 *     "fallback": [
 *       { "model": "gpt-5.5", "effort": "xhigh", ... "timeoutMs": ... }
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

// 综合成本指数权重：2.5 倍价格可换 1.35 倍速度（仅用于 costIndex 展示，不参与选型）
const SPEED_WEIGHT = Math.log(2.5) / Math.log(1.35)

// IQ 刻度：站点图表用 p / n * 150
const IQ_SCALE = 150

// 判定“并列最高 IQ”的容差（0-150 刻度）
const IQ_TIE_TOLERANCE = 1.5

// 各难度选型预算：时间上限 + IQ 下限 + 目标函数。
//   normal    → objective 'cheapest'：耗时<=上限且 IQ>=floor(80) 里最便宜者（日常审查省钱优先，但要 IQ>80）
//   difficult → objective 'smartest'：耗时<=上限里 IQ 最高者（并列取便宜，避开贵而不智的档）
//   critical  → 同 smartest，时间预算更大
// 时间上限天然排除慢档；smartest 的 IQ 并列容差避免为噪声级 IQ 差付数倍成本。
const TIERS = {
  normal:    { maxMinutes: 25, iqFloor: 80, objective: 'cheapest' },
  difficult: { maxMinutes: 28, iqFloor: 88, objective: 'smartest' },
  critical:  { maxMinutes: 45, iqFloor: 96, objective: 'smartest' },
}

// 超时按选中模型的实测平均耗时推导：timeout = ceil(minutes * SAFETY)，不低于下限。
const TIMEOUT_SAFETY = 2
const TIMEOUT_FLOOR_MIN = 10

// 内置保守默认值（网络/缓存失败时兜底；minutes 用于推导 timeout）
const BUILT_IN_DEFAULTS = {
  normal:    { model: 'gpt-5.6-luna', effort: 'xhigh', iq: 87.1,  minutes: 23.4 },
  difficult: { model: 'gpt-5.6-sol',  effort: 'xhigh', iq: 103.6, minutes: 26.4 },
  critical:  { model: 'gpt-5.6-sol',  effort: 'xhigh', iq: 103.6, minutes: 26.4 },
}

// ── CLI 参数解析 ──────────────────────────────────
function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : fallback
  }
  return {
    difficulty: get('--difficulty', 'normal'),
    // 覆盖该难度的时间预算（分钟）与 IQ 兜底下限（0-150 刻度）
    maxMinutes: get('--max-minutes', null),
    iqFloor:    get('--iq-floor',    null),
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

// 超时按实测平均耗时推导，让时限跟着选型走
// （旧版写死的 10/15/40min 会被现在的高档全部超过）。
function deriveTimeout(minutes) {
  const m = Math.max(
    TIMEOUT_FLOOR_MIN,
    Math.ceil((minutes || TIMEOUT_FLOOR_MIN) * TIMEOUT_SAFETY)
  )
  return { timeoutMinutes: m, timeoutMs: m * 60 * 1000 }
}

const feasible = (cands, maxMinutes) => cands.filter(c => c.minutes <= maxMinutes)

// cheapest 目标：耗时<=上限且 IQ>=floor 里取最便宜；同价取更聪明、更快。
// 先过滤 IQ 下限，避免选到“便宜但没智商”的档。
function pickCheapest(cands, tier) {
  const f = feasible(cands, tier.maxMinutes).filter(c => c.iq >= tier.iqFloor)
  if (f.length === 0) return null
  return [...f].sort(
    (a, b) => a.price - b.price || b.iq - a.iq || a.minutes - b.minutes
  )[0]
}

// smartest 目标：耗时<=上限里取 IQ 最高；与最高差 < IQ_TIE_TOLERANCE 视为并列，
// 并列取便宜者。绕开“贵而不智”的档（如 sol max 之于 sol xhigh）。
function pickSmartest(cands, maxMinutes) {
  const f = feasible(cands, maxMinutes)
  if (f.length === 0) return null
  const topIq = Math.max(...f.map(c => c.iq))
  return f
    .filter(c => c.iq >= topIq - IQ_TIE_TOLERANCE)
    .sort((a, b) => a.price - b.price || a.minutes - b.minutes)[0]
}

// 全局 IQ 最高者（时间预算内无人达标时的兜底）。
function globalTop(cands) {
  if (cands.length === 0) return null
  return [...cands].sort((a, b) => b.iq - a.iq || a.price - b.price)[0]
}

// 主选型：cheapest / smartest 二目标；预算内无解则退化为全局最强（接受更长耗时，timeout 随之变大）。
function selectPrimary(candidates, tier) {
  const pick = tier.objective === 'cheapest'
    ? pickCheapest(candidates, tier)
    : pickSmartest(candidates, tier.maxMinutes)
  return pick || globalTop(candidates)
}

/**
 * fallback 链：每个**其他模型族**贡献一个候选（同族换 effort 绕不过“模型不可用”）。
 * 每族按 tier 目标取时间预算内最佳；该族全都超时则退化为该族全局最强，保证有可替代项。
 * 按 IQ 降序返回；每个候选带自己的 minutes / timeout，重试时用它自己的时限。
 */
function buildFallback(candidates, primary, tier) {
  const others = [...new Set(candidates.map(c => c.canonical))]
    .filter(m => m !== primary.canonical)

  const picks = []
  for (const model of others) {
    const fam = candidates.filter(c => c.canonical === model)
    const pick = selectPrimary(fam, tier)
    if (pick) picks.push(pick)
  }
  return picks.sort((a, b) => b.iq - a.iq || a.price - b.price)
}

// 输出格式化：保留数据便于人工核对选型是否合理；timeout 由 minutes 推导
function formatPick(pick) {
  const round = (v, d) => (v === null || v === undefined ? null : Number(v.toFixed(d)))
  const { timeoutMinutes, timeoutMs } = deriveTimeout(pick.minutes)
  return {
    model: pick.canonical,
    effort: pick.effort,
    iq: round(pick.iq, 1),
    price: round(pick.price, 3),
    minutes: round(pick.minutes, 1),
    costIndex: round(pick.costIndex, 3),
    timeoutMinutes,
    timeoutMs,
  }
}

// ── 默认输出 ──────────────────────────────────────
function defaultOutput(difficulty) {
  const d = BUILT_IN_DEFAULTS[difficulty] || BUILT_IN_DEFAULTS.normal
  const { timeoutMinutes, timeoutMs } = deriveTimeout(d.minutes)
  return {
    difficulty,
    primary: { ...d, timeoutMinutes, timeoutMs },
    fallback: [],
  }
}

// ── 主流程 ────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const difficulty = args.difficulty
  const base = TIERS[difficulty] || TIERS.normal
  const tier = {
    objective:  base.objective,
    maxMinutes: args.maxMinutes != null ? Number(args.maxMinutes) : base.maxMinutes,
    iqFloor:    args.iqFloor    != null ? Number(args.iqFloor)    : base.iqFloor,
  }

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

  // 3. 选型：时间预算内 IQ 最高者，跨模型族比较
  const primary = selectPrimary(scored, tier)
  if (!primary) {
    console.log(JSON.stringify(defaultOutput(difficulty), null, 2))
    return
  }

  const output = {
    difficulty,
    tier,
    primary: formatPick(primary),
    fallback: buildFallback(scored, primary, tier).map(formatPick),
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
