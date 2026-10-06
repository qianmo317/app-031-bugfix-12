// 板材库 / 零件的领域规则与校验（板材库、零件清单、排样内核、下料单共用同一份结论）
//
// 单位与精度约定（全应用统一）：
// - 板幅、零件长宽、修边量、锯路单位均为毫米 mm；计算保留 1 位小数，展示取整（format.mm）
// - 修边 trimMm 在板的「两侧各扣一份」：可用幅面 = 板宽 - 2*trim、板高 - 2*trim
// - 长边/短边按纹理方向分开比（见 grainAxisMm），不再只拿 max(long) 比板长
// - 金额单位分（cents），展示金额 ¥ 保留 2 位小数；封边米 m 保留 2 位小数
import type { Board, Job, Part, GrainDemand } from '../types'
import boardsData from '../data/boards.json'

/** 新项目默认板材库：常用 18mm 厚板 + 25mm 常用厚板 + 9mm 背板，一种都不能少。 */
export function defaultBoardSpecs(): BoardSpec[] {
  // stockBoards: 0=18 颗粒、2=25 颗粒、6=9 中纤背板
  return [0, 2, 6].map((i) => specOf(boardsData.stockBoards[i]))
}

export interface BoardSpec {
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
}

function specOf(t: BoardSpec): BoardSpec {
  return {
    name: t.name,
    wMm: t.wMm,
    hMm: t.hMm,
    thicknessMm: t.thicknessMm,
    material: t.material,
    priceCents: t.priceCents
  }
}

/** 板材规格键：同 名称/材质/长/宽/厚 视为同一种板，不允许在一个库里出现两条。 */
export function specKey(s: {
  name?: string
  material?: string
  wMm: number
  hMm: number
  thicknessMm: number
}): string {
  return [s.name ?? '', s.material ?? '', mmKey(s.wMm), mmKey(s.hMm), mmKey(s.thicknessMm)].join('|')
}

function mmKey(v: number): string {
  return (Math.round(Number(v) * 10) / 10).toString()
}

export function isDuplicateBoard(boards: Board[], candidate: Omit<Board, 'id'>, exceptId?: string): Board | undefined {
  const key = specKey(candidate)
  return boards.find((b) => b.id !== exceptId && specKey(b) === key)
}

/** 扣掉两侧修边后的可用板幅（mm）。修边两侧各扣一份。 */
export function usableSize(b: Board, trimMm: number): { wMm: number; hMm: number } {
  return { wMm: b.wMm - 2 * trimMm, hMm: b.hMm - 2 * trimMm }
}

/**
 * 零件沿板坐标系（x=板长边方向, y=板短边方向）的就位尺寸，按纹理方向分开。
 * - length 竖纹：零件长边沿板长(x)，禁止旋转
 * - width 横纹：零件宽边沿板长(x)，禁止旋转
 * - none：可旋转，两个方向都试
 */
export function grainAxisMm(p: Pick<Part, 'grain' | 'lenMm' | 'widMm'>): {
  along: number
  across: number
  alongName: string
  acrossName: string
} {
  if (p.grain === 'width') {
    // 横纹：录入的「宽」沿板的长边
    return { along: p.widMm, across: p.lenMm, alongName: '宽', acrossName: '长' }
  }
  // 竖纹 / 无要求：录入的「长」沿板的长边
  return { along: p.lenMm, across: p.widMm, alongName: '长', acrossName: '宽' }
}

/** 零件（纹理朝向固定后）能否放进某块板扣完修边的可用幅面。 */
export function partFitsBoard(
  p: Pick<Part, 'grain' | 'lenMm' | 'widMm'>,
  b: Board,
  trimMm: number
): boolean {
  const { wMm, hMm } = usableSize(b, trimMm)
  const g = grainAxisMm(p)
  const fixed = p.grain !== 'none'
  if (fixed) return g.along <= wMm && g.across <= hMm
  // 无纹理：正向或旋转 90° 任一放得下即可
  return (
    (g.along <= wMm && g.across <= hMm) || (g.across <= wMm && g.along <= hMm)
  )
}

