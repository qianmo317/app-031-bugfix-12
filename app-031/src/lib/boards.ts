// 板材库与零件的「同一份结论」：
// 库、零件清单提醒、排样内核、下料单/成本表全部只认本模块的判定。
//
// 单位与精度（全应用统一）：
// - 板幅、零件长宽、修边量 trim：整数毫米（输入非整数当场四舍五入写回）；
// - 锯路 kerf：1 位小数毫米（默认 3.2，范围 1.0~8.0）；
// - 厚度：整数毫米；单价：分（展示时 /100，保留 2 位）；
// - 可用板幅 = 板长 - 2×trim、板宽 - 2×trim（两侧各扣一份，单位毫米）；
// - 封边米数 2 位小数、利用率百分数 1 位小数、面积 m² 2 位小数。
//
// 纹理方向（长边 = 零件 lenMm，短边 = 零件 widMm，录入时要求 lenMm ≥ widMm）：
// - length 竖纹：零件长边沿板长边方向，需要 长边 ≤ 可用板长 且 短边 ≤ 可用板宽；
// - width 横纹：零件长边沿板宽方向，需要 长边 ≤ 可用板宽 且 短边 ≤ 可用板长；
// - none 无要求：允许旋转，两个方向取其一即可。
import type { Board, Job, Part } from '../types'

export interface BoardError {
  boardId: string
  field?: 'wMm' | 'hMm' | 'thicknessMm' | 'trimMm'
  message: string
}

/** 板材分组键：同规格（长×宽×厚×材质）只许在库里出现一次。 */
export function boardGroupKey(b: Pick<Board, 'wMm' | 'hMm' | 'thicknessMm' | 'material'>): string {
  // 库内统一为长边沿 x
  const w = Math.max(Math.round(b.wMm), Math.round(b.hMm))
  const h = Math.min(Math.round(b.wMm), Math.round(b.hMm))
  return `${w}×${h}×${Math.round(b.thicknessMm)}|${(b.material || '').trim()}`
}

/** 自动挑板（零件未指定板材）时，按 厚度+材质 成组，互不混料。 */
export function boardAutoKey(b: Pick<Board, 'thicknessMm' | 'material'>): string {
  return `${Math.round(b.thicknessMm)}|${(b.material || '').trim()}`
}

export function partDemand(p: Pick<Part, 'lenMm' | 'widMm' | 'grain'>): {
  alongLong: number
  alongShort: number
} {
  // 录入保证 len ≥ wid；横纹时长边沿板宽
  const long = Math.max(p.lenMm, p.widMm)
  const short = Math.min(p.lenMm, p.widMm)
  return { alongLong: long, alongShort: short }
}

/** 单块板扣掉两侧修边后的可用板幅（整数毫米，至少 0）。 */
export function usableSize(b: Pick<Board, 'wMm' | 'hMm'>, trimMm: number): { w: number; h: number } {
  const trim = Math.round(trimMm)
  return {
    w: Math.max(0, Math.round(b.wMm) - 2 * trim),
    h: Math.max(0, Math.round(b.hMm) - 2 * trim)
  }
}

/** 修边量本身是否合法：非负，且两侧扣完后任一板种仍须剩 ≥50mm 可用幅。 */
export function trimError(boards: Pick<Board, 'wMm' | 'hMm'>[], trimMm: number): string | null {
  if (!Number.isFinite(trimMm) || trimMm < 0) return '修边量不能为负数'
  if (boards.length === 0) return null
  const trim = Math.round(trimMm)
  for (const b of boards) {
    const { w, h } = usableSize(b, trim)
    if (w < 50 || h < 50) {
      return `修边量 ${trim}mm 过大：${Math.round(Math.max(b.wMm, b.hMm))}×${Math.round(
        Math.min(b.wMm, b.hMm)
      )}mm 的板两侧各扣一份后只剩 ${w}×${h}mm，无法开料`
    }
  }
  return null
}

export function kerfError(kerfMm: number): string | null {
  if (!Number.isFinite(kerfMm) || kerfMm < 1 || kerfMm > 8) return '锯路必须在 1.0~8.0mm 之间'
  return null
}

