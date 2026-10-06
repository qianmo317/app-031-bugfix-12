<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  runNest,
  newPart,
  addPart,
  removePart,
  updatePart,
  allStockTemplates,
  addBoard,
  removeBoard,
  updateBoard,
  renameBoard,
  setTrim,
  setKerf,
  setAutoKey,
  saveJob,
  NestBlockedError,
  type RemoveMode
} from '../lib/store'
import { parsePartText, parseEdges, money } from '../lib/format'
import { toast } from '../lib/ui'
import {
  boardAutoKey,
  boardErrors,
  partBoardWarnings,
  partError,
  trimError,
  autoKeyLabel
} from '../lib/boards'
import type { EdgeSide, Part } from '../types'

const route = useRoute()
const router = useRouter()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))

const importOpen = ref(false)
const importText = ref('')
const importErr = ref<string[]>([])
const importReplace = ref(false)
const running = ref(false)

const grainLabel: Record<Part['grain'], string> = {
  length: '竖纹',
  width: '横纹',
  none: '无要求'
}
const edgeDefs: { key: EdgeSide; label: string }[] = [
  { key: 'top', label: '上' },
  { key: 'bottom', label: '下' },
  { key: 'left', label: '左' },
  { key: 'right', label: '右' }
]

const totalPieces = computed(() => job.value?.parts.reduce((a, p) => a + (p.qty || 0), 0) ?? 0)
const totalArea = computed(
  () => (job.value?.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0) ?? 0) / 1e6
)

const availableOffcuts = computed(() => state.offcuts.filter((o) => o.available))

// ---------- 板材库 ----------

const boardErrMap = computed(() => {
  const m = new Map<string, { field?: string; message: string }[]>()
  if (!job.value) return m
  for (const e of boardErrors(job.value.boards, job.value.trimMm)) {
    const arr = m.get(e.boardId) ?? []
    arr.push({ field: e.field, message: e.message })
    m.set(e.boardId, arr)
  }
  return m
})

const autoKeyOptions = computed(() => {
  if (!job.value) return []
  const map = new Map<string, number>()
  for (const b of job.value.boards) {
    if (b.kind === 'offcut') continue
    map.set(boardAutoKey(b), (map.get(boardAutoKey(b)) ?? 0) + 1)
  }
  return [...map.entries()].map(([key, n]) => ({ key, label: `${autoKeyLabel(key)}（${n} 种板）` }))
})

function onPickTemplate(e: Event): void {
  const sel = e.target as HTMLSelectElement
  const i = Number(sel.value)
  sel.selectedIndex = 0
  if (!job.value || i < 0) return
  const t = allStockTemplates()[i]
  const res = addBoard(job.value, t)
  if (!res.ok) toast(res.error, 'bad', 4200)
  else toast(`已添加「${res.board.name}」`, 'good')
}

const customOpen = ref(false)
const customForm = reactive({
  name: '',
  material: '颗粒板',
  wMm: 2440,
  hMm: 1220,
  thicknessMm: 18,
  priceCents: 13800,
  quantity: 0
})
function openCustom(): void {
  customForm.name = ''
  customForm.material = '颗粒板'
  customForm.wMm = 2440
  customForm.hMm = 1220
  customForm.thicknessMm = 18
  customForm.priceCents = 13800
  customForm.quantity = 0
  customOpen.value = true
}
function submitCustom(): void {
  if (!job.value) return
  const w = Math.round(Number(customForm.wMm))
  const h = Math.round(Number(customForm.hMm))
  const th = Math.round(Number(customForm.thicknessMm))
  const name = customForm.name.trim() || `${customForm.material.trim() || '板材'} ${Math.max(w, h)}×${Math.min(w, h)}×${th}`
  const res = addBoard(job.value, {
    name,
    material: customForm.material,
    wMm: w,
    hMm: h,
    thicknessMm: th,
    priceCents: Math.max(0, Math.round(Number(customForm.priceCents) || 0)),
    quantity: Math.max(0, Math.round(Number(customForm.quantity) || 0)),
    kind: 'stock' as const
  })
  if (!res.ok) {
    toast(res.error, 'bad', 4200)
    return
  }
  toast(`已添加「${res.board.name}」`, 'good')
  customOpen.value = false
}