export function validatePositiveMm(v: number, label: string): string | null {
  if (!Number.isFinite(v)) return `${label}必须是数字`
  if (v <= 0) return `${label}必须大于 0（mm），不能为 0 或负数`
  return null
}

/** 板字段校验；返回错误信息（null = 通过）。长宽厚当场拦住 0/负数。 */
export function validateBoardFields(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  priceCents: number
  quantity: number
}): string | null {
  for (const [v, label] of [
    [input.wMm, '板长'],
    [input.hMm, '板宽'],
    [input.thicknessMm, '厚度']
  ] as [number, string][]) {
    const err = validatePositiveMm(v, label)
    if (err) return err
  }
  if (!Number.isFinite(input.priceCents) || input.priceCents < 0) return '单价不能为负数'
  if (!Number.isInteger(input.quantity) || input.quantity < 0) return '库存张数须为 ≥0 的整数（0=不限）'
  return null
}

/** 修边量检查：两侧各扣一份后，每种板两个方向都必须还剩可开料的幅面。 */
export function validateTrimMm(trimMm: number, kerfMm: number, boards: Board[]): string | null {
  if (!Number.isFinite(trimMm) || trimMm < 0) return '修边量不能为负数'
  if (!Number.isFinite(kerfMm) || kerfMm < 0) return '锯路不能为负数'
  for (const b of boards) {
    const { wMm, hMm } = usableSize(b, trimMm)
    if (wMm <= 0 || hMm <= 0) {
      return `修边 ${trimMm}mm 两侧各扣一份后，「${b.name}」(${b.wMm}×${b.hMm}) 已没有可用幅面，修边量须 < ${Math.floor(
        Math.min(b.wMm, b.hMm) / 2 * 10
      ) / 10}mm`
    }
  }
  return null
}

/** 零件字段校验（当场拦住 0/负数长宽、非正数量）。 */
export function validatePartFields(input: {
  lenMm: number
  widMm: number
  qty: number
}): string | null {
  const errL = validatePositiveMm(input.lenMm, '零件长')
  if (errL) return errL
  const errW = validatePositiveMm(input.widMm, '零件宽')
  if (errW) return errW
  if (!Number.isInteger(input.qty) || input.qty <= 0) return '数量须为 ≥1 的整数'
  return null
}

export interface PartWarning {
  partId: string
  code: string
  level: 'bad' | 'warn'
  text: string
}

/** 指定某块板的零件清单（删板/改厚度前要点名）。 */
export function partsReferencingBoard(job: Job, boardId: string): Part[] {
  return job.parts.filter((p) => p.boardId === boardId)
}

/**
 * 零件清单相对板材库的提醒，按纹理方向分别比「扣完两侧修边的可用板幅」：
 * - 尺寸非法的件：bad（排样会被拦下）
 * - 指定板已不在库：bad（存档兼容/删板后遗留，引导改回自动）
 * - 指定板放不下：bad，逐方向点名超的是长向还是短向
 * - 自动挑板但库里没有一块放得下：bad
 * - 修边量本身非法：bad（来自 validateTrimMm）
 */
