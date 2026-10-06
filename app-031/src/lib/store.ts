// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
// 板材库的一切增删改都必须走本文件的动作，保证：
// 库 → 零件的指定 → 排样挑中的板 → 下料单/成本表行，始终是同一份结论。
import { reactive, computed } from 'vue'
import type { Board, Job, NestResult, Part, RegisteredOffcut, SheetResult } from '../types'
import { nestJob } from './packing'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { uid } from './format'
import boardsData from '../data/boards.json'
import { defaultBoardSet, migrateJob, migrateJobs } from './migrate'
import {
  autoKeyOfJob,
  boardAutoKey,
  findDuplicate,
  jobBlockingErrors,
  kerfError,
  partError,
  partsAffectedByBoardChange,
  partsUsingBoard,
  trimError
} from './boards'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'
const SCHEMA_VERSION = 2

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  loaded: boolean
  migrationWarnings: string[]
}

function loadRaw<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

const state = reactive<State>({
  jobs: [],
  offcuts: [],
  loaded: false,
  migrationWarnings: []
})

function persist(): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
}

/** 库/零件的任何结构性改动都会让旧排样与已导出的单据失效，必须作废重排。 */
function invalidateResult(job: Job): void {
  if (job.result) job.result = undefined
}

function init(): void {
  if (state.loaded) return
  const rawJobs = loadRaw<unknown[]>(JOBS_KEY, [])
  const { jobs, warnings } = migrateJobs(rawJobs)
  state.jobs = jobs
  state.migrationWarnings = warnings
  state.offcuts = loadRaw<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.loaded = true
  if (warnings.length > 0) persist()
}

/** 新建项目的默认库：18mm 厚板 + 25mm 厚板 + 9mm 背板。 */
export function defaultBoards(): Board[] {
  return defaultBoardSet()
}

export function allStockTemplates(): Omit<Board, 'id'>[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock' as const
  }))
}

export function createJob(name: string): Job {
  init()
  const boards = defaultBoards()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    boards,
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
    autoBoardKey: boardAutoKey(boards[0]),
    useOffcutIds: [],
    batchByCabinet: false
  }
  state.jobs.unshift(job)
  persist()
  return job
}

export function deleteJob(id: string): void {
  const i = state.jobs.findIndex((j) => j.id === id)
  if (i >= 0) state.jobs.splice(i, 1)
  persist()
}

export function duplicateJob(id: string): Job | null {
  const src = getJob(id)
  if (!src) return null
  const job: Job = JSON.parse(JSON.stringify(src))
  job.id = uid('job')
  job.name = `${src.name} 副本`
  job.createdAt = Date.now()
  job.result = undefined
  state.jobs.unshift(job)
  persist()
  return job
}

export function saveJob(_job: Job): void {
  persist()
}

export function getJob(id: string): Job | undefined {
  init()
  return state.jobs.find((j) => j.id === id)
}

// ---------- 板材库动作（唯一入口，内含全部业务规则） ----------

export type AddBoardResult =
  | { ok: true; board: Board }
  | { ok: false; error: string; duplicateOf?: Board }

/** 添加板：同规格（长×宽×厚×材质）已存在则拒绝，零/负数当场拦住。 */
export function addBoard(job: Job, input: Omit<Board, 'id'>): AddBoardResult {
  const w = Math.round(Number(input.wMm))
  const h = Math.round(Number(input.hMm))
  const th = Math.round(Number(input.thicknessMm))
  if (!Number.isFinite(w) || w <= 0) return { ok: false, error: '板长必须为正数（mm），零和负数不能入库' }
  if (!Number.isFinite(h) || h <= 0) return { ok: false, error: '板宽必须为正数（mm），零和负数不能入库' }
  if (!Number.isFinite(th) || th <= 0) return { ok: false, error: '厚度必须为正数（mm）' }
  const candidate: Board = {
    ...input,
    id: 'pending',
    wMm: Math.max(w, h),
    hMm: Math.min(w, h),
    thicknessMm: th,
    material: (input.material || '').trim(),
    quantity: Math.max(0, Math.round(Number(input.quantity) || 0)),
    priceCents: Math.max(0, Math.round(Number(input.priceCents) || 0))
  }
  const dup = findDuplicate(job.boards, candidate)
  if (dup) {
    return {
      ok: false,
      error: `库里已经有同规格的板「${dup.name}」（${dup.wMm}×${dup.hMm}×${dup.thicknessMm} ${dup.material}），不必重复添加`,
      duplicateOf: dup
    }
  }
  const board: Board = { ...candidate, id: uid('b') }
  job.boards.push(board)
  invalidateResult(job)
  persist()
  return { ok: true, board }
}