// 通用确认弹窗（删板两条路 / 改薄确认共用）
const confirmState = reactive({
  open: false,
  title: '',
  body: '',
  parts: [] as Part[],
  kind: 'delete' as 'delete' | 'thickness',
  boardId: '',
  mode: 'reject' as RemoveMode
})
const confirmAction = ref<null | ((proceed: boolean, mode: RemoveMode) => void)>(null)

function askRemove(boardId: string): void {
  const j = job.value
  if (!j) return
  const board = j.boards.find((b) => b.id === boardId)
  if (!board) return
  if (j.boards.length <= 1) {
    toast('最后一种板不许删：库里必须至少留一种板', 'bad', 3600)
    return
  }
  const parts = j.parts.filter((p) => p.boardId === boardId)
  confirmState.kind = 'delete'
  confirmState.boardId = boardId
  confirmState.title = `删除板材「${board.name}」`
  confirmState.parts = parts
  confirmState.mode = 'reject'
  if (parts.length === 0) {
    // 没有零件指着：直接删，不必走两条路
    const r = removeBoard(j, boardId, 'reject')
    if (r.ok) toast('板材已删除，旧排样已作废', 'good')
    else toast(r.error ?? '删除失败', 'bad')
    return
  }
  confirmState.body = `有 ${parts.length} 种零件正指定使用这块板。删除方式两条路只能选一条：`
  confirmState.open = true
  confirmAction.value = (proceed, mode) => {
    if (!proceed || !j) return
    const r = removeBoard(j, boardId, mode)
    if (!r.ok) {
      toast(r.error ?? '删除被拦住', 'bad', 4200)
      return
    }
    if (mode === 'detach' && r.detached && r.detached.length > 0) {
      toast(
        `已删除，并把 ${r.detached.length} 种零件改回自动挑板；它们对厚度/材质的要求已清空，旧排样与已发单据作废`,
        'bad',
        5200
      )
    } else {
      toast('板材已删除，旧排样已作废', 'good')
    }
  }
}

function chooseDelete(mode: RemoveMode): void {
  confirmState.mode = mode
}
function confirmProceed(): void {
  const action = confirmAction.value
  confirmState.open = false
  confirmAction.value = null
  action?.(true, confirmState.mode)
}
function confirmCancel(): void {
  const action = confirmAction.value
  confirmState.open = false
  confirmAction.value = null
  action?.(false, 'reject')
}

function onTrimChange(e: Event): void {
  const j = job.value
  if (!j) return
  const input = e.target as HTMLInputElement
  const v = Math.round(Number(input.value))
  const prev = j.trimMm
  const hadResult = !!j.result
  const r = setTrim(j, v)
  input.value = String(j.trimMm)
  if (!r.ok) {
    toast(r.error ?? '修边量不合法', 'bad', 4200)
  } else if (j.trimMm !== prev && hadResult) {
    toast('修边量已更新，旧排样已作废，请重新排样', 'info')
  }
}
function onKerfChange(e: Event): void {
  const j = job.value
  if (!j) return
  const input = e.target as HTMLInputElement
  const r = setKerf(j, Number(input.value))
  if (!r.ok) {
    input.value = String(j.kerfMm)
    toast(r.error ?? '锯路不合法', 'bad')
  } else {
    input.value = String(j.kerfMm)
  }
}
function onAutoKeyChange(e: Event): void {
  const j = job.value
  if (!j) return
  setAutoKey(j, (e.target as HTMLSelectElement).value)
  toast('已切换自动挑板的厚度/材质分组，旧排样已作废', 'info')
}

/** 板的尺寸/厚度/材质就地编辑入口（名称单独走 rename，不弹确认）。 */
function onBoardNameInput(boardId: string, e: Event): void {
  const j = job.value
  if (!j) return
  renameBoard(j, boardId, (e.target as HTMLInputElement).value)
}
function onBoardField(boardId: string, field: 'wMm' | 'hMm' | 'thicknessMm' | 'material' | 'priceCents' | 'quantity', e: Event): void {
  const j = job.value
  if (!j) return
  const board = j.boards.find((b) => b.id === boardId)
  if (!board) return
  const input = e.target as HTMLInputElement
  const raw = field === 'material' ? input.value : Number(input.value)
  const patch = { [field]: raw }
  const r = updateBoard(j, boardId, patch)
  if ('needConfirm' in r) {
    // 改薄/改材质组：先点出受影响零件再确认
    confirmState.kind = 'thickness'
    confirmState.boardId = boardId
    confirmState.title = `修改板材「${board.name}」的厚度/材质`
    confirmState.parts = r.parts
    confirmState.body = r.message
    confirmState.open = true
    input.value = String(board[field] as string | number)
    confirmAction.value = (proceed) => {
      if (!proceed || !j) {
        // 取消：输入框恢复原值
        input.value = String(board[field] as string | number)
        return
      }
      const rr = updateBoard(j, boardId, patch, { confirmThickness: true })
      if (rr.ok) toast('已写回本机存储，受影响件仍沿用该板，旧排样已作废', 'good')
      else if ('error' in rr) toast(rr.error, 'bad')
    }
    return
  }
  if (!r.ok) {
    toast(r.error, 'bad', 4200)
    // 回滚输入框显示
    input.value = String(board[field] as string | number)
  }
}