/** 库内逐板校验：尺寸/厚度必须为正整数级正数、修边后要有可用幅。 */
export function boardErrors(boards: Board[], trimMm: number): BoardError[] {
  const out: BoardError[] = []
  for (const b of boards) {
    if (!Number.isFinite(b.wMm) || b.wMm <= 0)
      out.push({ boardId: b.id, field: 'wMm', message: '板长必须为正数' })
    if (!Number.isFinite(b.hMm) || b.hMm <= 0)
      out.push({ boardId: b.id, field: 'hMm', message: '板宽必须为正数' })
    if (!Number.isFinite(b.thicknessMm) || b.thicknessMm <= 0)
      out.push({ boardId: b.id, field: 'thicknessMm', message: '厚度必须为正数' })
    if (Number.isFinite(b.wMm) && Number.isFinite(b.hMm) && b.wMm > 0 && b.hMm > 0) {
      const { w, h } = usableSize(b, trimMm)
      if (w < 50 || h < 50)
        out.push({ boardId: b.id, field: 'trimMm', message: '两侧修边后已没有可用板幅' })
    }
  }
  return out
}

/** 库内同规格重复（不含被比较的那一条）。 */
export function findDuplicate(boards: Board[], target: Board): Board | undefined {
  const key = boardGroupKey(target)
  return boards.find((b) => b.id !== target.id && boardGroupKey(b) === key)
}

/** 零件尺寸是否合法（长、宽、数量均为正数；长 ≥ 宽）。 */
export function partError(p: Pick<Part, 'lenMm' | 'widMm' | 'qty'>): string | null {
  if (!Number.isFinite(p.lenMm) || p.lenMm <= 0) return '长必须为正数（mm）'
  if (!Number.isFinite(p.widMm) || p.widMm <= 0) return '宽必须为正数（mm）'
  if (!Number.isFinite(p.qty) || p.qty < 1) return '数量至少为 1'
  return null
}

/** 某块板（给定可用幅）能否以指定纹理摆下该零件。 */
export function fitsBoard(
  p: Pick<Part, 'lenMm' | 'widMm' | 'grain'>,
  usableW: number,
  usableH: number
): boolean {
  const { alongLong, alongShort } = partDemand(p)
  if (p.grain === 'length') return alongLong <= usableW && alongShort <= usableH
  if (p.grain === 'width') return alongLong <= usableH && alongShort <= usableW
  // 无纹理：允许旋转，长边对长边或长边对短边均可
  return (
    (alongLong <= usableW && alongShort <= usableH) ||
    (alongLong <= usableH && alongShort <= usableW)
  )
}

export interface PartBoardWarning {
  partId: string
  level: 'error' | 'warn'
  message: string
}

/**
 * 零件清单相对板材库的全部提醒（库/零件页与排样页共用同一份结论）。
 * - 指定板已不在库里：错误（旧存档兼容后不会发生，删除走确认流程）；
 * - 横纹/竖纹按纹理方向分别比可用板幅（长边与短边分开比）；
 * - 自动件在「同厚度+材质」的板组里找，找不到时说明是厚度/材质对不上。
 */
