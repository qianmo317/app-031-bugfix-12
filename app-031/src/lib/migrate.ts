// 旧存档兼容（规格书要求）：
// - 库里只剩 0/1 种板：按默认库补齐常用板（18 厚板 / 25 厚板 / 9 背板）；
// - 同规格重复：保留一条，指向被合并板的零件全部改指保留的那条；
// - 零件指向已不在库里的编号：清掉指定，回到自动挑板；
// - 长/宽/厚/数量/修边为零、负数或非法：当场纠正为安全默认值；
// - kerf/trim 缺省或缺字段：按内置默认补齐。
// 迁移会作废无法与新库对齐的旧排样结果（单据必须与库同一份结论）。
import type { Job } from '../types'
import boardsData from '../data/boards.json'
import { uid } from './format'
import { boardAutoKey, boardGroupKey } from './boards'

export interface MigrationReport {
  warnings: string[]
}

const posInt = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function defaultStockBoard(
  pick: (typeof boardsData.stockBoards)[number]
): Job['boards'][number] {
  return {
    id: uid('b'),
    name: pick.name,
    wMm: pick.wMm,
    hMm: pick.hMm,
    thicknessMm: pick.thicknessMm,
    material: pick.material,
    priceCents: pick.priceCents,
    quantity: 0,
    kind: 'stock'
  }
}

/** 内置默认库：18mm 厚板 + 25mm 厚板 + 9mm 背板（新建项目即带这三种）。 */
export function defaultBoardSet(): Job['boards'] {
  const picks = [
    boardsData.stockBoards[0], // 颗粒板 2440×1220×18
    boardsData.stockBoards[2], // 颗粒板 2440×1220×25
    boardsData.stockBoards[6] // 中纤背板 2440×1220×9
  ]
  return picks.map(defaultStockBoard)
}

export function migrateJob(raw: unknown, report: MigrationReport = { warnings: [] }): Job | null {
  return migrateJobInternal(raw, report, new Map())
}

