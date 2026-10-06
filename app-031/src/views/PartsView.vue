<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  saveJob,
  runNest,
  newPart,
  allStockTemplates,
  addBoard,
  updateBoard,
  removeBoard,
  isResultStale
} from '../lib/store'
import { parsePartText, parseEdges, money } from '../lib/format'
import { toast } from '../lib/ui'
import { partWarnings, usableSize, validatePartFields, validateTrimMm } from '../lib/boards'
import type { Board, EdgeSide, Part } from '../types'

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
const templates = computed(() => allStockTemplates())

function save(): void {
  if (job.value) saveJob(job.value)
}

// ── 板材库 ───────────────────────────────────────────────────────────────

/** 模板下拉里已在库中的规格（同 名称/材质/长宽厚）禁选。 */
function templateInLibrary(i: number): boolean {
  const j = job.value
  if (!j) return true
  const t = templates.value[i]
  return j.boards.some(
    (b) =>
      b.name === t.name &&
      b.material === t.material &&
      b.wMm === t.wMm &&
      b.hMm === t.hMm &&
      b.thicknessMm === t.thicknessMm
  )
}

function onPickTemplate(e: Event): void {
  const sel = e.target as HTMLSelectElement
  const i = Number(sel.value)
  sel.selectedIndex = 0
  if (i < 0 || !job.value) return
  const r = addBoard(job.value, templates.value[i])
  if (!r.ok) toast(r.error, 'bad', 4000)
  else toast('已添加板材', 'good')
}

/** 自定义板：给一块空白规格，填完再校验；与库内同规格同样拒绝。 */
function addCustomBoard(): void {
  if (!job.value) return
  const r = addBoard(job.value, {
    name: '自定义板材 2440×1220×18',
    wMm: 2440,
    hMm: 1220,
    thicknessMm: 18,
    material: '自定义',
    priceCents: 0
  })
  if (!r.ok) toast(r.error, 'bad', 4000)
}

/**
 * 数值/文本字段编辑：记录原值 → 写入 → 走领域校验 → 失败弹错并回滚。
 * 长宽厚 0/负数、改成重复规格、修边超板，当场拦住，存不进本机。
 */
type BoardPatchField = 'wMm' | 'hMm' | 'thicknessMm' | 'priceCents' | 'quantity' | 'name' | 'material'
function editBoardField<K extends BoardPatchField>(b: Board, key: K, ev: Event): void {
  const j = job.value
  if (!j) return
  const input = ev.target as HTMLInputElement
  const prev = b[key]
  const value = (key === 'name' || key === 'material' ? input.value : Number(input.value)) as Board[K]
  const patch = { [key]: value } as Partial<Pick<Board, BoardPatchField>>
  const res = updateBoard(j, b.id, patch)
  if (res.ok) {
    save()
    return
  }
  if (res.error === '__CONFIRM_THICKNESS__') {
    // 厚度改小：先点出是哪些件，操作者确认取舍后才提交
    const list = res.referring!
    const names = list.slice(0, 8).map((p) => p.code || p.name).join('、')
    const more = list.length > 8 ? ` 等 ${list.length} 种` : ''
    const ok = window.confirm(
      `板材厚度将从 ${prev}mm 改小，以下 ${list.length} 种零件仍指定用它：\n` +
        `${names}${more}\n\n` +
        `这些件的用料要求会与改后的板不一致（可能按错误厚度开料）。确认仍要修改吗？\n` +
        `（点「取消」保留原厚度，先去调整零件）`
    )
    if (ok) {
      const forced = updateBoard(j, b.id, patch, true)
      if (forced.ok) {
        save()
        return
      }
      toast(forced.error, 'bad', 4000)
    }
  } else {
    toast(res.error, 'bad', 4000)
  }
  // 回滚输入框（store 里的值未变，强制把 DOM 值刷回去）
  input.value = String(prev)
}

