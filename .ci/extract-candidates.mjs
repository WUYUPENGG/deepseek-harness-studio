#!/usr/bin/env node
/**
 * extract-candidates.mjs — 官方 deepseek-harness 更新「可摘取单元」分析器
 *
 * 背景:本仓库(deepseek-harness-studio)是 deepseek-harness 的二开衍生版,
 * 对 packages/ 做了深度二开(前端 UI、插件中心、视觉增强、角色预设广场)。
 * 官方迭代极快,整体 merge 会产生数百个核心冲突,但官方更新里有一部分是
 * 「独立新增的功能单元」——新插件包、新角色预设、新独立脚本——可以低成本
 * 单独摘取,无需整体升级。
 *
 * 本脚本以「功能单元」而非「文件」为单位分析,并对每个单元做依赖可在性
 * 检查(它引用的 @deepseek-ai/* 包在本仓库是否存在),输出可执行的候选清单。
 *
 * 用法:
 *   node .ci/extract-candidates.mjs                 # 打印报告
 *   node .ci/extract-candidates.mjs --out DIR       # 同时写入 DIR/{md,json}
 *   node .ci/extract-candidates.mjs --json          # 只输出 JSON
 *   node .ci/extract-candidates.mjs --all           # 包含低置信单元
 *
 * 环境变量:
 *   HARNESS_REMOTE   官方 harness 的 git remote 名(默认 harness)
 *   HARNESS_BRANCH   官方分支(默认 master)
 *
 * 前置:
 *   git remote add harness https://github.com/deepseek-ai/deepseek-harness.git
 *   git -c http.proxy= -c https.proxy= fetch harness master
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HARNESS_REMOTE = process.env.HARNESS_REMOTE ?? 'harness'
const HARNESS_BRANCH = process.env.HARNESS_BRANCH ?? 'master'
const UPSTREAM_REF = `${HARNESS_REMOTE}/${HARNESS_BRANCH}`

/** 逐单元估算(小时):移植 + 依赖补齐 + 冒烟验证。 */
const UNIT_EFFORT = {
  plugin: 12,
  preset: 6,
  script: 4,
  workflow: 3,
  desktop: 6,
}

/**
 * 按单元规模估算工时。整包新增(其 package.json 也是官方新增)是完整可移植
 * 单元,成本随文件数增长;包内部分新增只需把文件挂回既有包,但要先读懂既有
 * 上下文,故按规模给一个下界。
 * @param fileCount - 单元内官方新增的文件数。
 * @param wholePackage - 该单元是否为整包新增。
 * @param type - 单元类型。
 * @returns 估算小时数。
 */
function estimateHours(fileCount, wholePackage, type) {
  const base = UNIT_EFFORT[type] ?? 6
  if (!wholePackage) return Math.max(2, Math.round(base * 0.4))
  const scaled = Math.round(2 + fileCount * 0.8)
  return Math.min(40, Math.max(base, scaled))
}

/** 明显无移植价值的路径(文档、笔记、快照、生成物)。 */
const NOISE = [
  /^\.agents\//,
  /^\.claude\//,
  /^docs\//,
  /^website\//,
  /^assets\//,
  /\.i18n\.yaml$/,
  /\.(spec|test)\.tsx?$/,
  /\/tests?\//,
  /\/__snapshots__\//,
  /^examples\//,
  /^python\//,
  /^vendor\//,
]

