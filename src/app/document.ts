/** 客户端文档: 实体记录存储 + 空间索引 + 编辑状态 */
import Flatbush from 'flatbush';
import { shiftRecord, type BlocksMap } from '../core/expand';
import type { BlockDef, DrawMeta, EntRecord, LayerInfo, LType } from '../core/types';

export interface Rect {
  x1: number; y1: number; x2: number; y2: number;
}

export interface SpaceData {
  arr: EntRecord[];          // flatbush 索引序
  fb: Flatbush | null;
  invalid: Set<number>;      // 已失效的原静态 id
  dynamic: EntRecord[];      // 编辑后的当前版本 (非文字)
  texts: EntRecord[];        // 全部文字记录 (线性扫描)
  ext: { x1: number; y1: number; x2: number; y2: number };
  /** 鲁棒范围 (初始/缩放范围用) */
  zoomExt: { x1: number; y1: number; x2: number; y2: number };
  layerCounts: Map<number, number>;
}

export interface DocEvents {
  onLayersChanged(): void;
  onEditChanged(layers: Iterable<number>): void;
}

export class Doc {
  records = new Map<number, EntRecord>();
  layers: LayerInfo[] = [];
  ltypes: LType[] = [];
  blocks: BlocksMap = new Map();
  spaces: { name: string }[] = [{ name: '模型空间' }];
  spaceData: SpaceData[] = [];
  activeSpace = 0;
  version = '';
  loaded = false;

  /** 运行时图层可见性 */
  layerVisible: boolean[] = [];
  private listeners: DocEvents;

  constructor(listeners: DocEvents) {
    this.listeners = listeners;
  }

  clear(): void {
    this.records.clear();
    this.layers = [];
    this.ltypes = [];
    this.blocks = new Map();
    this.spaces = [{ name: '模型空间' }];
    this.spaceData = [];
    this.activeSpace = 0;
    this.loaded = false;
  }