function toggleOffcut(id: string): void {
  if (!job.value) return
  const arr = job.value.useOffcutIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  saveJob(job.value)
}
function onBatchChange(e: Event): void {
  if (!job.value) return
  job.value.batchByCabinet = (e.target as HTMLInputElement).checked
  saveJob(job.value)
}

// ---------- 零件 ----------

function addNewPart(): void {
  if (!job.value) return
  addPart(
    job.value,
    newPart({
      code: `P${(job.value.parts.length + 1).toString().padStart(2, '0')}`,
      name: '新零件',
      boardId: ''
    })
  )
}
function onPartField(p: Part, field: 'lenMm' | 'widMm' | 'qty' | 'code' | 'name' | 'cabinet', e: Event): void {
  const j = job.value
  if (!j) return
  const input = e.target as HTMLInputElement
  const raw = field === 'code' || field === 'name' || field === 'cabinet' ? input.value : Number(input.value)
  const err = updatePart(j, p.id, { [field]: raw })
  if (err) {
    toast(`「${p.code || p.name}」${fieldLabel(field)}：${err}，已恢复原值`, 'bad', 3600)
    input.value = String(p[field])
  }
}
function fieldLabel(f: string): string {
  return { lenMm: '长', widMm: '宽', qty: '数量', code: '编号', name: '名称', cabinet: '柜体' }[f] ?? f
}
function onPartSelect(p: Part, field: 'grain' | 'boardId' | 'exposed', e: Event): void {
  const j = job.value
  if (!j) return
  const val =
    field === 'exposed' ? (e.target as HTMLInputElement).checked : (e.target as HTMLSelectElement).value
  updatePart(j, p.id, { [field]: val })
}
function toggleEdge(p: Part, edge: EdgeSide): void {
  const j = job.value
  if (!j) return
  const edges = p.edgeBands.includes(edge)
    ? p.edgeBands.filter((x) => x !== edge)
    : [...p.edgeBands, edge]
  updatePart(j, p.id, { edgeBands: edges })
}
function duplicatePart(p: Part): void {
  if (!job.value) return
  const idx = job.value.parts.findIndex((x) => x.id === p.id)
  const copy = newPart({
    code: p.code ? `${p.code}-复` : '',
    name: p.name,
    lenMm: p.lenMm,
    widMm: p.widMm,
    qty: p.qty,
    grain: p.grain,
    edgeBands: [...p.edgeBands],
    cabinet: p.cabinet,
    exposed: p.exposed,
    boardId: p.boardId
  })
  job.value.parts.splice(idx + 1, 0, copy)
  job.value.result = undefined
  saveJob(job.value)
}

const partRowError = (p: Part): string | null => partError(p)
const warnings = computed(() => (job.value ? partBoardWarnings(job.value) : []))
const warningByPart = computed(() => {
  const m = new Map<string, string>()
  for (const w of warnings.value) m.set(w.partId, w.message)
  return m
})
const trimWarn = computed(() => (job.value ? trimError(job.value.boards, job.value.trimMm) : null))