function onRemoveBoard(bId: string, name: string): void {
  const j = job.value
  if (!j) return
  const probe = removeBoard(j, bId)
  if (probe.ok) return
  if (probe.error === '__CONFIRM_DELETE__') {
    // 删板两条路的取舍，必须说清；本应用走 A 路
    const list = probe.referring!
    const names = list.slice(0, 8).map((p) => p.code || p.name).join('、')
    const more = list.length > 8 ? ` 等 ${list.length} 种` : ''
    const ok = window.confirm(
      `「${name}」正被 ${list.length} 种零件指定使用：\n${names}${more}\n\n` +
        `删除后这些零件的指定会被清掉、回到自动挑板：\n` +
        `· 好处：当场就能删掉这块板；\n` +
        `· 代价：这些件对板厚/材质的要求丢失，重排时可能被排到厚度或材质对不上的板上。\n\n` +
        `另一条路是点「取消」，先把这些零件逐个改指到别的板，再回来删（用料要求不丢，但当下删不动）。\n\n` +
        `确认删除并清除这些零件的指定？`
    )
    if (!ok) return
    const done = removeBoard(j, bId, true)
    if (!done.ok) {
      toast(done.error, 'bad', 4000)
      return
    }
    toast(`已删除「${name}」，${list.length} 种零件回到自动挑板，旧排样结果已作废，请重新排样`, 'good', 4200)
    return
  }
  toast(probe.error, 'bad', 4000)
}

function onTrimInput(ev: Event): void {
  const j = job.value
  if (!j) return
  const input = ev.target as HTMLInputElement
  const prev = j.trimMm
  const v = Number(input.value)
  const err = validateTrimMm(v, j.kerfMm, j.boards)
  if (err) {
    toast(err, 'bad', 4200)
    input.value = String(prev)
    return
  }
  j.trimMm = v
  save()
}
function onKerfInput(ev: Event): void {
  const j = job.value
  if (!j) return
  const input = ev.target as HTMLInputElement
  const prev = j.kerfMm
  const v = Number(input.value)
  if (!(Number.isFinite(v) && v >= 0)) {
    toast('锯路不能为负数', 'bad')
    input.value = String(prev)
    return
  }
  j.kerfMm = v
  save()
}

function usableText(bId: string): string {
  const b = job.value!.boards.find((x) => x.id === bId)
  if (!b) return ''
  const u = usableSize(b, job.value!.trimMm)
  return u.wMm > 0 && u.hMm > 0 ? `${Math.round(u.wMm)}×${Math.round(u.hMm)}` : '—'
}

// ── 零件 ─────────────────────────────────────────────────────────────────

function addPart(): void {
  job.value?.parts.push(
    newPart({
      code: `P${(job.value.parts.length + 1).toString().padStart(2, '0')}`,
      name: '新零件'
    })
  )
  save()
}
function removePart(id: string): void {
  if (!job.value) return
  job.value.parts = job.value.parts.filter((p) => p.id !== id)
  save()
}
function duplicatePart(p: Part): void {
  const idx = job.value!.parts.findIndex((x) => x.id === p.id)
  job.value!.parts.splice(idx + 1, 0, { ...p, id: `p_${Math.random().toString(36).slice(2, 8)}` })
  save()
}
function toggleEdge(p: Part, e: EdgeSide): void {
  const i = p.edgeBands.indexOf(e)
  if (i >= 0) p.edgeBands.splice(i, 1)
  else p.edgeBands.push(e)
  save()
}

/** 零件长宽数量：0/负数当场拦住并回滚。 */
function editPartNum(p: Part, key: 'lenMm' | 'widMm' | 'qty', ev: Event): void {
  const input = ev.target as HTMLInputElement
  const prev = p[key]
  const v = Number(input.value)
  const probe = { ...p, [key]: v }
  const err = validatePartFields(probe)
  if (err) {
    toast(err, 'bad', 3000)
    input.value = String(prev)
    return
  }
  p[key] = v as never
  save()
}

function toggleJobOffcut(id: string): void {
  if (!job.value) return
  const arr = job.value.useOffcutIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  save()
}

/** 指定板材下拉：只允许选库中现有条或「自动」，防止悬挂编号。 */
function onPartBoardChange(p: Part, ev: Event): void {
  const sel = ev.target as HTMLSelectElement
  const v = sel.value
  if (v && !job.value!.boards.some((b) => b.id === v)) {
    sel.value = p.boardId || ''
    toast('该板材已不在库中，请重新选择', 'bad')
    return
  }
  p.boardId = v
  save()
}