  initMeta(meta: DrawMeta): void {
    this.version = meta.version;
    this.layers = meta.layers;
    this.layerVisible = meta.layers.map((l) => !(l.off || l.frozen));
    this.ltypes = meta.ltypes;
    this.spaces = meta.spaces.map((s) => ({ name: s.name }));
    this.spaceData = meta.spaces.map(() => ({
      arr: [], fb: null, invalid: new Set(), dynamic: [], texts: [],
      ext: { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
      zoomExt: { x1: 0, y1: 0, x2: 100, y2: 100 },
      layerCounts: new Map(),
    }));
  }

  addBlockDefs(blocks: BlockDef[]): void {
    for (const b of blocks) {
      this.blocks.set(b.name, { bx: b.bx, by: b.by, records: b.records });
    }
  }

  addBatch(space: number, records: EntRecord[]): void {
    const sd = this.spaceData[space];
    if (!sd) return;
    for (const rec of records) {
      this.records.set(rec.id, rec);
      if (rec.type === 'TEXT' || rec.type === 'MTEXT') {
        sd.texts.push(rec);
      } else {
        sd.arr.push(rec);
      }
      sd.layerCounts.set(rec.layer, (sd.layerCounts.get(rec.layer) ?? 0) + 1);
      this.layers[rec.layer] && this.layers[rec.layer].count++;
    }
  }

  finishLoad(exts: [number, number, number, number][], robustExts?: [number, number, number, number][]): void {
    for (let i = 0; i < this.spaceData.length; i++) {
      const sd = this.spaceData[i];
      const e = exts[i];
      if (e) sd.ext = { x1: e[0], y1: e[1], x2: e[2], y2: e[3] };
      const r = robustExts?.[i];
      sd.zoomExt = r ? { x1: r[0], y1: r[1], x2: r[2], y2: r[3] } : { ...sd.ext };
      const fb = new Flatbush(Math.max(1, sd.arr.length));
      for (const rec of sd.arr) {
        fb.add(rec.bb.x1, rec.bb.y1, rec.bb.x2, rec.bb.y2);
      }
      fb.finish();
      sd.fb = fb;
    }
    this.loaded = true;
  }

  isText(t: EntRecord): boolean {
    return t.type === 'TEXT' || t.type === 'MTEXT';
  }

  /** 矩形查询 (相交), 返回当前版本记录 */
  queryRect(space: number, r: Rect, includeText = true, includeDynamic = true): EntRecord[] {
    const sd = this.spaceData[space];
    if (!sd) return [];
    const out: EntRecord[] = [];
    if (sd.fb) {
      const hits = sd.fb.search(r.x1, r.y1, r.x2, r.y2);
      for (const idx of hits) {
        const rec = sd.arr[idx];
        if (this.invalid_(rec.id)) continue;
        if (!this.layerVisible[rec.layer]) continue;
        if (!rectsIntersect(rec.bb, r)) continue;
        out.push(rec);
      }
    }
    if (includeDynamic) {
      for (const rec of sd.dynamic) {
        if (this.records.get(rec.id) !== rec) continue; // 已被更新版本替代
        if (!this.layerVisible[rec.layer]) continue;
        if (rectsIntersect(rec.bb, r)) out.push(rec);
      }
    }
    if (includeText) {
      for (const rec of sd.texts) {
        if (this.records.get(rec.id) !== rec) continue;
        if (!this.layerVisible[rec.layer]) continue;
        if (rectsIntersect(rec.bb, r)) out.push(rec);
      }
    }
    return out;
  }

  private invalid_(id: number): boolean {
    // 检查所有空间 (id 唯一)
    for (const sd of this.spaceData) {
      if (sd.invalid.has(id)) return true;
    }
    return false;
  }

  /** 单点拾取 (最近实体) */
  pick(space: number, x: number, y: number, tolWorld: number): EntRecord | null {
    const r: Rect = { x1: x - tolWorld, y1: y - tolWorld, x2: x + tolWorld, y2: y + tolWorld };
    const cands = this.queryRect(space, r);
    let best: EntRecord | null = null;
    let bestD = Infinity;
    for (const rec of cands) {
      const d = distToRecord(rec, x, y);
      if (d != null && d <= tolWorld && d < bestD) {
        bestD = d;
        best = rec;
      }
    }
    return best;
  }

  // ---------- 编辑 ----------
  /** 新增记录 (用户绘制) */
  addRecord(rec: EntRecord): void {
    this.records.set(rec.id, rec);
    const sd = this.spaceData[rec.sp ?? 0];
    if (!sd) return;
    if (this.isText(rec)) sd.texts.push(rec);
    else sd.dynamic.push(rec);
    sd.layerCounts.set(rec.layer, (sd.layerCounts.get(rec.layer) ?? 0) + 1);
    this.layers[rec.layer] && this.layers[rec.layer].count++;
  }

  /** 删除记录 */
  deleteRecords(ids: Iterable<number>): void {
    const layers = new Set<number>();
    for (const id of ids) {
      const rec = this.records.get(id);
      if (!rec) continue;
      layers.add(rec.layer);
      this.records.delete(id);
      const sd = this.spaceData[rec.sp ?? 0];
      if (!sd) continue;
      sd.invalid.add(id);
      sd.layerCounts.set(rec.layer, Math.max(0, (sd.layerCounts.get(rec.layer) ?? 1) - 1));
      this.layers[rec.layer] && this.layers[rec.layer].count--;
    }
    if (layers.size > 0) this.listeners.onEditChanged(layers);
  }

  /** 移动记录 (原地) */
  moveRecords(ids: Iterable<number>, dx: number, dy: number): void {
    const layers = new Set<number>();
    for (const id of ids) {
      const rec = this.records.get(id);
      if (!rec) continue;
      layers.add(rec.layer);
      shiftRecord(rec, dx, dy);
      const sd = this.spaceData[rec.sp ?? 0];
      if (!sd) continue;
      // 静态索引中的旧位置失效; 文字在 texts 里线性扫描无需失效
      if (!this.isText(rec)) {
        sd.invalid.add(id);
        if (!sd.dynamic.includes(rec)) sd.dynamic.push(rec);
      }
    }
    if (layers.size > 0) this.listeners.onEditChanged(layers);
  }

  /** 获取某层当前需要动态重绘的记录 */
  dynamicRecords(space: number, layer: number): EntRecord[] {
    const sd = this.spaceData[space];
    if (!sd) return [];
    return sd.dynamic.filter((rec) => rec.layer === layer && this.records.get(rec.id) === rec);
  }

  /** 撤销/重做后同步 (删除恢复/新增撤销) */
  restoreRecords(recs: EntRecord[]): void {
    const layers = new Set<number>();
    for (const rec of recs) {
      this.records.set(rec.id, rec);
      layers.add(rec.layer);
      const sd = this.spaceData[rec.sp ?? 0];
      if (!sd) continue;
      sd.invalid.delete(rec.id);
      if (!this.isText(rec) && !sd.dynamic.includes(rec)) sd.dynamic.push(rec);
      sd.layerCounts.set(rec.layer, (sd.layerCounts.get(rec.layer) ?? 0) + 1);
      this.layers[rec.layer] && this.layers[rec.layer].count++;
    }
    if (layers.size > 0) this.listeners.onEditChanged(layers);
  }

  /** 撤销新增: 从文档移除 (记录保留在命令里) */
  removeRecords(ids: Iterable<number>): void {
    this.deleteRecords(ids);
  }
}

export function rectsIntersect(a: { x1: number; y1: number; x2: number; y2: number }, b: Rect): boolean {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
}

/** 点到记录的距离 (近似拾取) */
export function distToRecord(rec: EntRecord, x: number, y: number): number | null {
  const d = rec.d as never;
  switch (rec.type) {
    case 'LINE': {
      const [x1, y1, x2, y2] = d as number[];
      return Math.sqrt(distPtSeg2(x, y, x1, y1, x2, y2));
    }
    case 'CIRCLE': {
      const [cx, cy, r] = d as [number, number, number];
      return Math.abs(Math.hypot(x - cx, y - cy) - r);
    }
    case 'ARC': {
      const [cx, cy, r, a0, a1] = d as [number, number, number, number, number];
      const a = Math.atan2(y - cy, x - cx);
      let sweep = a1 - a0;
      while (sweep <= 1e-9) sweep += Math.PI * 2;
      let aa = a - a0;
      while (aa < 0) aa += Math.PI * 2;
      if (aa > sweep) {
        // 不在弧段上 → 取端点距离
        const e0 = Math.min(Math.hypot(x - (cx + r * Math.cos(a0)), y - (cy + r * Math.sin(a0))),
          Math.hypot(x - (cx + r * Math.cos(a1)), y - (cy + r * Math.sin(a1))));
        return e0;
      }
      return Math.abs(Math.hypot(x - cx, y - cy) - r);
    }
    case 'ELLIPSE': {
      // 包围盒距离近似
      return bboxDist(rec.bb, x, y);
    }
    case 'PLINE': {
      const pl = d as { v: Float32Array; closed: boolean };
      let best = Infinity;
      const n = pl.v.length / 2;
      const segs = pl.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        best = Math.min(best, distPtSeg2(x, y, pl.v[i * 2], pl.v[i * 2 + 1], pl.v[j * 2], pl.v[j * 2 + 1]));
      }
      return best === Infinity ? bboxDist(rec.bb, x, y) : Math.sqrt(best);
    }
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'HATCH': case 'SOLID': {
      return bboxDist(rec.bb, x, y);
    }
    case 'POINT': {
      const [px, py] = d as [number, number];
      return Math.hypot(x - px, y - py);
    }
    default:
      return bboxDist(rec.bb, x, y);
  }
}

function bboxDist(bb: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): number {
  const dx = Math.max(bb.x1 - x, 0, x - bb.x2);
  const dy = Math.max(bb.y1 - y, 0, y - bb.y2);
  return Math.hypot(dx, dy);
}

function distPtSeg2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + t * dx - px, qy = y1 + t * dy - py;
  return qx * qx + qy * qy;
}