function isNoise(path) {
  return NOISE.some((re) => re.test(path))
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function gitSafe(args) {
  return git(args)
}

function parseArgs(argv) {
  const out = { json: false, out: undefined, all: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--all') out.all = true
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数: ${a}`)
  }
  return out
}

function parseNameStatus(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    const status = parts[0][0]
    rows.push(status === 'R' || status === 'C'
      ? { status, from: parts[1], path: parts[2] }
      : { status, path: parts[1] })
  }
  return rows
}

/**
 * 本仓库全部可解析包名(用于依赖可在性检查)。
 * 覆盖 packages/、vendor/(vendored Cordis 家族)、apps/ —— 缺任一目录都会把
 * 已存在的依赖误判为缺失。
 */
function localPackageNames() {
  const names = new Set()
  let files = []
  for (const root of ['packages', 'vendor', 'apps']) {
    try {
      files.push(...gitSafe(['ls-files', root]).split('\n').filter((p) => p.endsWith('package.json')))
    } catch {
      // 该根目录不存在时跳过,不影响其余根目录的收集
    }
  }
  for (const f of files) {
    try {
      const manifest = JSON.parse(gitSafe(['show', `HEAD:${f}`]))
      if (typeof manifest.name === 'string') names.add(manifest.name)
    } catch {
      // 无法解析的 manifest 跳过:它不属于可摘取单元的依赖面
    }
  }
  return names
}

/** 官方某文件内容中引用的 @deepseek-ai/* 包名。 */
function referencedPackages(ref, path) {
  let text
  try {
    text = gitSafe(['show', `${ref}:${path}`])
  } catch {
    return []
  }
  const found = new Set()
  for (const m of text.matchAll(/@deepseek-ai\/[a-z0-9][a-z0-9-]*/g)) found.add(m[0])
  return [...found]
}

/** 把一个新增文件归入功能单元 id。 */
function unitOf(path) {
  let m
  // preset 必须先判:presets 目录同时满足下面的 packages/<group>/<pkg> 规则,
  // 否则整个预设会被折叠进它所属的包,丢失「独立角色」这个最有价值的单元粒度。
  if ((m = /^(.*\/presets\/[^/]+)\//.exec(path))) return { id: m[1], type: 'preset' }
  if ((m = /^(packages\/[^/]+\/[^/]+)\//.exec(path))) return { id: m[1], type: 'plugin' }
  if (/^apps\/desktop\//.test(path)) return { id: 'apps/desktop', type: 'desktop' }
  if ((m = /^(scripts\/[^/]+)$/.exec(path))) return { id: m[1], type: 'script' }
  if (/^\.github\/workflows\//.test(path)) return { id: '.github/workflows', type: 'workflow' }
  return undefined
}

function main() {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    console.log('用法: node .ci/extract-candidates.mjs [--json] [--out DIR] [--all]')
    return
  }

  try {
    gitSafe(['rev-parse', '--verify', UPSTREAM_REF])
  } catch {
    console.error(`找不到 ${UPSTREAM_REF}。请先执行:`)
    console.error(`  git remote add ${HARNESS_REMOTE} https://github.com/deepseek-ai/deepseek-harness.git`)
    console.error(`  git -c http.proxy= -c https.proxy= fetch ${HARNESS_REMOTE} ${HARNESS_BRANCH}`)
    process.exitCode = 1
    return
  }

  let base
  try {
    base = gitSafe(['merge-base', 'HEAD', UPSTREAM_REF]).trim()
  } catch {
    console.error('无法计算与官方 harness 的共同祖先。')
    console.error('原因通常是 fetch 深度不足(浅克隆)或双方历史不连通。请执行:')
    console.error(`  git -c http.proxy= -c https.proxy= fetch ${HARNESS_REMOTE} ${HARNESS_BRANCH} --depth=20000`)
    console.error('或全量 fetch 后重试。')
    process.exitCode = 1
    return
  }
  const localOnly = Number(gitSafe(['rev-list', '--count', `${base}..HEAD`]).trim())
  const upstreamOnly = Number(gitSafe(['rev-list', '--count', `${base}..${UPSTREAM_REF}`]).trim())

  const upstream = parseNameStatus(gitSafe(['diff', '--name-status', `${base}..${UPSTREAM_REF}`]))
  const localChanged = new Set(gitSafe(['diff', '--name-only', `${base}..HEAD`]).split('\n').filter(Boolean))
  const localPackages = localPackageNames()

  // ── 只保留「官方全新增」且非噪声的文件,再聚合成单元 ──────────────────────
  const addedFiles = upstream.filter((r) => r.status === 'A' && !isNoise(r.path))

  const units = new Map()
  for (const row of addedFiles) {
    const unit = unitOf(row.path)
    if (unit === undefined) continue
    // 与二开区重叠的文件:该单元需要适配而非直取
    const overlapsLocal = localChanged.has(row.path)
    const entry = units.get(unit.id) ?? { id: unit.id, type: unit.type, files: [], overlaps: 0, wholePackage: false }
    entry.files.push(row.path)
    if (overlapsLocal) entry.overlaps += 1
    // 整包新增的判据:该单元的 package.json 本身也是官方新增文件
    if (unit.type === 'plugin' && row.path === `${unit.id}/package.json`) entry.wholePackage = true
    if (unit.type === 'preset' && /preset\.yml$/.test(row.path)) entry.wholePackage = true
    units.set(unit.id, entry)
  }

  // ── 逐单元评估 ─────────────────────────────────────────────────────────
  const assessed = []
  for (const entry of units.values()) {
    // 单元自身的包名(自引用不算依赖缺失)
    const ownManifest = entry.files.find((f) => f.endsWith('package.json'))
    let ownName
    if (ownManifest !== undefined) {
      try {
        ownName = JSON.parse(gitSafe(['show', `${UPSTREAM_REF}:${ownManifest}`])).name
      } catch {
        // manifest 不可解析:视为无自引用信息,依赖检查照常进行
      }
    }

    // 依赖可在性:抽样该单元源码文件的 @deepseek-ai/* 引用(最多 12 个文件)
    const sample = entry.files.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f)).slice(0, 12)
    const referenced = new Set()
    for (const f of sample) {
      for (const p of referencedPackages(UPSTREAM_REF, f)) {
        if (p !== ownName) referenced.add(p)
      }
    }
    const missing = [...referenced].filter((p) => !localPackages.has(p))

    let verdict
    if (missing.length > 0) verdict = 'blocked'
    else if (entry.overlaps > 0) verdict = 'adapt'
    else verdict = 'direct'

    assessed.push({
      id: entry.id,
      type: entry.type,
      files: entry.files.length,
      overlaps: entry.overlaps,
      wholePackage: entry.wholePackage,
      referencedCount: referenced.size,
      missing,
      verdict,
      hours: estimateHours(entry.files.length, entry.wholePackage, entry.type),
      sample: entry.files.slice(0, 4),
    })
  }

  // 排序:整包新增的红利最大,先按 verdict、再按「整包新增」、最后按规模
  const verdictRank = { direct: 0, adapt: 1, blocked: 2 }
  const typeRank = { preset: 0, plugin: 1, script: 2, desktop: 3, workflow: 4 }
  const visible = assessed
    .filter((u) => cli.all || u.type === 'plugin' || u.type === 'preset' || u.type === 'script')
    .sort((a, b) =>
      (verdictRank[a.verdict] - verdictRank[b.verdict])
      || (Number(b.wholePackage) - Number(a.wholePackage))
      || ((typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9))
      || a.id.localeCompare(b.id))

  const byVerdict = {
    direct: visible.filter((u) => u.verdict === 'direct'),
    adapt: visible.filter((u) => u.verdict === 'adapt'),
    blocked: visible.filter((u) => u.verdict === 'blocked'),
  }

  // 工时只统计「可移植」的单元:blocked 属于必须整体升级的范围,不计入摘取成本
  const portable = visible.filter((u) => u.verdict !== 'blocked')
  const hours = portable.reduce((sum, u) => sum + u.hours, 0)
  const wholePackageCount = portable.filter((u) => u.wholePackage).length

  const report = {
    generatedAt: new Date().toISOString(),
    base,
    localOnly,
    upstreamOnly,
    upstreamFileCount: upstream.length,
    addedRelevantFiles: addedFiles.length,
    unitTotals: {
      units: visible.length,
      direct: byVerdict.direct.length,
      adapt: byVerdict.adapt.length,
      blocked: byVerdict.blocked.length,
      wholePackage: wholePackageCount,
    },
    estimatedHours: Number(hours.toFixed(1)),
    units: visible,
  }

  if (cli.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderMarkdown(report))
  }

  if (cli.out !== undefined) {
    mkdirSync(cli.out, { recursive: true })
    writeFileSync(join(cli.out, 'harness-candidates.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(join(cli.out, 'harness-candidates.md'), `${renderMarkdown(report)}\n`)
    console.error(`已写入 ${cli.out}/harness-candidates.{md,json}`)
  }
}

function verdictIcon(v) {
  return v === 'direct' ? '✅' : v === 'adapt' ? '⚠️' : '⛔'
}

function verdictText(v) {
  return v === 'direct'
    ? '可直接移植'
    : v === 'adapt'
      ? '需适配(与二开区重叠)'
      : '依赖缺失(需先补依赖或整体升级)'
}

function renderMarkdown(r) {
  const L = []
  L.push('# 官方 harness 可摘取单元清单')
  L.push('')
  L.push(`生成时间: ${r.generatedAt}`)
  L.push('')
  L.push('## 分叉概览')
  L.push('')
  L.push(`- 共同祖先: \`${r.base.slice(0, 12)}\``)
  L.push(`- 本仓库领先: ${r.localOnly} 个提交(二开量)`)
  L.push(`- 官方领先: ${r.upstreamOnly} 个提交`)
  L.push(`- 官方改动文件: ${r.upstreamFileCount} 个;其中「全新增且非文档」: ${r.addedRelevantFiles} 个`)
  L.push('')
  L.push('## 可摘取单元汇总')
  L.push('')
  L.push(`共识别 **${r.unitTotals.units}** 个功能单元:`)
  L.push('')
  L.push('| 判定 | 单元数 | 含义 |')
  L.push('|---|---|---|')
  L.push(`| ✅ 可直接移植 | ${r.unitTotals.direct} | 官方全新增,依赖在本仓库齐备,与二开区无重叠 |`)
  L.push(`| ⚠️ 需适配 | ${r.unitTotals.adapt} | 与二开区有文件重叠,需人工合并 |`)
  L.push(`| ⛔ 依赖缺失 | ${r.unitTotals.blocked} | 引用了本仓库没有的包,需先补齐或放弃 |`)
  L.push('')
  L.push(`**逐单元移植估算合计: ≈ ${r.estimatedHours} 小时**(非整体 merge)`)
  L.push('')

  if (r.units.length === 0) {
    L.push('> 当前没有符合条件的新增单元(可能官方更新集中在既有文件的重构,或尚未 fetch)。')
    return L.join('\n')
  }

  L.push('## 单元明细(按优先级)')
  L.push('')
  const shown = r.units.slice(0, 25)
  for (const u of shown) {
    const scope = u.wholePackage ? '整包新增' : '包内部分新增'
    L.push(`### ${verdictIcon(u.verdict)} \`${u.id}\``)
    L.push('')
    L.push(`- ${scope} | 类型: ${u.type} | 新增文件: ${u.files} 个 | 与二开区重叠: ${u.overlaps} 个`)
    L.push(`- 引用官方包: ${u.referencedCount} 个${u.missing.length > 0 ? ` | **缺失 ${u.missing.length} 个**: ${u.missing.slice(0, 6).join(', ')}` : ''}`)
    L.push(`- 判定: ${verdictText(u.verdict)} | 估算: ${u.hours}h`)
    L.push(`- 样例文件: ${u.sample.map((s) => `\`${s}\``).join(', ')}`)
    L.push('')
  }
  if (r.units.length > shown.length) {
    L.push(`> 已按优先级显示前 ${shown.length} 个;其余 ${r.units.length - shown.length} 个见 \`--json\` 或 \`--all\` 输出。`)
    L.push('')
  }

  L.push('## 使用建议')
  L.push('')
  L.push('1. 优先处理 ✅ 单元里 type=plugin / preset 的项 —— 它们是独立新增,移植成本最低、收益最直接。')
  L.push('2. ⚠️ 单元先 `git diff` 看重叠文件的双方改动,确认是否触碰 persona / tools / session 等核心契约。')
  L.push('3. ⛔ 单元的 missing 列表就是移植前要补齐的依赖;若缺失项属于核心包,说明该功能必须等整体升级。')
  L.push('4. 移植后务必跑 `pnpm run typecheck` 与 `pnpm run build`,并做一次应用级冒烟。')
  return L.join('\n')
}

try {
  main()
} catch (error) {
  console.error(`extract-candidates: ${error.message}`)
  process.exitCode = 1
}