export type RemoveMode = 'reject' | 'detach'

export interface RemoveBoardCheck {
  board: Board
  canDelete: boolean
  isLast: boolean
  parts: Part[]
}

/** 删板前检查：最后一种板不许删；有零件指着时必须先让操作者看到是哪些件。 */
export function checkRemoveBoard(job: Job, boardId: string): RemoveBoardCheck {
  const board = job.boards.find((b) => b.id === boardId)
  const isLast = job.boards.length <= 1
  const parts = board ? partsUsingBoard(job, boardId) : []
  return { board: board as Board, canDelete: !!board && !isLast, isLast, parts }
}

/**
 * 删除板（取舍写清，两条路只能选一条）：
 * - mode='reject'（默认，保住用料要求）：有零件指着则拦住，要求先改指别的板；
 * - mode='detach'（保住当场可删）：把这些件的指定清掉、回到自动挑板——
 *   代价是这些件对厚度/材质的要求丢失，可能被排到对不上的板上。
 * 两条路都会让旧排样/已发单据作废。
 */
export function removeBoard(
  job: Job,
  boardId: string,
  mode: RemoveMode
): { ok: boolean; error?: string; detached?: Part[] } {
  const check = checkRemoveBoard(job, boardId)
  if (!check.board) return { ok: false, error: '板材不存在' }
  if (check.isLast) return { ok: false, error: '最后一种板不许删：库里必须至少留一种板' }
  if (check.parts.length > 0 && mode === 'reject') {
    return {
      ok: false,
      error: `有 ${check.parts.length} 种零件正指定使用「${check.board.name}」，请先把它们改到别的板（或回到自动挑板），再删除`
    }
  }
  let detached: Part[] = []
  if (check.parts.length > 0 && mode === 'detach') {
    detached = check.parts
    for (const p of detached) p.boardId = ''
  }
  job.boards.splice(job.boards.indexOf(check.board), 1)
  // 自动分组键若随板消失，落到库中第一块常规板
  if (!job.boards.some((b) => boardAutoKey(b) === job.autoBoardKey)) {
    job.autoBoardKey = boardAutoKey(job.boards.find((b) => b.kind !== 'offcut') ?? job.boards[0])
  }
  invalidateResult(job)
  persist()
  return { ok: true, detached }
}

export interface BoardUpdatePatch {
  name?: string
  material?: string
  wMm?: number
  hMm?: number
  thicknessMm?: number
  priceCents?: number
  quantity?: number
}

export type UpdateBoardResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; needConfirm: true; parts: Part[]; oldThickness: number; newThickness: number; message: string }

/**
 * 改板：
 * - 长宽厚为零/负数当场拦住；改成与别板同规格拒绝；
 * - 厚度改小（或材质变更导致自动组变化）时，必须先点出受影响的零件并确认；
 * - 提交写回本机存储并作废旧排样。
 */