// 清单页提醒：尺寸非法 / 指定板缺失或放不下 / 全库无板可排 / 修边过大，
// 一律按纹理方向分别比「扣完两侧修边的可用板幅」
const warnings = computed(() => (job.value ? partWarnings(job.value) : []))
const stale = computed(() => (job.value ? isResultStale(job.value.id) : false))

function doImport(): void {
  if (!job.value) return
  const { rows, errors } = parsePartText(importText.value)
  importErr.value = errors
  if (rows.length === 0) {
    toast('没有可导入的行', 'bad')
    return
  }
  // 与手动录入同一把尺：长宽非正的行解析器已剔除并在 importErr 里逐行点名
  const boardId = job.value.boards[0]?.id ?? ''
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
      boardId
    })
  )
  if (importReplace.value) job.value.parts = built
  else job.value.parts.push(...built)
  save()
  toast(`已导入 ${built.length} 条`, 'good')
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
    if ('error' in r) {
      toast(r.error, 'bad', 4200)
      return
    }
    if (r.unplaced.length > 0) {
      toast(`${r.unplaced.reduce((a, u) => a + u.qty, 0)} 件零件未排下，请看排样页提示`, 'bad', 4200)
    } else {
      toast(`排样完成：${r.boardsUsed} 张板，${r.elapsedMs}ms`, 'good')
    }
    router.push(`/nest/${j.id}`)
  } finally {
    running.value = false
  }
}

const sampleTsv = `名称\t长\t宽\t数量\t纹理\t封边\t柜体\t见光
门板\t2200\t450\t2\t竖纹\t上下左右\t衣柜\t是
层板\t550\t560\t4\t无\t左右\t衣柜\t否`

/** 指定板材下拉里显示库内序号（同名多条已禁止，#序号 + 名称足以辨认）。 */
function boardIndex(id: string): number {
  return job.value ? job.value.boards.findIndex((b) => b.id === id) : -1
}
function boardTag(id: string): string {
  const i = boardIndex(id)
  return i >= 0 ? `#${i + 1}` : ''
}
</script>