export function partWarnings(job: Job): PartWarning[] {
  const out: PartWarning[] = []
  const trimErr = validateTrimMm(job.trimMm, job.kerfMm, job.boards)
  if (trimErr) out.push({ partId: '', code: '', level: 'bad', text: trimErr })

  for (const p of job.parts) {
    const tag = p.code || p.name || '未编号零件'
    const fieldErr = validatePartFields(p)
    if (fieldErr) {
      out.push({ partId: p.id, code: p.code, level: 'bad', text: `「${tag}」${fieldErr}` })
      continue
    }
    const g = grainAxisMm(p)
    const overText = (b: Board): string => {
      const { wMm, hMm } = usableSize(b, job.trimMm)
      const misses: string[] = []
      if (g.along > wMm) misses.push(`${g.alongName}边 ${g.along}mm 超过可用板长 ${wMm}mm`)
      if (g.across > hMm) misses.push(`${g.acrossName}边 ${g.across}mm 超过可用板宽 ${hMm}mm`)
      return misses.join('；')
    }
    if (p.boardId) {
      const b = job.boards.find((x) => x.id === p.boardId)
      if (!b) {
        out.push({
          partId: p.id,
          code: p.code,
          level: 'bad',
          text: `「${tag}」指定的板材已不在库中，请重新指定或改回自动挑板`
        })
      } else if (!partFitsBoard(p, b, job.trimMm)) {
        const grainNote = p.grain === 'none' ? '' : p.grain === 'length' ? '（竖纹不可旋转）' : '（横纹不可旋转）'
        out.push({
          partId: p.id,
          code: p.code,
          level: 'bad',
          text: `「${tag}」指定「${b.name}」排不下${grainNote}：${overText(b)}（已扣两侧修边 ${job.trimMm}mm）`
        })
      }
      continue
    }
    // 自动挑板：库里任何一块（含勾选余料由排样内核另行考虑，这里只比项目板材库）放得下即可
    const anyFits = job.boards.some((b) => partFitsBoard(p, b, job.trimMm))
    if (job.boards.length === 0) {
      out.push({ partId: p.id, code: p.code, level: 'bad', text: `「${tag}」无法排样：板材库为空，请先添加板材` })
    } else if (!anyFits) {
      const biggest = [...job.boards].sort((a, b) => b.wMm * b.hMm - a.wMm * a.hMm)[0]
      const grainNote = p.grain === 'none' ? '' : p.grain === 'length' ? '（竖纹不可旋转）' : '（横纹不可旋转）'
      out.push({
        partId: p.id,
        code: p.code,
        level: 'bad',
        text: `「${tag}」${grainNote}库中没有放得下的板：相对最大的「${biggest.name}」，${overText(biggest)}（已扣两侧修边 ${job.trimMm}mm）`
      })
    }
  }
  return out
}

/** 排样前的硬校验：有任一错误返回第一条；通过返回 null。 */
export function validateJobForNest(job: Job): string | null {
  if (job.boards.length === 0) return '板材库为空，请先添加至少一种板材'
  for (const b of job.boards) {
    const err = validateBoardFields(b)
    if (err) return `板材「${b.name}」：${err}`
  }
  const trimErr = validateTrimMm(job.trimMm, job.kerfMm, job.boards)
  if (trimErr) return trimErr
  if (job.parts.length === 0) return '请先添加零件'
  for (const p of job.parts) {
    const err = validatePartFields(p)
    if (err) return `零件「${p.code || p.name}」：${err}`
  }
  return null
}

/**
 * 排样输入签名：板/零件/锯路/修边/余料勾选/分组任一改动都会变。
 * 结果上的签名与当前输入不一致即作废重排，保证板材库、零件指定、排样挑中的板、
 * 下料单/成本表按板种汇总永远是同一份结论（库里删了板，单据上不会再留那一行）。
 */
export function jobInputSig(job: Job): string {
  const board = (b: Board): string =>
    [b.id, specKey(b), mmKey(b.priceCents / 100), b.quantity, b.kind ?? 'stock', b.offcutId ?? ''].join('#')
  const part = (p: Part): string =>
    [
      p.id,
      mmKey(p.lenMm),
      mmKey(p.widMm),
      p.qty,
      p.grain,
      p.edgeBands.join(''),
      p.cabinet,
      p.exposed ? 1 : 0,
      p.boardId ?? ''
    ].join('#')
  return [
    job.kerfMm,
    job.trimMm,
    [...job.useOffcutIds].sort().join(','),
    job.batchByCabinet ? 1 : 0,
    job.boards.map(board).join('//'),
    job.parts.map(part).join('//')
  ].join('@@')
}