export function updateBoard(
  job: Job,
  boardId: string,
  patch: BoardUpdatePatch,
  opts: { confirmThickness?: boolean } = {}
): UpdateBoardResult {
  const board = job.boards.find((b) => b.id === boardId)
  if (!board) return { ok: false, error: '板材不存在' }

  if (patch.wMm !== undefined) {
    const w = Math.round(Number(patch.wMm))
    if (!Number.isFinite(w) || w <= 0) return { ok: false, error: '板长必须为正数（mm），零和负数不能保存' }
  }
  if (patch.hMm !== undefined) {
    const h = Math.round(Number(patch.hMm))
    if (!Number.isFinite(h) || h <= 0) return { ok: false, error: '板宽必须为正数（mm），零和负数不能保存' }
  }
  if (patch.thicknessMm !== undefined) {
    const th = Math.round(Number(patch.thicknessMm))
    if (!Number.isFinite(th) || th <= 0) return { ok: false, error: '厚度必须为正数（mm）' }
  }

  const rawW = patch.wMm !== undefined ? Math.round(Number(patch.wMm)) : board.wMm
  const rawH = patch.hMm !== undefined ? Math.round(Number(patch.hMm)) : board.hMm
  const next: Board = {
    ...board,
    ...patch,
    wMm: Math.max(rawW, rawH),
    hMm: Math.min(rawW, rawH),
    thicknessMm:
      patch.thicknessMm !== undefined ? Math.round(Number(patch.thicknessMm)) : board.thicknessMm
  }
  if (patch.material !== undefined) next.material = String(patch.material).trim()
  if (patch.priceCents !== undefined) next.priceCents = Math.max(0, Math.round(Number(patch.priceCents) || 0))
  if (patch.quantity !== undefined) next.quantity = Math.max(0, Math.round(Number(patch.quantity) || 0))

  const dup = findDuplicate(job.boards, next)
  if (dup) {
    return {
      ok: false,
      error: `改成后与库内「${dup.name}」规格完全相同，请直接删掉本条或改用别的尺寸`
    }
  }

  // 厚度/材质变更影响核对
  const thicknessDecreasing = next.thicknessMm < board.thicknessMm
  const { parts, oldKey, newKey } = partsAffectedByBoardChange(job, board, next)
  const groupChanging = oldKey !== newKey
  if (parts.length > 0 && (thicknessDecreasing || groupChanging)) {
    if (!opts.confirmThickness) {
      const reason =
        next.thicknessMm < board.thicknessMm
          ? `厚度将从 ${board.thicknessMm}mm 改小为 ${next.thicknessMm}mm`
          : `材质/厚度分组将从「${oldKey}」变为「${newKey}」`
      return {
        ok: false,
        needConfirm: true,
        parts,
        oldThickness: board.thicknessMm,
        newThickness: next.thicknessMm,
        message: `${reason}。以下 ${parts.length} 种零件${
          next.thicknessMm < board.thicknessMm ? '还在用这块板，改薄后强度与外观要求可能对不上' : '的用料归属会变化'
        }：${parts.map((p) => p.code || p.name).join('、')}。确认写入并让这些件沿用这块板吗？`
      }
    }
  }

  Object.assign(board, {
    name: next.name,
    material: next.material,
    wMm: next.wMm,
    hMm: next.hMm,
    thicknessMm: next.thicknessMm,
    priceCents: next.priceCents,
    quantity: next.quantity
  })
  // 若本组里板的材质/厚度变了，且它是当前自动组，跟随更新自动键
  if (groupChanging && job.autoBoardKey === oldKey) {
    job.autoBoardKey = newKey
  }
  invalidateResult(job)
  persist()
  return { ok: true }
}

/** 直接改名称（不涉及规格，不触发确认）。 */
export function renameBoard(job: Job, boardId: string, name: string): void {
  const b = job.boards.find((x) => x.id === boardId)
  if (!b) return
  b.name = name
  persist()
}

export function setTrim(job: Job, trimMm: number): { ok: boolean; error?: string } {
  const trim = Math.round(Number(trimMm))
  const err = trimError(job.boards, trim)
  if (err) return { ok: false, error: err }
  if (job.trimMm !== trim) {
    job.trimMm = trim
    invalidateResult(job)
    persist()
  }
  return { ok: true }
}

export function setKerf(job: Job, kerfMm: number): { ok: boolean; error?: string } {
  const k = Math.round(Number(kerfMm) * 10) / 10
  const err = kerfError(k)
  if (err) return { ok: false, error: err }
  if (job.kerfMm !== k) {
    job.kerfMm = k
    invalidateResult(job)
    persist()
  }
  return { ok: true }
}

export function setAutoKey(job: Job, key: string): void {
  if (!job.boards.some((b) => b.kind !== 'offcut' && boardAutoKey(b) === key)) return
  job.autoBoardKey = key
  invalidateResult(job)
  persist()
}

// ---------- 零件动作 ----------

/** 改零件：零/负数当场拦住（返回错误，不写回）。 */
export function updatePart(job: Job, partId: string, patch: Partial<Part>): string | null {
  const p = job.parts.find((x) => x.id === partId)
  if (!p) return '零件不存在'
  const trial = { ...p, ...patch }
  // 长和宽始终归一为长≥宽
  if (patch.lenMm !== undefined || patch.widMm !== undefined) {
    const l = Math.round(Number(trial.lenMm))
    const w = Math.round(Number(trial.widMm))
    trial.lenMm = Math.max(l, w)
    trial.widMm = Math.min(l, w)
    patch = { ...patch, lenMm: trial.lenMm, widMm: trial.widMm }
  }
  if (patch.qty !== undefined) {
    trial.qty = Math.max(1, Math.round(Number(trial.qty) || 1))
    patch = { ...patch, qty: trial.qty }
  }
  const err = partError(trial)
  if (err) return err
  if (patch.boardId !== undefined && patch.boardId && !job.boards.some((b) => b.id === patch.boardId)) {
    return '指定的板材不在库里'
  }
  Object.assign(p, patch)
  invalidateResult(job)
  persist()
  return null
}

