// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
//
// 板材库的所有写操作都从这里走（addBoard/updateBoard/removeBoard），
// 保证板材库、零件指定、排样结果、下料单/成本表同一份结论：
// 输入一变，旧排样结果立即作废（inputSig 不一致），单据不会再留已删板的行。
import { reactive, computed } from 'vue'
import type { Board, Job, NestResult, Part, RegisteredOffcut, SheetResult } from '../types'
import { nestJob } from './packing'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { uid } from './format'
import boardsData from '../data/boards.json'
import {
  defaultBoardSpecs,
  isDuplicateBoard,
  jobInputSig,
  migrateJob,
  partsReferencingBoard,
  validateBoardFields,
  validateJobForNest,
  validateTrimMm,
  type BoardSpec
} from './boards'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
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
  loaded: false
})

/** 结果签名与当前输入不一致的项目 id（视图据此提示「库已改动，结果已失效，请重排」）。 */
const staleJobIds = reactive(new Set<string>())
export function isResultStale(jobId: string): boolean {
  return staleJobIds.has(jobId)
}

function persist(): void {
  // 写回本机前统一裁判：输入变了而结果没跟着重排，旧结果作废
  for (const j of state.jobs) {
    if (j.result && j.result.inputSig !== jobInputSig(j)) {
      j.result = undefined
      staleJobIds.add(j.id)
    }
  }
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
}

/** 用规格模板造一块新板（id 只在这里发，杜绝同名多条各带一个编号）。 */
export function makeBoard(spec: BoardSpec & Partial<Board>): Board {
  return {
    id: uid('b'),
    name: spec.name,
    wMm: spec.wMm,
    hMm: spec.hMm,
    thicknessMm: spec.thicknessMm,
    material: spec.material,
    priceCents: spec.priceCents,
    quantity: spec.quantity ?? 0,
    kind: spec.kind ?? 'stock'
  }
}

function init(): void {
  if (state.loaded) return
  const rawJobs = load<Job[]>(JOBS_KEY, [])
  state.jobs = rawJobs.map((j) => migrateJob(j, makeBoard))
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.loaded = true
  // 迁移即写回，把兼容接上的默认值/清掉的悬挂引用落到本机
  if (rawJobs.length > 0) persist()
}

/** 新项目默认库：18mm 厚板 + 25mm 常用厚板 + 9mm 背板。 */
export function defaultBoards(): Board[] {
  return defaultBoardSpecs().map(makeBoard)
}

export function allStockTemplates(): BoardSpec[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents
  }))
}