function doImport(): void {
  if (!job.value) return
  const { rows, errors } = parsePartText(importText.value)
  importErr.value = errors
  if (rows.length === 0) {
    toast('没有可导入的行', 'bad')
    return
  }
  const built = rows.map((r) =>
    newPart({
      code: r.code || `P${Math.floor(Math.random() * 9000 + 1000)}`,
      name: r.name,
      lenMm: r.lenMm,
      widMm: r.widMm,
      qty: r.qty,
      grain: r.grain as Part['grain'],
      edgeBands: parseEdges(r.edges),
      cabinet: r.cabinet,
      exposed: r.exposed,
      boardId: ''
    })
  )
  if (importReplace.value) job.value.parts = built
  else job.value.parts.push(...built)
  job.value.result = undefined
  saveJob(job.value)
  toast(`已导入 ${built.length} 条（板材请在清单里逐行指定，不指定=自动挑板）`, 'good')
  importOpen.value = false
  importText.value = ''
}

async function doNest(): Promise<void> {
  const j = job.value
  if (!j) return
  if (j.parts.length === 0) {
    toast('请先添加零件', 'bad')
    return
  }
  running.value = true
  try {
    const r = runNest(j)
    if (r.unplaced.length > 0) {
      toast(`${r.unplaced.reduce((a, u) => a + u.qty, 0)} 件未排下，请看排样页逐条原因`, 'bad', 4600)
    } else {
      toast(`排样完成：${r.boardsUsed} 张板，${r.elapsedMs}ms`, 'good')
    }
    router.push(`/nest/${j.id}`)
  } catch (err) {
    if (err instanceof NestBlockedError) {
      toast(`还不能排样：${err.blockers.slice(0, 2).join('；')}${err.blockers.length > 2 ? ' 等' : ''}`, 'bad', 5200)
    } else {
      toast('排样失败，请检查输入', 'bad')
    }
  } finally {
    running.value = false
  }
}

const sampleTsv = `名称\t长\t宽\t数量\t纹理\t封边\t柜体\t见光
门板\t2200\t450\t2\t竖纹\t上下左右\t衣柜\t是
层板\t550\t560\t4\t无\t左右\t衣柜\t否`
</script>