export function addPart(job: Job, part: Part): void {
  job.parts.push(part)
  invalidateResult(job)
  persist()
}

export function removePart(job: Job, partId: string): void {
  const i = job.parts.findIndex((p) => p.id === partId)
  if (i >= 0) job.parts.splice(i, 1)
  invalidateResult(job)
  persist()
}

/** 把勾选的登记余料转成本单可用的小板（排在板材列表前，优先消耗）。 */
function boardsWithOffcuts(job: Job): Board[] {
  const offcutBoards: Board[] = state.offcuts
    .filter((o) => o.available && job.useOffcutIds.includes(o.id))
    .map((o) => ({
      id: `offcut_${o.id}`,
      name: `余料板 ${o.wMm}×${o.hMm}×${o.thicknessMm}（${o.material}）`,
      wMm: o.wMm,
      hMm: o.hMm,
      thicknessMm: o.thicknessMm,
      material: o.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut' as const,
      offcutId: o.id
    }))
  return [...offcutBoards, ...job.boards]
}

export function runNest(job: Job): NestResult {
  const blockers = jobBlockingErrors(job)
  if (blockers.length > 0) {
    throw new NestBlockedError(blockers)
  }
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const result = nestJob(effective, autoKeyOfJob(job))
  // 标记被用掉的余料
  const usedOffcutBoardIds = new Set(
    result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
  )
  for (const oc of state.offcuts) {
    if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
      oc.available = false
      oc.usedByJobId = job.id
    }
  }
  job.result = result
  persist()
  return result
}

export class NestBlockedError extends Error {
  blockers: string[]
  constructor(blockers: string[]) {
    super(blockers.join('；'))
    this.name = 'NestBlockedError'
    this.blockers = blockers
  }
}