export function createJob(name: string): Job {
  init()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    boards: defaultBoards(),
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
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
  staleJobIds.delete(id)
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

// ── 板材库写操作（单一入口：校验 + 引用点名 + 失效旧结果 + 写回本机） ─────────────

export type BoardMutation =
  | { ok: true }
  | { ok: false; error: string }

/** 向库中加板；同规格（名称/材质/长宽厚）已存在时拒绝，错误里带是哪一条。 */
export function addBoard(job: Job, spec: BoardSpec): BoardMutation {
  const candidate: Omit<Board, 'id'> = { ...spec, quantity: 0, kind: 'stock' }
  const fieldErr = validateBoardFields({ ...candidate })
  if (fieldErr) return { ok: false, error: fieldErr }
  const dup = isDuplicateBoard(job.boards, candidate)
  if (dup) return { ok: false, error: `库中已有同规格的板：「${dup.name}」(${dup.wMm}×${dup.hMm}×${dup.thicknessMm} ${dup.material})，不允许重复添加` }
  job.boards.push(makeBoard(candidate))
  persist()
  return { ok: true }
}

/**
 * 改板字段（长宽/厚度/材质/单价/数量/名称）。
 * - 0/负数长宽厚当场拒绝（返回 error，视图回滚输入框）
 * - 改成与库中另一条同规格：拒绝
 * - 修边量按改后尺寸复查
 * - 厚度被改小且有零件指着它：返回需确认的零件名单，调用方确认后用 force=true 提交
 */
export function updateBoard(
  job: Job,
  boardId: string,
  patch: Partial<Omit<Board, 'id' | 'kind' | 'offcutId'>>,
  force = false
): BoardMutation & { referring?: Part[] } {
  const b = job.boards.find((x) => x.id === boardId)
  if (!b) return { ok: false, error: '板材不存在' }
  const next = { ...b, ...patch }
  const fieldErr = validateBoardFields(next)
  if (fieldErr) return { ok: false, error: fieldErr }
  const dup = isDuplicateBoard(job.boards, next, boardId)
  if (dup) return { ok: false, error: `库中已有同规格的板：「${dup.name}」，改完就重复了` }
  const trimErr = validateTrimMm(job.trimMm, job.kerfMm, [next])
  if (trimErr) return { ok: false, error: trimErr }
  const referring = partsReferencingBoard(job, boardId)
  const thicknessReduced =
    typeof patch.thicknessMm === 'number' && patch.thicknessMm < b.thicknessMm
  if (thicknessReduced && referring.length > 0 && !force) {
    return {
      ok: false,
      error: '__CONFIRM_THICKNESS__',
      referring
    }
  }
  Object.assign(b, patch)
  persist()
  return { ok: true }
}

/**
 * 删板。取舍（A 路，本应用的选择）：
 * - 库中最后一种板不许删（至少保留一种，排样才有板可挑）
 * - 有零件指着它时：确认后把这些零件的指定清掉、回到自动挑板——当场就能删；
 *   代价是这些件对板厚/材质的指定要求丢了，可能被排到厚度或材质对不上的板上。
 *   （另一条 B 路：拦住不许删、先把零件改到别的板——保住用料要求，代价是当场删不动。）
 * 调用方先用 referring 判断是否弹确认，确认后 deleteConfirmed=true 提交。
 */
export function removeBoard(
  job: Job,
  boardId: string,
  deleteConfirmed = false
): BoardMutation & { referring?: Part[] } {
  if (job.boards.length <= 1) {
    return { ok: false, error: '库里至少要保留一种板，最后一种板不允许删除' }
  }
  const b = job.boards.find((x) => x.id === boardId)
  if (!b) return { ok: false, error: '板材不存在' }
  const referring = partsReferencingBoard(job, boardId)
  if (referring.length > 0 && !deleteConfirmed) {
    return { ok: false, error: '__CONFIRM_DELETE__', referring }
  }
  // A 路：清掉零件的指定，回到自动挑板
  for (const p of referring) p.boardId = ''
  const i = job.boards.findIndex((x) => x.id === boardId)
  job.boards.splice(i, 1)
  persist()
  return { ok: true }
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

/** 排样：先做硬校验（空库/0 负数/修边过大），通过后重算并给结果盖输入签名。 */
export function runNest(job: Job): NestResult | { error: string } {
  const hardErr = validateJobForNest(job)
  if (hardErr) return { error: hardErr }
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const result = nestJob(effective)
  // 余料板 id 在盖章前不在签名里；签名只裁判本项目自有板/零件/参数，余料勾选变化本身也入签
  result.inputSig = jobInputSig(job)
  staleJobIds.delete(job.id)
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
  // 微调不改排样输入，签名仍一致；只重写一次本机存储
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
    wMm: input.wMm,
    hMm: input.hMm,
    thicknessMm: input.thicknessMm,
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

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm）。默认库已有 18/25/9 三种板，直接复用，不再追加重复规格。 */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards.find((b) => b.thicknessMm === 18)! // 颗粒板 18mm
  const back = job.boards.find((b) => b.thicknessMm === 9)! // 中纤背板 9mm
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
    // 衣柜（25mm 厚板做顶板见光）
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
    const obj = JSON.parse(json) as Partial<Job>
    if (!obj.parts || !obj.boards) return null
    const job = migrateJob(obj, makeBoard)
    job.id = uid('job')
    job.createdAt = Date.now()
    state.jobs.unshift(job)
    persist()
    return job
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts)
  }
}

export { boardsData }