<template>
  <div v-if="job">
    <div class="row wrap" style="margin-bottom: 14px">
      <input v-model="job.name" class="job-name" @change="saveJob(job)" />
      <span class="tag">创建于 {{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
      <span v-if="job.result" class="tag good">已排样（改动库/零件后自动作废重算）</span>
      <span v-else class="tag">未排样</span>
      <div class="spacer" />
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>

    <!-- 参数与余料 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row wrap" style="align-items: flex-end">
        <label class="field" style="width: 130px">
          <span>锯路 kerf (mm)</span>
          <input
            :value="job.kerfMm"
            type="number"
            step="0.1"
            min="1"
            max="8"
            @change="onKerfChange"
          />
        </label>
        <label class="field" style="width: 130px">
          <span>四周修边 (mm，两侧各扣一份)</span>
          <input
            :value="job.trimMm"
            type="number"
            step="1"
            min="0"
            max="60"
            @change="onTrimChange"
          />
        </label>
        <label class="field" style="width: 220px">
          <span>自动挑板组（不指定板材的件只在该 厚度+材质 组里选）</span>
          <select :value="job.autoBoardKey" @change="onAutoKeyChange">
            <option v-for="o in autoKeyOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </label>
        <label class="field row" style="margin-bottom: 10px">
          <input type="checkbox" :checked="job.batchByCabinet" @change="onBatchChange" />
          <span style="margin: 0 0 0 6px">按柜体批次分组开料</span>
        </label>
      </div>
      <p v-if="trimWarn" class="inline-bad">⚠ {{ trimWarn }}</p>
      <p class="small muted">
        单位与精度：板幅/零件长宽/修边量为整数毫米，锯路 1 位小数（默认 3.2）；可用板幅 = 板长 − 2×修边、板宽 − 2×修边；
        竖纹比「长边对板长、短边对板宽」，横纹比「长边对板宽、短边对板长」。
      </p>
      <div v-if="availableOffcuts.length > 0">
        <h4 style="margin: 8px 0 6px; font-size: 13px">余料优先：勾选已登记余料作为小板材参与本单排样</h4>
        <div class="row wrap">
          <label
            v-for="o in availableOffcuts"
            :key="o.id"
            class="offcut-chip"
            :class="{ on: job.useOffcutIds.includes(o.id) }"
          >
            <input type="checkbox" :checked="job.useOffcutIds.includes(o.id)" @change="toggleOffcut(o.id)" />
            {{ o.wMm }}×{{ o.hMm}}×{{ o.thicknessMm }} {{ o.material }}（{{ o.jobName }}）
          </label>
        </div>
      </div>
    </section>

    <!-- 板材库 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">板材库（{{ job.boards.length }} 种）</h3>
        <span class="tag">同规格不可重复添加</span>
        <div class="spacer" />
        <select style="width: 280px" @change="onPickTemplate">
          <option value="-1">＋ 从常用规格添加…</option>
          <option v-for="(t, i) in allStockTemplates()" :key="i" :value="i">{{ t.name }} {{ money(t.priceCents) }}</option>
        </select>
        <button class="sm" @click="openCustom">添加自定义板</button>
      </div>
      <table class="grid board-table">
        <thead>
          <tr>
            <th>名称/材质</th><th>长(mm)</th><th>宽(mm)</th><th>厚(mm)</th>
            <th>单价</th><th>库存张数(0=不限)</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in job.boards" :key="b.id" :class="{ 'row-bad': (boardErrMap.get(b.id)?.length ?? 0) > 0 }">
            <td>
              <input :value="b.name" @change="onBoardNameInput(b.id, $event)" />
              <input :value="b.material" class="sub-input" placeholder="材质" @change="onBoardField(b.id, 'material', $event)" />
            </td>
            <td style="width: 96px"><input :value="b.wMm" type="number" @change="onBoardField(b.id, 'wMm', $event)" /></td>
            <td style="width: 96px"><input :value="b.hMm" type="number" @change="onBoardField(b.id, 'hMm', $event)" /></td>
            <td style="width: 84px"><input :value="b.thicknessMm" type="number" @change="onBoardField(b.id, 'thicknessMm', $event)" /></td>
            <td style="width: 110px"><input :value="b.priceCents" type="number" min="0" @change="onBoardField(b.id, 'priceCents', $event)" /></td>
            <td style="width: 130px"><input :value="b.quantity" type="number" min="0" @change="onBoardField(b.id, 'quantity', $event)" /></td>
            <td style="width: 46px">
              <button
                class="sm ghost-danger"
                :disabled="job.boards.length <= 1"
                :title="job.boards.length <= 1 ? '最后一种板不许删' : '删除该板'"
                @click="askRemove(b.id)"
              >删</button>
            </td>
          </tr>
        </tbody>
      </table>
      <template v-for="b in job.boards" :key="'e' + b.id">
        <p v-if="(boardErrMap.get(b.id)?.length ?? 0) > 0" style="margin: 2px 0 0">
          <span v-for="(e, i) in boardErrMap.get(b.id) ?? []" :key="i" class="inline-bad">
            「{{ b.name }}」{{ e.message }}
          </span>
        </p>
      </template>
    </section>

    <!-- 零件清单 -->
    <section class="panel">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">零件清单</h3>
        <span class="tag">{{ job.parts.length }} 种 / {{ totalPieces }} 件 / {{ totalArea.toFixed(2) }}m²</span>
        <div class="spacer" />
        <button class="sm" @click="importOpen = !importOpen">批量粘贴导入</button>
        <button class="sm primary" @click="addNewPart">＋ 添加零件</button>
      </div>

      <div v-if="importOpen" class="import-box">
        <p class="small muted">
          支持 Excel 直接粘贴（制表符分隔），列：名称/长/宽/数量/纹理(竖|横|无)/封边(上下左右)/柜体/见光(是)。
          无表头时按「名称,长,宽,数量,纹理,封边,柜体,见光」顺序解析。长宽为零或负的行会被拒绝。
        </p>
        <textarea v-model="importText" rows="6" :placeholder="sampleTsv"></textarea>
        <p v-for="(e, i) in importErr" :key="i" class="small" style="color: var(--c-bad)">{{ e }}</p>
        <div class="row" style="margin-top: 6px">
          <label class="row small"><input type="checkbox" v-model="importReplace" /> 替换当前清单</label>
          <div class="spacer" />
          <button class="sm" @click="importOpen = false">取消</button>
          <button class="sm primary" @click="doImport">解析并导入</button>
        </div>
      </div>

      <div v-if="warnings.length > 0" class="warn-box">
        <div v-for="w in warnings" :key="w.partId">⚠️ {{ w.message }}</div>
      </div>

      <div class="table-scroll">
        <table class="grid parts-table">
          <thead>
            <tr>
              <th style="width: 80px">编号</th>
              <th style="width: 130px">名称</th>
              <th style="width: 80px">长(mm)</th>
              <th style="width: 80px">宽(mm)</th>
              <th style="width: 64px">数量</th>
              <th style="width: 92px">纹理</th>
              <th style="width: 132px">封边</th>
              <th style="width: 110px">柜体/房间</th>
              <th style="width: 70px">见光</th>
              <th style="width: 150px">指定板材</th>
              <th style="width: 78px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in job.parts" :key="p.id" :class="{ 'row-bad': !!partRowError(p) || warningByPart.has(p.id) }">
              <td><input :value="p.code" @change="onPartField(p, 'code', $event)" /></td>
              <td><input :value="p.name" @change="onPartField(p, 'name', $event)" /></td>
              <td><input :value="p.lenMm" type="number" min="1" @change="onPartField(p, 'lenMm', $event)" /></td>
              <td><input :value="p.widMm" type="number" min="1" @change="onPartField(p, 'widMm', $event)" /></td>
              <td><input :value="p.qty" type="number" min="1" @change="onPartField(p, 'qty', $event)" /></td>
              <td>
                <select :value="p.grain" @change="onPartSelect(p, 'grain', $event)">
                  <option v-for="(lab, g) in grainLabel" :key="g" :value="g">{{ lab }}</option>
                </select>
              </td>
              <td>
                <div class="edge-group">
                  <label v-for="ed in edgeDefs" :key="ed.key" class="edge-cb" :class="{ on: p.edgeBands.includes(ed.key) }">
                    <input type="checkbox" :checked="p.edgeBands.includes(ed.key)" @change="toggleEdge(p, ed.key)" />
                    {{ ed.label }}
                  </label>
                </div>
              </td>
              <td><input :value="p.cabinet" @change="onPartField(p, 'cabinet', $event)" /></td>
              <td style="text-align: center">
                <input type="checkbox" :checked="p.exposed" @change="onPartSelect(p, 'exposed', $event)" />
              </td>
              <td>
                <select :value="p.boardId" @change="onPartSelect(p, 'boardId', $event)">
                  <option value="">自动（{{ autoKeyLabel(job.autoBoardKey ?? '') }}）</option>
                  <option v-for="b in job.boards" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
              </td>
              <td>
                <button class="sm" title="复制一行" @click="duplicatePart(p)">复</button>
                <button class="sm ghost-danger" title="删除" @click="removePart(job, p.id)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="sticky-bar no-print">
      <span>{{ job.parts.length }} 种 / {{ totalPieces }} 件 · 总面积 {{ totalArea.toFixed(2) }}m²</span>
      <div class="spacer" />
      <router-link :to="`/`">返回列表</router-link>
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>

    <!-- 自定义板弹窗 -->
    <div v-if="customOpen" class="modal-mask" @click.self="customOpen = false">
      <div class="modal">
        <h3>添加自定义板</h3>
        <p class="small muted">与库内现有板长×宽×厚×材质完全相同的板不会被添加。尺寸必须为正数。</p>
        <div class="modal-grid">
          <label class="field"><span>名称（可空，自动生成）</span><input v-model="customForm.name" /></label>
          <label class="field"><span>材质</span><input v-model="customForm.material" /></label>
          <label class="field"><span>长 (mm)</span><input v-model.number="customForm.wMm" type="number" min="1" /></label>
          <label class="field"><span>宽 (mm)</span><input v-model.number="customForm.hMm" type="number" min="1" /></label>
          <label class="field"><span>厚 (mm)</span><input v-model.number="customForm.thicknessMm" type="number" min="1" /></label>
          <label class="field"><span>单价（分）</span><input v-model.number="customForm.priceCents" type="number" min="0" /></label>
          <label class="field"><span>库存张数（0=不限）</span><input v-model.number="customForm.quantity" type="number" min="0" /></label>
        </div>
        <div class="row" style="margin-top: 12px">
          <div class="spacer" />
          <button class="sm" @click="customOpen = false">取消</button>
          <button class="sm primary" @click="submitCustom">添加</button>
        </div>
      </div>
    </div>

    <!-- 删板 / 改薄确认弹窗 -->
    <div v-if="confirmState.open" class="modal-mask" @click.self="confirmCancel">
      <div class="modal">
        <h3>{{ confirmState.title }}</h3>
        <p>{{ confirmState.body }}</p>
        <div v-if="confirmState.parts.length > 0" class="affected-box">
          <b>受影响的零件（{{ confirmState.parts.length }} 种）：</b>
          <div class="affected-list">
            <span v-for="p in confirmState.parts" :key="p.id" class="affected-chip">
              {{ p.code || p.name }}（{{ p.lenMm }}×{{ p.widMm }}，{{ grainLabel[p.grain] }}）
            </span>
          </div>
        </div>

        <template v-if="confirmState.kind === 'thickness'">
          <p class="small muted">
            保住用料要求的做法是「取消」，先把这些件改到厚度合适的板；继续写回则这些件会留在改薄后的板上，
            旧排样与已导出的领料单作废、需要重新排样。
          </p>
        </template>
        <template v-else>
          <div
            class="choice"
            :class="{ on: confirmState.mode === 'reject' }"
            @click="chooseDelete('reject')"
          >
            <b>路线一（推荐）：先不删</b>
            <span>保住这些件的用料要求；代价是这块板当场删不动——请先把上面 {{ confirmState.parts.length }} 种零件改指别的板或改回自动。</span>
          </div>
          <div
            class="choice danger"
            :class="{ on: confirmState.mode === 'detach' }"
            @click="chooseDelete('detach')"
          >
            <b>路线二：清空这些件的指定后删除</b>
            <span>当场就能删；代价是它们对厚度/材质的要求丢失，可能被排到厚度或材质对不上的板上。确认后旧存档排样与已导出的领料单一并作废。</span>
          </div>
        </template>

        <div class="row" style="margin-top: 12px">
          <div class="spacer" />
          <button class="sm" @click="confirmCancel">取消</button>
          <button
            v-if="confirmState.kind === 'thickness'"
            class="sm primary"
            @click="confirmProceed"
          >确认写回（受影响件沿用该板）</button>
          <button
            v-else-if="confirmState.mode === 'detach'"
            class="sm danger"
            @click="confirmProceed"
          >我已了解后果，清空指定并删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.offcut-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
}
.offcut-chip.on {
  border-color: var(--c-accent);
  background: #f0faf8;
  color: var(--c-accent);
  font-weight: 600;
}
.sub-input {
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-ink-2);
}
.import-box {
  border: 1px dashed var(--c-line);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
  background: #fafcf9;
}
.warn-box {
  border: 1px solid #f0d9b5;
  background: #fffbeb;
  color: #92600a;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 10px;
}
.inline-bad {
  color: var(--c-bad);
  font-size: 11px;
  margin: 2px 8px 2px 0;
}
.row-bad {
  background: #fff5f5;
}
.table-scroll {
  overflow-x: auto;
}
.parts-table th,
.parts-table td {
  padding: 4px 6px;
}
.parts-table input,
.parts-table select {
  padding: 4px 6px;
  min-width: 0;
}
.edge-group {
  display: flex;
  gap: 2px;
}
.edge-cb {
  font-size: 11px;
  border: 1px solid var(--c-line);
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.edge-cb.on {
  background: #1f2a26;
  color: #fff;
  border-color: #1f2a26;
}
.edge-cb input {
  display: none;
}
.sticky-bar {
  position: sticky;
  bottom: 12px;
  margin-top: 16px;
  background: #1f2a26;
  color: #eef2ee;
  border-radius: 10px;
  padding: 10px 16px;
  display: flex;
  gap: 14px;
  align-items: center;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.25);
}
.sticky-bar a {
  color: #9fb0a7;
}
.job-name {
  width: 300px;
  font-weight: 650;
  font-size: 16px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 20, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 560px;
  max-width: calc(100vw - 40px);
  max-height: 84vh;
  overflow: auto;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.3);
}
.modal h3 {
  font-size: 16px;
  margin-bottom: 8px;
}
.modal-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}
.affected-box {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 10px 0;
  background: #fafcf9;
}
.affected-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.affected-chip {
  font-size: 12px;
  border: 1px solid #d7b3b3;
  background: #fff5f5;
  color: #991b1b;
  border-radius: 999px;
  padding: 2px 10px;
}
.choice {
  border: 1.5px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.choice.on {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.choice.danger.on {
  border-color: var(--c-bad);
  background: #fff5f5;
}
.choice b {
  font-size: 13px;
}
.choice span {
  font-size: 12px;
  color: var(--c-ink-2);
}
button.danger {
  background: var(--c-bad);
  color: #fff;
  border-color: var(--c-bad);
}
</style>