function migrateJobInternal(
  raw: unknown,
  report: MigrationReport,
  mergeMap: Map<string, string>
): Job | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<Job>
  if (!Array.isArray(obj.boards) || !Array.isArray(obj.parts)) return null

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name : '迁移项目'
  const job: Job = {
    id: typeof obj.id === 'string' ? obj.id : uid('job'),
    name,
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
    schemaVersion: 2,
    boards: [],
    parts: [],
    kerfMm: Number.isFinite(obj.kerfMm) ? Math.round(Number(obj.kerfMm) * 10) / 10 : boardsData.defaults.kerfMm,
    trimMm: Number.isFinite(obj.trimMm) ? Math.round(Number(obj.trimMm)) : boardsData.defaults.trimMm,
    useOffcutIds: Array.isArray(obj.useOffcutIds) ? obj.useOffcutIds.filter((x) => typeof x === 'string') : [],
    batchByCabinet: obj.batchByCabinet === true
  }

  // 1) 板材库：纠正数值、合并同规格重复
  const seen = new Map<string, string>() // groupKey -> 保留板 id
  for (const rb of obj.boards) {
    if (!rb || typeof rb !== 'object') continue
    const w = posInt((rb as { wMm?: unknown }).wMm, 0)
    const h = posInt((rb as { hMm?: unknown }).hMm, 0)
    const th = posInt((rb as { thicknessMm?: unknown }).thicknessMm, 0)
    if (!w || !h || !th) {
      report.warnings.push(`板材「${(rb as { name?: string }).name ?? '未命名'}」长宽厚非法，已忽略该条`)
      continue
    }
    const material =
      typeof (rb as { material?: unknown }).material === 'string'
        ? ((rb as { material: string }).material || '').trim()
        : ''
    const key = boardGroupKey({ wMm: w, hMm: h, thicknessMm: th, material })
    const dupId = seen.get(key)
    if (dupId) {
      report.warnings.push(`板材「${(rb as { name?: string }).name ?? key}」与库内已有板材规格相同，已合并为一条`)
      // 稍后把指向被合并 id 的零件改指 dupId
      const dead = (rb as { id?: string }).id
      if (dead) mergeMap.set(dead, dupId)
      continue
    }
    const id = typeof (rb as { id?: unknown }).id === 'string' ? (rb as { id: string }).id : uid('b')
    seen.set(key, id)
    job.boards.push({
      id,
      name:
        typeof (rb as { name?: unknown }).name === 'string' && (rb as { name: string }).name.trim()
          ? (rb as { name: string }).name.trim()
          : `${material} ${Math.max(w, h)}×${Math.min(w, h)}×${th}`,
      wMm: Math.max(w, h),
      hMm: Math.min(w, h),
      thicknessMm: th,
      material,
      priceCents: Number.isFinite((rb as { priceCents?: number }).priceCents)
        ? Math.max(0, Math.round((rb as { priceCents: number }).priceCents))
        : 0,
      quantity: Number.isFinite((rb as { quantity?: number }).quantity)
        ? Math.max(0, Math.round((rb as { quantity: number }).quantity))
        : 0,
      kind: (rb as { kind?: string }).kind === 'offcut' ? 'offcut' : 'stock',
      offcutId:
        typeof (rb as { offcutId?: unknown }).offcutId === 'string'
          ? ((rb as { offcutId: string }).offcutId)
          : undefined
    })
  }

  // 2) 库为空（旧项目把最后一种板删了）：补默认库
  if (job.boards.length === 0) {
    report.warnings.push('旧项目的板材库为空，已按默认库补上 18mm 厚板、25mm 厚板与 9mm 背板')
    job.boards.push(...defaultBoardSet())
  }

  // 3) 零件：纠正数值、修悬空指针
  const boardIds = new Set(job.boards.map((b) => b.id))
  for (const rp of obj.parts) {
    if (!rp || typeof rp !== 'object') continue
    let len = posInt((rp as { lenMm?: unknown }).lenMm, 0)
    let wid = posInt((rp as { widMm?: unknown }).widMm, 0)
    if (!len || !wid) {
      report.warnings.push(`零件「${(rp as { code?: string }).code ?? '未编号'}」长宽非法，迁移时已跳过`)
      continue
    }
    if (len < wid) {
      ;[len, wid] = [wid, len]
    }
    let boardId =
      typeof (rp as { boardId?: unknown }).boardId === 'string'
        ? ((rp as { boardId: string }).boardId)
        : ''
    if (boardId && mergeMap.has(boardId)) boardId = mergeMap.get(boardId)!
    if (boardId && !boardIds.has(boardId)) {
      report.warnings.push(
        `零件「${(rp as { code?: string }).code ?? '未编号'}」原先指定的板材已不在库里，已改回自动挑板`
      )
      boardId = ''
    }
    const grain = (rp as { grain?: string }).grain
    job.parts.push({
      id: typeof (rp as { id?: unknown }).id === 'string' ? (rp as { id: string }).id : uid('p'),
      code: typeof (rp as { code?: unknown }).code === 'string' ? (rp as { code: string }).code : '',
      name: typeof (rp as { name?: unknown }).name === 'string' ? (rp as { name: string }).name : '零件',
      lenMm: len,
      widMm: wid,
      qty: posInt((rp as { qty?: unknown }).qty, 1),
      grain: grain === 'length' || grain === 'width' ? grain : 'none',
      edgeBands: Array.isArray((rp as { edgeBands?: unknown }).edgeBands)
        ? ((rp as { edgeBands: string[] }).edgeBands.filter((e) =>
            ['top', 'bottom', 'left', 'right'].includes(e)
          ) as Job['parts'][number]['edgeBands'])
        : [],
      cabinet:
        typeof (rp as { cabinet?: unknown }).cabinet === 'string' && (rp as { cabinet: string }).cabinet
          ? (rp as { cabinet: string }).cabinet
          : '未分组',
      exposed: (rp as { exposed?: unknown }).exposed === true,
      boardId
    })
  }

  // 4) kerf / trim 越界纠正
  if (job.kerfMm < 1 || job.kerfMm > 8) {
    report.warnings.push(`锯路 ${job.kerfMm}mm 越界，已恢复默认 ${boardsData.defaults.kerfMm}mm`)
    job.kerfMm = boardsData.defaults.kerfMm
  }
  const minEdge = Math.min(...job.boards.map((b) => Math.min(b.wMm, b.hMm)))
  if (job.trimMm < 0 || 2 * job.trimMm > minEdge - 50) {
    report.warnings.push(`修边量 ${job.trimMm}mm 不合理，已恢复默认 ${boardsData.defaults.trimMm}mm`)
    job.trimMm = boardsData.defaults.trimMm
  }

  // 5) 自动挑板分组键
  const autoKey =
    typeof obj.autoBoardKey === 'string' && obj.autoBoardKey
      ? obj.autoBoardKey
      : boardAutoKey(job.boards.find((b) => b.kind !== 'offcut') ?? job.boards[0])
  job.autoBoardKey = job.boards.some((b) => boardAutoKey(b) === autoKey)
    ? autoKey
    : boardAutoKey(job.boards[0])

  // 6) 旧排样结果：只有 v2（同构、自动挑板语义一致）且排样引用的 boardId 仍在库中才保留。
  // v1 的 result 结构不同（无 boardSummary，自动件可能被排上不同厚度的板），一律作废重排。
  if (obj.schemaVersion === 2 && obj.result) {
    const boardIds = new Set(job.boards.map((b) => b.id))
    const staleSheet = (obj.result.sheets ?? []).some(
      (s) => !boardIds.has(s.boardId) && !s.boardId.startsWith('offcut_')
    )
    if (staleSheet) {
      report.warnings.push('旧排样引用了已删除的板材，已作废，请重新排样')
      job.result = undefined
    } else if (report.warnings.length === 0) {
      job.result = obj.result
    } else {
      job.result = undefined
      report.warnings.push('库或零件经过兼容修补，旧排样与下料单已作废，请重新排样')
    }
  } else if (obj.result) {
    report.warnings.push('旧版本排样结果（下料单格式已升级）已作废，请重新排样')
    job.result = undefined
  }

  return job
}

/** 批量迁移入口：每个项目独立报告。 */
export function migrateJobs(raw: unknown): { jobs: Job[]; warnings: string[] } {
  const warnings: string[] = []
  if (!Array.isArray(raw)) return { jobs: [], warnings }
  const jobs: Job[] = []
  for (const item of raw) {
    const report: MigrationReport = { warnings: [] }
    const job = migrateJobInternal(item, report, new Map())
    if (job) {
      jobs.push(job)
      warnings.push(...report.warnings.map((w) => `项目「${job.name}」：${w}`))
    }
  }
  return { jobs, warnings }
}