/** 老存档兼容：把读回来的 job 规整到当前模型（默认值接上、悬挂引用清掉、旧结果作废）。 */
export function migrateJob(raw: Partial<Job>, makeBoard: (s: BoardSpec) => Board): Job {
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback

  // 板材库：至少保留一块有效板；全空/全坏时按新项目默认库接上
  let boards: Board[] = Array.isArray(raw.boards)
    ? raw.boards
        .filter((b): b is Board => !!b && typeof b === 'object')
        .map((b) => ({
          ...b,
          id: String(b.id || uidFallback('b')),
          name: String(b.name ?? '未命名板材'),
          material: String(b.material ?? ''),
          wMm: num(b.wMm, 0),
          hMm: num(b.hMm, 0),
          thicknessMm: num(b.thicknessMm, 0),
          priceCents: num(b.priceCents, 0),
          quantity: Math.max(0, Math.trunc(num(b.quantity, 0))),
          kind: b.kind === 'offcut' ? 'offcut' : 'stock'
        }))
    : []
  boards = boards.filter(
    (b) => b.wMm > 0 && b.hMm > 0 && b.thicknessMm > 0
  )
  if (boards.length === 0) {
    boards = defaultBoardSpecs().map(makeBoard)
  }
  // 同规格去重（老数据可能有同名多条）：保留第一条，其余 id 并入
  const deduped: Board[] = []
  const alias = new Map<string, string>()
  for (const b of boards) {
    const dup = isDuplicateBoard(deduped, b)
    if (dup) alias.set(b.id, dup.id)
    else deduped.push(b)
  }
  boards = deduped

  const boardIds = new Set(boards.map((b) => b.id))
  const grains = new Set<GrainDemand>(['length', 'width', 'none'])
  const parts: Part[] = Array.isArray(raw.parts)
    ? raw.parts
        .filter((p): p is Part => !!p && typeof p === 'object')
        .map((p) => {
          // 指向已不在库（或并入重复条）的编号：清掉，回到自动挑板，兼容接上
          let boardId = typeof p.boardId === 'string' ? p.boardId : ''
          if (alias.has(boardId)) boardId = alias.get(boardId)!
          if (boardId && !boardIds.has(boardId)) boardId = ''
          return {
            ...p,
            id: String(p.id || uidFallback('p')),
            code: String(p.code ?? ''),
            name: String(p.name ?? ''),
            lenMm: num(p.lenMm, 0),
            widMm: num(p.widMm, 0),
            qty: Math.max(1, Math.trunc(num(p.qty, 1))),
            grain: grains.has(p.grain as GrainDemand) ? (p.grain as GrainDemand) : 'none',
            edgeBands: Array.isArray(p.edgeBands) ? p.edgeBands : [],
            cabinet: String(p.cabinet ?? '未分组'),
            exposed: !!p.exposed,
            boardId
          }
        })
    : []

  const kerfMm = num(raw.kerfMm, boardsData.defaults.kerfMm)
  // 修边量按当前库夹到合法范围（保证最小的板两侧扣完仍有余量）
  const maxTrim = Math.min(...boards.map((b) => Math.min(b.wMm, b.hMm) / 2)) - 0.1
  let trimMm = num(raw.trimMm, boardsData.defaults.trimMm)
  if (!(trimMm >= 0) || trimMm > maxTrim) trimMm = Math.min(boardsData.defaults.trimMm, Math.max(0, maxTrim))

  const job: Job = {
    id: String(raw.id || uidFallback('job')),
    name: String(raw.name ?? '开料项目'),
    createdAt: num(raw.createdAt, Date.now()),
    boards,
    parts,
    kerfMm: Math.max(0, kerfMm),
    trimMm: Math.max(0, trimMm),
    useOffcutIds: Array.isArray(raw.useOffcutIds) ? raw.useOffcutIds.map(String) : [],
    batchByCabinet: !!raw.batchByCabinet,
    // 旧版本结果一律作废重排（结构可能缺字段，且无法证明与当前输入一致）
    result: undefined
  }
  return job
}

let fallbackSeq = 0
function uidFallback(prefix: string): string {
  fallbackSeq += 1
  return `${prefix}_legacy_${Date.now().toString(36)}_${fallbackSeq}`
}