<template>
  <div v-if="job">
    <div class="row wrap" style="margin-bottom: 14px">
      <input v-model="job.name" @change="save" style="width: 320px; font-weight: 650; font-size: 16px" />
      <span class="tag">创建于 {{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
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
          <input :value="job.kerfMm" type="number" step="0.1" min="0" max="8" @change="onKerfInput" />
        </label>
        <label class="field" style="width: 130px">
          <span>四周修边 (mm)，两侧各扣一份</span>
          <input :value="job.trimMm" type="number" step="1" min="0" max="20" @change="onTrimInput" />
        </label>
        <label class="field row" style="margin-bottom: 10px">
          <input type="checkbox" v-model="job.batchByCabinet" @change="save" />
          <span style="margin: 0 0 0 6px">按柜体批次分组开料（同柜零件尽量连续排）</span>
        </label>
      </div>
      <p class="small muted" style="margin: 6px 0 0">
        尺寸单位均为毫米（mm），录入精度 1 位小数；可用板幅 = 板长/宽 − 2×修边。修边量填得比板子还大会被当场拒绝。
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
            <input type="checkbox" :checked="job.useOffcutIds.includes(o.id)" @change="toggleJobOffcut(o.id)" />
            {{ o.wMm }}×{{ o.hMm}}×{{ o.thicknessMm }} {{ o.material }}（{{ o.jobName }}）
          </label>
        </div>
      </div>
    </section>

    <!-- 板材库 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">板材库（{{ job.boards.length }} 种）</h3>
        <div class="spacer" />
        <select style="width: 300px" @change="onPickTemplate">
          <option value="-1">＋ 从常用规格添加…</option>
          <option v-for="(t, i) in templates" :key="i" :value="i" :disabled="templateInLibrary(i)">
            {{ templateInLibrary(i) ? '（库中已有）' : '' }}{{ t.name }} {{ money(t.priceCents) }}
          </option>
        </select>
        <button class="sm" @click="addCustomBoard">添加自定义板</button>
      </div>
      <p class="small muted" style="margin: 0 0 8px">
        同名称/材质/长/宽/厚的板只允许一条；改板、删板会同步影响零件指定、排样与下料单——改动后旧排样结果立即作废，需重新排样。
      </p>
      <table class="grid board-table">
        <thead>
          <tr>
            <th style="width: 36px">#</th>
            <th>名称/材质</th><th>长(mm)</th><th>宽(mm)</th><th>厚(mm)</th>
            <th>可用幅面(扣两侧修边)</th>
            <th>单价</th><th>库存张数(0=不限)</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(b, bi) in job.boards" :key="b.id">
            <td class="muted small">{{ bi + 1 }}</td>
            <td>
              <input :value="b.name" @change="editBoardField(b, 'name', $event)" />
              <input :value="b.material" class="sub-input" placeholder="材质" @change="editBoardField(b, 'material', $event)" />
            </td>
            <td style="width: 96px"><input :value="b.wMm" type="number" @change="editBoardField(b, 'wMm', $event)" /></td>
            <td style="width: 96px"><input :value="b.hMm" type="number" @change="editBoardField(b, 'hMm', $event)" /></td>
            <td style="width: 84px"><input :value="b.thicknessMm" type="number" @change="editBoardField(b, 'thicknessMm', $event)" /></td>
            <td class="small muted" style="white-space: nowrap">{{ usableText(b.id) }}</td>
            <td style="width: 110px"><input :value="b.priceCents" type="number" @change="editBoardField(b, 'priceCents', $event)" /></td>
            <td style="width: 130px"><input :value="b.quantity" type="number" min="0" @change="editBoardField(b, 'quantity', $event)" /></td>
            <td style="width: 46px">
              <button
                class="sm ghost-danger"
                :disabled="job.boards.length <= 1"
                :title="job.boards.length <= 1 ? '库里至少要保留一种板' : '删除该板'"
                @click="onRemoveBoard(b.id, b.name)"
              >删</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 零件清单 -->
    <section class="panel">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">零件清单</h3>
        <span class="tag">{{ job.parts.length }} 种 / {{ totalPieces }} 件 / {{ totalArea.toFixed(2) }}m²</span>
        <div class="spacer" />
        <button class="sm" @click="importOpen = !importOpen">批量粘贴导入</button>
        <button class="sm primary" @click="addPart">＋ 添加零件</button>
      </div>

      <div v-if="importOpen" class="import-box">
        <p class="small muted">
          支持 Excel 直接粘贴（制表符分隔），列：名称/长/宽/数量/纹理(竖|横|无)/封边(上下左右)/柜体/见光(是)。
          无表头时按「名称,长,宽,数量,纹理,封边,柜体,见光」顺序解析。长或宽 ≤0 的行会被拒绝并逐行提示。
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

      <div v-if="stale" class="warn-box">
        ⚠️ 板材库或零件在上次排样后被改动，旧排样结果与下料单已作废，请重新排样后再打印/导出。
      </div>
      <div v-if="warnings.length > 0" class="warn-box">
        <div v-for="(w, i) in warnings" :key="i">⚠️ {{ w.text }}</div>
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
            <tr v-for="p in job.parts" :key="p.id">
              <td><input :value="p.code" @change="(e) => { p.code = (e.target as HTMLInputElement).value; save() }" /></td>
              <td><input :value="p.name" @change="(e) => { p.name = (e.target as HTMLInputElement).value; save() }" /></td>
              <td><input :value="p.lenMm" type="number" min="1" @change="editPartNum(p, 'lenMm', $event)" /></td>
              <td><input :value="p.widMm" type="number" min="1" @change="editPartNum(p, 'widMm', $event)" /></td>
              <td><input :value="p.qty" type="number" min="1" @change="editPartNum(p, 'qty', $event)" /></td>
              <td>
                <select v-model="p.grain" @change="save">
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
              <td><input :value="p.cabinet" @change="(e) => { p.cabinet = (e.target as HTMLInputElement).value; save() }" /></td>
              <td style="text-align: center"><input type="checkbox" v-model="p.exposed" @change="save" /></td>
              <td>
                <select :value="p.boardId" @change="onPartBoardChange(p, $event)">
                  <option value="">自动</option>
                  <option v-for="b in job.boards" :key="b.id" :value="b.id">{{ boardTag(b.id) }} {{ b.name }}</option>
                </select>
              </td>
              <td>
                <button class="sm" title="复制一行" @click="duplicatePart(p)">复</button>
                <button class="sm ghost-danger" title="删除" @click="removePart(p.id)">×</button>
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
</style>