export function partBoardWarnings(job: Job): PartBoardWarning[] {
  const out: PartBoardWarning[] = []
  const trim = Math.round(job.trimMm)
  const boardById = new Map(job.boards.map((b) => [b.id, b]))
  const usable = (b: Board) => usableSize(b, trim)

  for (const p of job.parts) {
    if (partError(p)) continue // 尺寸非法由输入行就地拦截，不在此重复
    const { alongLong, alongShort } = partDemand(p)

    let candidates: Board[]
    if (p.boardId) {
      const b = boardById.get(p.boardId)
      if (!b) {
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」指定的板材已不在库里，请重新指定或改回自动挑板`
        })
        continue
      }
      candidates = [b]
    } else {
      const key = autoKeyOfJob(job)
      candidates = job.boards.filter((b) => boardAutoKey(b) === key)
      if (candidates.length === 0) {
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」为自动挑板，但库里没有 ${autoKeyLabel(
            key
          )} 的板：只会在同厚度、同材质板之间自动选，请先加板或显式指定板材`
        })
        continue
      }
    }

    const fits = candidates.filter((b) => {
      const { w, h } = usable(b)
      return fitsBoard(p, w, h)
    })
    if (fits.length > 0) continue

    // 摆不下：按纹理方向分别给出是哪条边、相对哪块板超
    const target = candidates[0]
    const { w, h } = usable(target)
    if (p.grain === 'length') {
      const over = alongLong - w
      const overS = alongShort - h
      if (over > 0 && overS > 0)
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」竖纹：长边 ${alongLong} 超出可用板长 ${w}（超 ${over}mm），短边 ${alongShort} 超出可用板宽 ${h}（超 ${overS}mm）；${target.name}`
        })
      else if (over > 0)
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」竖纹：长边 ${alongLong} 超出可用板长 ${w}（超 ${over}mm，已扣两侧修边 ${trim}mm），不可旋转；${target.name}`
        })
      else
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」竖纹：短边 ${alongShort} 超出可用板宽 ${h}（超 ${overS}mm，已扣两侧修边 ${trim}mm）；${target.name}`
        })
    } else if (p.grain === 'width') {
      const over = alongLong - h // 横纹：长边沿板宽方向
      const overS = alongShort - w
      if (over > 0 && overS > 0)
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」横纹：长边 ${alongLong} 超出可用板宽 ${h}（超 ${over}mm），短边 ${alongShort} 超出可用板长 ${w}（超 ${overS}mm）；${target.name}`
        })
      else if (over > 0)
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」横纹：长边 ${alongLong} 超出可用板宽 ${h}（超 ${over}mm，已扣两侧修边 ${trim}mm），不可旋转；${target.name}`
        })
      else
        out.push({
          partId: p.id,
          level: 'error',
          message: `「${p.code}」横纹：短边 ${alongShort} 超出可用板长 ${w}（超 ${overS}mm，已扣两侧修边 ${trim}mm）；${target.name}`
        })
    } else {
      // 无纹理也摆不下：两个方向都超
      const bestLong = Math.max(w, h)
      const bestShort = Math.min(w, h)
      out.push({
        partId: p.id,
        level: 'error',
        message: `「${p.code}」即使旋转也排不下：长边 ${alongLong}、短边 ${alongShort}，可用板幅最大 ${bestLong}×${bestShort}（已扣两侧修边 ${trim}mm）；${target.name}`
      })
    }
  }
  return out
}

/** 自动挑板分组键：以项目设定为准（厚度|材质），缺省取库中第一块常规板。 */
export function autoKeyOfJob(job: Job): string {
  if (job.autoBoardKey) return job.autoBoardKey
  const first = job.boards.find((b) => b.kind !== 'offcut') ?? job.boards[0]
  return first ? boardAutoKey(first) : '18|颗粒板'
}

export function autoKeyLabel(key: string): string {
  const [th, mat] = key.split('|')
  return `${mat || '未填材质'} ${th}mm`
}

/** 列出正使用某块板（或某规格键）的零件，删板/改厚度前必须先点给操作者看。 */
export function partsUsingBoard(job: Job, boardId: string): Part[] {
  return job.parts.filter((p) => p.boardId === boardId)
}

/** 厚度/材质改动会影响哪些件：显式指定该板的件 + 自动件里依赖同 厚度|材质 组的件。 */
export function partsAffectedByBoardChange(
  job: Job,
  before: Pick<Board, 'id' | 'thicknessMm' | 'material'>,
  after: Pick<Board, 'thicknessMm' | 'material'>
): { parts: Part[]; oldKey: string; newKey: string } {
  const oldKey = boardAutoKey(before)
  const newKey = boardAutoKey(after)
  const explicit = job.parts.filter((p) => p.boardId === before.id)
  const auto = oldKey !== newKey ? job.parts.filter((p) => !p.boardId && autoKeyOfJob(job) === oldKey) : []
  return { parts: [...explicit, ...auto], oldKey, newKey }
}

/** 排样前总闸门：库为空、库有错、修边/锯路非法、零件非法时返回错误清单。 */
export function jobBlockingErrors(job: Job): string[] {
  const errs: string[] = []
  if (job.boards.length === 0) errs.push('板材库为空：至少保留一种板（最后一种板不许删）')
  const trimErr = trimError(job.boards, job.trimMm)
  if (trimErr) errs.push(trimErr)
  const kerfErr = kerfError(job.kerfMm)
  if (kerfErr) errs.push(kerfErr)
  for (const be of boardErrors(job.boards, job.trimMm)) errs.push(`板材「${idToName(job, be.boardId)}」：${be.message}`)
  for (const p of job.parts) {
    const pe = partError(p)
    if (pe) errs.push(`零件「${p.code || p.name || '未编号'}」：${pe}`)
  }
  return errs
}

function idToName(job: Job, id: string): string {
  return job.boards.find((b) => b.id === id)?.name ?? '未命名板'
}