/** 手工微调：移动/交换后重新校验 guillotine 并重算刀路；非法返回错误信息。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const sheet = job.result.sheets[sheetIndex]
  const bounds = {
    x: job.trimMm,
    y: job.trimMm,
    w: sheet.wMm - 2 * job.trimMm,
    h: sheet.hMm - 2 * job.trimMm
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    job.kerfMm
  )
  if (violation) return violation
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    job.kerfMm,
    job.trimMm,
    sheetIndex,
    placements
  )
  if (!rebuilt) return '调整后无法生成可执行的贯通裁切刀路'
  const offcuts = rebuilt.leftovers
    .filter((r) => r.w >= 300 - 0.05 && r.h >= 300 - 0.05)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: true
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = rebuilt.steps
  sheet.offcuts = offcuts
  sheet.adjusted = true
  sheet.usedAreaMm2 = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  sheet.utilization = sheet.usedAreaMm2 / sheet.boardAreaMm2
  persist()
  return null
}

export function registerOffcuts(
  job: Job,
  picks: { sheetIndex: number; x: number; y: number; wMm: number; hMm: number }[]
): number {
  if (!job.result) return 0
  let n = 0
  for (const pick of picks) {
    const sheet = job.result.sheets[pick.sheetIndex]
    state.offcuts.push({
      id: uid('oc'),
      jobId: job.id,
      jobName: job.name,
      sheetIndex: pick.sheetIndex,
      wMm: pick.wMm,
      hMm: pick.hMm,
      thicknessMm: sheet.thicknessMm,
      material: sheet.material,
      createdAt: Date.now(),
      available: true
    })
    n++
  }
  persist()
  return n
}

export function addManualOffcut(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): void {
  state.offcuts.push({
    id: uid('oc'),
    jobId: '',
    jobName: '手工登记',
    sheetIndex: -1,
    wMm: Math.round(input.wMm),
    hMm: Math.round(input.hMm),
    thicknessMm: Math.round(input.thicknessMm),
    material: input.material,
    createdAt: Date.now(),
    available: true
  })
  persist()
}

export function removeOffcut(id: string): void {
  const i = state.offcuts.findIndex((o) => o.id === id)
  if (i >= 0) state.offcuts.splice(i, 1)
  persist()
}

export function toggleOffcut(id: string): void {
  const o = state.offcuts.find((x) => x.id === id)
  if (o) {
    o.available = !o.available
    if (o.available) o.usedByJobId = undefined
    persist()
  }
}

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm） */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards[0] // 颗粒板 18mm
  const back = job.boards.find((b) => b.thicknessMm === 9)!
  const P = (
    code: string,
    name: string,
    l: number,
    w: number,
    qty: number,
    grain: Part['grain'],
    edges: Part['edgeBands'],
    cabinet: string,
    exposed: boolean,
    boardId?: string
  ): Part => ({
    id: uid('p'),
    code,
    name,
    lenMm: l,
    widMm: w,
    qty,
    grain,
    edgeBands: edges,
    cabinet,
    exposed,
    boardId: boardId ?? b18.id
  })
  const all4: Part['edgeBands'] = ['top', 'bottom', 'left', 'right']
  const lb: Part['edgeBands'] = ['left', 'right']
  const tb: Part['edgeBands'] = ['top', 'bottom']
  job.parts = [
    // 地柜（600 宽标准柜 ×2 + 800 宽水槽柜）
    P('DC-S', '地柜侧板', 700, 560, 4, 'length', lb, '地柜', false),
    P('DC-D', '地柜底板', 564, 560, 2, 'none', tb, '地柜', false),
    P('DC-T', '地柜顶板/拉带', 564, 100, 2, 'none', [], '地柜', false),
    P('DC-M', '地柜门(竖纹见光)', 700, 296, 2, 'length', all4, '地柜', true),
    P('SC-S', '水槽柜侧板', 700, 560, 2, 'length', lb, '水槽柜', false),
    P('SC-D', '水槽柜底板', 764, 560, 1, 'none', tb, '水槽柜', false),
    P('SC-M', '水槽柜门(竖纹见光)', 700, 396, 2, 'length', all4, '水槽柜', true),
    // 吊柜
    P('GC-S', '吊柜侧板', 700, 320, 4, 'length', lb, '吊柜', false),
    P('GC-P', '吊柜层板', 764, 320, 2, 'none', tb, '吊柜', false),
    P('GC-M', '吊柜门板(竖纹见光)', 700, 396, 2, 'length', all4, '吊柜', true),
    // 衣柜
    P('WR-S', '衣柜见光侧板', 2200, 580, 2, 'length', all4, '衣柜', true),
    P('WR-IS', '衣柜中侧板', 2180, 560, 1, 'length', lb, '衣柜', false),
    P('WR-P', '衣柜层板', 564, 560, 5, 'none', tb, '衣柜', false),
    P('WR-T', '衣柜顶板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-B', '衣柜底板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-M', '衣柜门板(竖纹见光)', 2180, 446, 4, 'length', all4, '衣柜', true),
    // 9mm 背板（指定板材）
    P('BB-D', '地柜/水槽柜背板', 690, 564, 3, 'none', [], '地柜', false, back.id),
    P('BB-G', '吊柜背板', 690, 764, 1, 'none', [], '吊柜', false, back.id),
    P('BB-W', '衣柜背板(竖纹)', 2180, 900, 2, 'length', [], '衣柜', false, back.id)
  ]
  persist()
  return job
}

export function newPart(partial: Partial<Part> = {}): Part {
  return {
    id: uid('p'),
    code: partial.code ?? '',
    name: partial.name ?? '',
    lenMm: partial.lenMm ?? 0,
    widMm: partial.widMm ?? 0,
    qty: partial.qty ?? 1,
    grain: partial.grain ?? 'none',
    edgeBands: partial.edgeBands ?? [],
    cabinet: partial.cabinet ?? '未分组',
    exposed: partial.exposed ?? false,
    boardId: partial.boardId ?? ''
  }
}

export function exportJobJson(job: Job): string {
  return JSON.stringify(job, null, 2)
}

export function importJobJson(json: string): Job | null {
  try {
    const parsed = JSON.parse(json)
    const report = { warnings: [] }
    const obj = migrateJob(parsed, report)
    if (!obj) return null
    obj.id = uid('job')
    obj.createdAt = Date.now()
    obj.result = undefined
    state.jobs.unshift(obj)
    persist()
    return obj
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts),
    migrationWarnings: computed(() => state.migrationWarnings)
  }
}

export { boardsData }
