/**
 * DWG 解析 Worker: LibreDwg(WASM) → 内部实体记录 + 烘焙几何批, 渐进回传
 * 健壮性: 单实体解析失败仅跳过计数, 不中断整体流程; XREF 等外部依赖缺失时记录并在完成后提示
 */
import { LibreDwg } from '@mlightcad/libredwg-web';
import type { DwgDatabase, DwgEntity } from '@mlightcad/libredwg-web';
import { aciToRgb } from '../core/aci';
import {
  arcPoints, ellipsePoints, polylinePoints, splinePoints,
} from '../core/tess';
import {
  pushSegs, pushTris, triangulateLoops, expandInsertInto,
  shiftRecord, stripMText,
  type BlocksMap, type ExpandSink,
} from '../core/expand';
import type { BlockDef, EntRecord, LType, WorkerIn, WorkerOut } from '../core/types';

const BYLAYER = 256;
const BYBLOCK = 0;

let idSeq = 1;
const nextId = () => idSeq++;

/** DwgPoint 访问 (LibreDWG 返回 {x,y,z} 对象) */
const px = (p: unknown): number => (p as { x?: number })?.x ?? 0;
const py = (p: unknown): number => (p as { y?: number })?.y ?? 0;

function post(msg: WorkerOut, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}
function progress(phase: string, pct: number): void {
  post({ t: 'progress', phase, pct });
}

/** 批累积器 (结构即 ExpandSink) */
class Batch implements ExpandSink {
  segs: number[] = [];
  segIds: number[] = [];
  segAci: number[] = [];
  tris: number[] = [];
  triIds: number[] = [];
  triAci: number[] = [];
  records: EntRecord[] = [];

  flush(space: number): void {
    if (this.records.length === 0 && this.segs.length === 0 && this.tris.length === 0) return;
    const segs = new Float32Array(this.segs);
    const segIds = new Uint32Array(this.segIds);
    const segAci = new Uint8Array(this.segAci);
    const tris = new Float32Array(this.tris);
    const triIds = new Uint32Array(this.triIds);
    const triAci = new Uint8Array(this.triAci);
    this.segs = []; this.segIds = []; this.segAci = [];
    this.tris = []; this.triIds = []; this.triAci = [];
    const records = this.records;
    this.records = [];
    post({ t: 'batch', space, segs, segIds, segAci, tris, triIds, triAci, records },
      [segs.buffer, segIds.buffer, segAci.buffer, tris.buffer, triIds.buffer, triAci.buffer]);
  }
}

// ---------- 上下文 ----------
interface Ext { x1: number; y1: number; x2: number; y2: number }

interface Ctx {
  layerIdx: Map<string, number>;
  layerRgb: number[];
  layerAci: number[];
  layerAlpha: number[];
  layerOffFlags: boolean[];
  dev: number;
  ext: Ext;
  haveExt: boolean;
  centers: number[];
  skipped: number;
  skippedTypes: Map<string, number>;
  missingRefs: Map<string, number>;   // 缺失引用 (XREF/未找到的块) → 引用次数
  errorSamples: Map<string, number>;  // 异常样例消息 → 次数
  entityCount: number;
  batch: Batch;
  blocks: BlocksMap;
  spaceExts: Map<number, Ext>;
  robustExts: Map<number, Ext>;
  centersVis: number[];   // 仅初始可见图层的实体中心 (用于鲁棒范围)
  space: number;
}

function growExt(ctx: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  if (!ctx.haveExt) { ctx.ext = { x1, y1, x2, y2 }; ctx.haveExt = true; return; }
  if (x1 < ctx.ext.x1) ctx.ext.x1 = x1;
  if (y1 < ctx.ext.y1) ctx.ext.y1 = y1;
  if (x2 > ctx.ext.x2) ctx.ext.x2 = x2;
  if (y2 > ctx.ext.y2) ctx.ext.y2 = y2;
  // 记录中心点用于鲁棒范围统计
  ctx.centers.push((x1 + x2) / 2, (y1 + y2) / 2);
}

/**
 * 鲁棒范围: 网格密度法 — 覆盖 ratio 比例实体所在的最紧凑区域,
 * 避免少量离群实体 (远处残留几何) 撑爆初始视图
 */
function robustExtents(centers: number[], ratio: number): Ext | null {
  const n = centers.length / 2;
  if (n === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < centers.length; i += 2) {
    const x = centers[i], y = centers[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (w <= 1e-9 && h <= 1e-9) return { x1: minX, y1: minY, x2: maxX, y2: maxY };
  const W = 128, H = 128;
  const grid = new Uint32Array(W * H);
  for (let i = 0; i < centers.length; i += 2) {
    const gx = Math.min(W - 1, Math.max(0, Math.floor(((centers[i] - minX) / (w || 1)) * W)));
    const gy = Math.min(H - 1, Math.max(0, Math.floor(((centers[i + 1] - minY) / (h || 1)) * H)));
    grid[gy * W + gx]++;
  }
  const cells = Array.from(grid.keys()).sort((a, b) => grid[b] - grid[a]);
  const target = Math.max(1, Math.floor(n * ratio));
  let acc = 0;
  let rx1 = Infinity, ry1 = Infinity, rx2 = -Infinity, ry2 = -Infinity;
  for (const cell of cells) {
    if (acc >= target) break;
    const cnt = grid[cell];
    if (cnt === 0) continue;
    acc += cnt;
    const gx = cell % W, gy = Math.floor(cell / W);
    const cx1 = minX + (gx / W) * w, cx2 = minX + ((gx + 1) / W) * w;
    const cy1 = minY + (gy / H) * h, cy2 = minY + ((gy + 1) / H) * h;
    if (cx1 < rx1) rx1 = cx1;
    if (cy1 < ry1) ry1 = cy1;
    if (cx2 > rx2) rx2 = cx2;
    if (cy2 > ry2) ry2 = cy2;
  }
  return { x1: rx1, y1: ry1, x2: rx2, y2: ry2 };
}

function normBBox(bb: { x1: number; y1: number; x2: number; y2: number }): void {
  if (bb.x1 > bb.x2) { const t = bb.x1; bb.x1 = bb.x2; bb.x2 = t; }
  if (bb.y1 > bb.y2) { const t = bb.y1; bb.y1 = bb.y2; bb.y2 = t; }
}

function resolveColor(ent: DwgEntity, ctx: Ctx): { rgb: number; byblock: boolean } {
  const ci = ent.colorIndex;
  if (ci === BYBLOCK) return { rgb: 0, byblock: true };
  if (ci != null && ci >= 1 && ci < BYLAYER) return { rgb: aciToRgb(ci, true), byblock: false };
  if ((ci == null || ci >= BYLAYER) && ent.color && ent.color > 0) {
    return { rgb: ent.color & 0xffffff, byblock: false };
  }
  const li = ctx.layerIdx.get(ent.layer ?? '0') ?? 0;
  return { rgb: ctx.layerRgb[li] ?? aciToRgb(7, true), byblock: false };
}

function layerIndexOf(ent: DwgEntity, ctx: Ctx): number {
  return ctx.layerIdx.get(ent.layer ?? '0') ?? 0;
}

/** 有效 ACI: BYBLOCK=0, 显式=1-255, 真彩色=256, BYLAYER=图层 ACI */
function effectiveAci(ent: DwgEntity, ctx: Ctx): number {
  const ci = ent.colorIndex;
  if (ci === BYBLOCK) return 0;
  if (ci != null && ci >= 1 && ci < BYLAYER) return ci;
  if ((ci == null || ci >= BYLAYER) && ent.color && ent.color > 0) return 256;
  return ctx.layerAci[layerIndexOf(ent, ctx)] ?? 7;
}

/** 透明度 alpha (0-255): 实体显式 alpha → BYLAYER 用图层 alpha */
function alphaOf(ent: DwgEntity, ctx: Ctx): number {
  const tt = ent.transparencyType;
  const t = ent.transparency;
  if (tt === 3 && typeof t === 'number') {
    const a = 255 - (t & 0xFF);
    return a < 255 ? Math.max(0, a) : 255;
  }
  const li = layerIndexOf(ent, ctx);
  const la = ctx.layerAlpha[li];
  return la != null && la < 255 ? la : 255;
}

function skipType(ctx: Ctx, type: string): void {
  ctx.skipped++;
  ctx.skippedTypes.set(type, (ctx.skippedTypes.get(type) ?? 0) + 1);
}

// ---------- 实体转换 ----------
type Rec = { rec: EntRecord; segs: number[] | null; tris: number[] | null; close: boolean };

function convertEntity(ent: DwgEntity, ctx: Ctx, isBlockDef: boolean): Rec | null {
  const t = ent.type;
  const id = nextId();
  const li = layerIndexOf(ent, ctx);
  const col = resolveColor(ent, ctx);
  const rgb = isBlockDef && col.byblock ? -1 : col.rgb;
  const dev = ctx.dev;
  const bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  let segs: number[] | null = null;
  let tris: number[] | null = null;
  let close = false;
  let rec: EntRecord | null = null;
  const e = ent as unknown as Record<string, unknown>;

  switch (t) {
    case 'LINE': {
      const x1 = px(e.startPoint), y1 = py(e.startPoint);
      const x2 = px(e.endPoint), y2 = py(e.endPoint);
      if (![x1, y1, x2, y2].every(isFinite)) return null;
      segs = [x1, y1, x2, y2];
      bb.x1 = Math.min(x1, x2); bb.y1 = Math.min(y1, y2);
      bb.x2 = Math.max(x1, x2); bb.y2 = Math.max(y1, y2);
      rec = { id, type: 'LINE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: [x1, y1, x2, y2] };
      break;
    }
    case 'CIRCLE': {
      const cx = px(e.center), cy = py(e.center);
      const r = e.radius as number;
      if (!(r > 0) || !isFinite(r)) return null;
      segs = [];
      arcPoints(cx, cy, r, 0, Math.PI * 2, dev, segs);
      bb.x1 = cx - r; bb.y1 = cy - r; bb.x2 = cx + r; bb.y2 = cy + r;
      rec = { id, type: 'CIRCLE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: [cx, cy, r] };
      break;
    }
    case 'ARC': {
      const cx = px(e.center), cy = py(e.center);
      const r = e.radius as number;
      if (!(r > 0) || !isFinite(r)) return null;
      segs = [];
      arcPoints(cx, cy, r, (e.startAngle as number) ?? 0, (e.endAngle as number) ?? Math.PI * 2, dev, segs);
      for (let i = 0; i < segs.length; i += 2) growBB(bb, segs[i], segs[i + 1]);
      rec = { id, type: 'ARC', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: [cx, cy, r, e.startAngle ?? 0, e.endAngle ?? Math.PI * 2] };
      break;
    }
    case 'ELLIPSE': {
      const cx = px(e.center), cy = py(e.center);
      const mx = px(e.majorAxisEndPoint), my = py(e.majorAxisEndPoint);
      const ratio = (e.axisRatio as number) || 0.5;
      segs = [];
      ellipsePoints(cx, cy, mx, my, ratio, (e.startAngle as number) || 0, (e.endAngle as number) || Math.PI * 2, dev, segs);
      for (let i = 0; i < segs.length; i += 2) growBB(bb, segs[i], segs[i + 1]);
      rec = { id, type: 'ELLIPSE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: [cx, cy, mx, my, ratio, e.startAngle ?? 0, e.endAngle ?? Math.PI * 2] };
      break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE2D':
    case 'POLYLINE3D': {
      const verts = (e.vertices ?? []) as Array<{ x: number; y: number; bulge?: number }>;
      const flag = ((e.flag as number) ?? 0);
      const closed = t === 'LWPOLYLINE' ? (flag & 1) === 1 : (flag & 1) === 1 || (flag & 32) === 32;
      const n = verts?.length ?? 0;
      if (n === 0) return null;
      const v = new Float32Array(n * 2);
      let hasBulge = false;
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        v[i * 2] = verts[i].x; v[i * 2 + 1] = verts[i].y;
        const bu = verts[i].bulge ?? 0;
        b[i] = bu;
        if (bu) hasBulge = true;
      }
      segs = [];
      polylinePoints(v, hasBulge ? b : null, closed, dev, segs);
      for (let i = 0; i < n; i++) growBB(bb, v[i * 2], v[i * 2 + 1]);
      rec = { id, type: 'PLINE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { v, b: hasBulge ? b : undefined, closed, flag } };
      close = closed;
      break;
    }
    case 'SPLINE': {
      const ctrl = (e.controlPoints ?? []) as Array<{ x: number; y: number }>;
      if (ctrl.length === 0) return null;
      const flat: number[] = [];
      for (const p of ctrl) flat.push(px(p), py(p));
      const knots = (e.knots ?? []) as number[];
      const weights = (e.weights ?? null) as number[] | null;
      const degree = (e.degree as number) ?? 3;
      segs = [];
      splinePoints(flat, knots, weights, degree, segs);
      for (let i = 0; i < segs.length; i += 2) growBB(bb, segs[i], segs[i + 1]);
      const v = new Float32Array(segs);
      rec = { id, type: 'PLINE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { v, closed: false, spline: true } };
      segs = null;
      break;
    }
    case 'TEXT': {
      const te = e as { text: string; startPoint: { x: number; y: number }; endPoint?: { x: number; y: number }; textHeight: number; rotation?: number; xScale?: number; halign?: number; valign?: number };
      if (!te.text || !(te.textHeight > 0)) return null;
      const useSecond = (te.halign ?? 0) > 0 && te.endPoint != null;
      const ax = useSecond ? px(te.endPoint) : px(te.startPoint);
      const ay = useSecond ? py(te.endPoint) : py(te.startPoint);
      const txt = decodeText(te.text);
      const h = te.textHeight;
      bb.x1 = ax; bb.y1 = ay; bb.x2 = ax + h * txt.length * 0.8; bb.y2 = ay + h;
      normBBox(bb);
      rec = { id, type: 'TEXT', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { x: ax, y: ay, h, rot: (te.rotation ?? 0) * 180 / Math.PI, text: txt, ha: te.halign ?? 0, va: te.valign ?? 0, wf: te.xScale ?? 1 } };
      break;
    }
    case 'MTEXT': {
      const mt = e as { text: string; insertionPoint: { x: number; y: number }; textHeight: number; rotation?: number; attachmentPoint?: number; rectWidth?: number };
      if (!mt.text || !(mt.textHeight > 0)) return null;
      const txt = stripMText(mt.text);
      if (!txt) return null;
      const x = px(mt.insertionPoint), y = py(mt.insertionPoint);
      const lines = txt.split('\n');
      const wEst = Math.max(...lines.map((l) => l.length)) * mt.textHeight * 0.8;
      const hEst = lines.length * mt.textHeight * 1.66;
      bb.x1 = x; bb.y1 = y - hEst; bb.x2 = x + wEst; bb.y2 = y;
      normBBox(bb);
      rec = { id, type: 'MTEXT', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { x, y, h: mt.textHeight, rot: (mt.rotation ?? 0) * 180 / Math.PI, text: txt, attach: mt.attachmentPoint ?? 1, w: mt.rectWidth ?? 0 } };
      break;
    }
    case 'HATCH': {
      const paths = (e.boundaryPaths ?? []) as BoundaryPath[];
      const loops: Float32Array[] = [];
      for (const p of paths) {
        const loop = flattenHatchPath(p, dev);
        if (loop && loop.length >= 6) loops.push(new Float32Array(loop));
      }
      if (loops.length === 0) return null;
      const solid = (e.solidFill as number) === 1;
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i += 2) growBB(bb, loop[i], loop[i + 1]);
      }
      rec = { id, type: 'HATCH', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { loops, solid, pattern: (e.patternName as string) ?? '' } };
      tris = triangulateLoops(loops);
      segs = [];
      for (const loop of loops) {
        for (let i = 0; i < loop.length / 2 - 1; i++) {
          segs.push(loop[i * 2], loop[i * 2 + 1], loop[i * 2 + 2], loop[i * 2 + 3]);
        }
        segs.push(loop[loop.length - 2], loop[loop.length - 1], loop[0], loop[1]);
      }
      break;
    }
    case 'SOLID':
    case 'TRACE': {
      const c1 = e.corner1, c2 = e.corner2, c3 = e.corner3, c4 = (e.corner4 ?? e.corner3);
      const trisLocal = [
        px(c1), py(c1), px(c2), py(c2), px(c4), py(c4),
        px(c1), py(c1), px(c4), py(c4), px(c3), py(c3),
      ];
      tris = trisLocal;
      const xs = [px(c1), px(c2), px(c3), px(c4)], ys = [py(c1), py(c2), py(c3), py(c4)];
      bb.x1 = Math.min(...xs); bb.y1 = Math.min(...ys);
      bb.x2 = Math.max(...xs); bb.y2 = Math.max(...ys);
      rec = { id, type: 'SOLID', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { v: new Float32Array(trisLocal) } };
      break;
    }
    case 'POINT': {
      const x = px(e.position), y = py(e.position);
      const s = ctx.dev * 3;
      bb.x1 = x - s; bb.y1 = y - s; bb.x2 = x + s; bb.y2 = y + s;
      rec = { id, type: 'POINT', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: [x, y] };
      break;
    }
    case 'LEADER': {
      const verts = (e.vertices ?? []) as Array<{ x: number; y: number }>;
      if (verts.length < 2) return null;
      const v = new Float32Array(verts.length * 2);
      for (let i = 0; i < verts.length; i++) { v[i * 2] = px(verts[i]); v[i * 2 + 1] = py(verts[i]); growBB(bb, v[i * 2], v[i * 2 + 1]); }
      rec = { id, type: 'PLINE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { v, closed: false } };
      break;
    }
    case '3DFACE': {
      const c1 = e.corner1, c2 = e.corner2, c3 = e.corner3, c4 = (e.corner4 ?? e.corner3);
      const v = new Float32Array([px(c1), py(c1), px(c2), py(c2), px(c4), py(c4), px(c3), py(c3), px(c1), py(c1)]);
      for (let i = 0; i < v.length; i += 2) growBB(bb, v[i], v[i + 1]);
      rec = { id, type: 'PLINE', layer: li, color: rgb, lt: -1, sp: ctx.space, bb, d: { v, closed: false } };
      break;
    }
    default:
      skipType(ctx, t);
      return null;
  }
  if (!rec || !isFinite(bb.x1)) return null;
  rec.aci = effectiveAci(ent, ctx);
  rec.alpha = alphaOf(ent, ctx);
  return { rec, segs, tris, close };
}

function growBB(bb: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): void {
  if (x < bb.x1) bb.x1 = x;
  if (y < bb.y1) bb.y1 = y;
  if (x > bb.x2) bb.x2 = x;
  if (y > bb.y2) bb.y2 = y;
}

interface BoundaryPath {
  edges?: Array<{
    type?: number;
    startPoint?: { x: number; y: number };
    endPoint?: { x: number; y: number };
    center?: { x: number; y: number };
    radius?: number;
    startAngle?: number;
    endAngle?: number;
    majorAxisEndPoint?: { x: number; y: number };
    axisRatio?: number;
    controlPoints?: Array<{ x: number; y: number }>;
    knots?: number[];
    degree?: number;
  }>;
  polylineVertices?: Array<{ x: number; y: number; bulge?: number }>;
}

function flattenHatchPath(p: BoundaryPath, dev: number): number[] | null {
  const out: number[] = [];
  if (p.polylineVertices && p.polylineVertices.length >= 2) {
    const n = p.polylineVertices.length;
    const v = new Float32Array(n * 2);
    const b = new Float32Array(n);
    let hasBulge = false;
    for (let i = 0; i < n; i++) {
      v[i * 2] = p.polylineVertices[i].x;
      v[i * 2 + 1] = p.polylineVertices[i].y;
      b[i] = p.polylineVertices[i].bulge ?? 0;
      if (b[i]) hasBulge = true;
    }
    polylinePoints(v, hasBulge ? b : null, true, dev, out);
    return out;
  }
  for (const edge of p.edges ?? []) {
    const t = edge.type;
    if (t === 1 && edge.startPoint && edge.endPoint) {
      out.push(edge.startPoint.x, edge.startPoint.y, edge.endPoint.x, edge.endPoint.y);
    } else if (t === 2 && edge.center && edge.radius) {
      arcPoints(edge.center.x, edge.center.y, edge.radius, edge.startAngle ?? 0, edge.endAngle ?? 0, dev, out);
    } else if (t === 3 && edge.center && edge.majorAxisEndPoint) {
      ellipsePoints(edge.center.x, edge.center.y, edge.majorAxisEndPoint.x, edge.majorAxisEndPoint.y, edge.axisRatio ?? 0.5, edge.startAngle ?? 0, edge.endAngle ?? 0, dev, out);
    } else if (t === 4 && edge.controlPoints) {
      const flat: number[] = [];
      for (const c of edge.controlPoints) flat.push(px(c), py(c));
      splinePoints(flat, edge.knots ?? [], null, edge.degree ?? 3, out);
    }
  }
  return out.length >= 6 ? out : null;
}

// ---------- 文字解码 ----------
function decodeText(s: string): string {
  return s
    .replace(/%%c/gi, 'Ø').replace(/%%d/gi, '°').replace(/%%p/gi, '±')
    .replace(/%%u/gi, '').replace(/%%o/gi, '').replace(/%%%/g, '%');
}

// ---------- 实体发射 ----------
function emitRecord(rec: Rec, ctx: Ctx): void {
  ctx.batch.records.push(rec.rec);
  const aci = rec.rec.aci ?? 7;
  if (rec.segs && rec.segs.length >= 4) pushSegs(ctx.batch, rec.segs, rec.rec.id, rec.rec.color, rec.close, aci);
  if (rec.tris && rec.tris.length >= 6) pushTris(ctx.batch, rec.tris, rec.rec.id, rec.rec.color, aci);
  growExt(ctx, rec.rec.bb.x1, rec.rec.bb.y1, rec.rec.bb.x2, rec.rec.bb.y2);
  pushVisCenter(ctx, rec.rec);
}

/** 可见图层的实体中心 (鲁棒范围统计用) */
function pushVisCenter(ctx: Ctx, rec: { layer: number; bb: { x1: number; y1: number; x2: number; y2: number } }): void {
  if (!ctx.layerOffFlags[rec.layer]) {
    ctx.centersVis.push((rec.bb.x1 + rec.bb.x2) / 2, (rec.bb.y1 + rec.bb.y2) / 2);
  }
}

interface InsertEnt {
  name: string;
  insertionPoint: { x: number; y: number };
  xScale?: number; yScale?: number; rotation?: number;
  colorIndex?: number; color?: number; layer?: string;
  attribs?: Array<{ text?: { text?: string; startPoint?: { x: number; y: number }; textHeight?: number; rotation?: number; halign?: number; valign?: number }; tag?: string; layer?: string; colorIndex?: number; isVisible?: boolean }>;
}

function convertInsert(ent: InsertEnt, ctx: Ctx): void {
  const def = ctx.blocks.get(ent.name);
  if (!def) {
    // 块缺失 (XREF 未加载 / 损坏) → 记录引用, 跳过
    ctx.missingRefs.set(ent.name, (ctx.missingRefs.get(ent.name) ?? 0) + 1);
    return;
  }
  const id = nextId();
  const li = layerIndexOf(ent as unknown as DwgEntity, ctx);
  const col = resolveColor(ent as unknown as DwgEntity, ctx);
  const insAci = effectiveAci(ent as unknown as DwgEntity, ctx);
  const insAlpha = alphaOf(ent as unknown as DwgEntity, ctx);
  const x = px(ent.insertionPoint), y = py(ent.insertionPoint);
  const sx = ent.xScale ?? 1, sy = ent.yScale ?? 1;
  const rotRad = ent.rotation ?? 0;                    // LibreDWG 返回弧度
  const rotDeg = (rotRad * 180) / Math.PI;             // 记录中统一存度
  const rec: EntRecord = {
    id, type: 'INSERT', layer: li, color: col.rgb, lt: -1, sp: ctx.space,
    aci: insAci, alpha: insAlpha,
    bb: { x1: x, y1: y, x2: x, y2: y },
    d: { name: ent.name, x, y, sx, sy, rot: rotDeg },
  };
  const acc = expandInsertInto(ctx.batch, def, ctx.blocks, x, y, sx, sy, rotRad,
    col.rgb, ctx.dev, 0, new Set<string>([ent.name]), id, undefined, insAci, insAlpha);
  if (acc) rec.bb = { ...acc.bb };
  for (const at of ent.attribs ?? []) {
    const tb = at.text;
    const txt = (tb?.text ?? '').trim();
    if (!txt || at.isVisible === false) continue;
    const ax = tb?.startPoint?.x ?? x, ay = tb?.startPoint?.y ?? y;
    const ah = tb?.textHeight ?? 2.5;
    const aLi = ctx.layerIdx.get(at.layer ?? '') ?? li;
    const aAci = at.colorIndex != null && at.colorIndex > 0 && at.colorIndex < 256 ? at.colorIndex : (ctx.layerAci[aLi] ?? 7);
    const aRgb = at.colorIndex != null && at.colorIndex > 0 && at.colorIndex < 256 ? aciToRgb(at.colorIndex, true) : col.rgb;
    ctx.batch.records.push({
      id: nextId(), type: 'TEXT', layer: aLi, color: aRgb, lt: -1, sp: ctx.space,
      aci: aAci, alpha: insAlpha,
      bb: { x1: ax, y1: ay, x2: ax + ah * txt.length * 0.8, y2: ay + ah },
      d: { x: ax, y: ay, h: ah, rot: ((tb?.rotation ?? 0) * 180) / Math.PI, text: decodeText(txt), ha: tb?.halign ?? 0, va: tb?.valign ?? 0, wf: 1 },
      group: id,
    });
  }
  ctx.batch.records.push(rec);
  growExt(ctx, rec.bb.x1, rec.bb.y1, rec.bb.x2, rec.bb.y2);
  pushVisCenter(ctx, rec);
}

function convertDimension(ent: DwgEntity, ctx: Ctx): void {
  const gid = nextId();
  const name = (ent as unknown as { name?: string }).name;
  const def = name ? ctx.blocks.get(name) : undefined;
  if (!def) {
    if (name) ctx.missingRefs.set(name, (ctx.missingRefs.get(name) ?? 0) + 1);
    ctx.skipped++;
    return;
  }
  const li = layerIndexOf(ent, ctx);
  const col = resolveColor(ent, ctx);
  const batch = ctx.batch;
  const before = batch.records.length;
  const acc = expandInsertInto(batch, def, ctx.blocks, 0, 0, 1, 1, 0, col.rgb, ctx.dev, 0, new Set<string>(), gid,
    undefined, effectiveAci(ent, ctx), alphaOf(ent, ctx));
  if (acc) {
    growExt(ctx, acc.bb.x1, acc.bb.y1, acc.bb.x2, acc.bb.y2);
    pushVisCenter(ctx, { layer: li, bb: acc.bb });
  }
  for (let i = before; i < batch.records.length; i++) {
    if (batch.records[i].group === gid) batch.records[i].layer = li;
  }
}

// ---------- 空间转换 ----------
function convertSpace(ents: DwgEntity[], space: number, ctx: Ctx, phase: string, pctFrom: number, pctTo: number): void {
  ctx.batch = new Batch();
  ctx.space = space;
  ctx.haveExt = false;
  ctx.ext = { x1: 0, y1: 0, x2: 0, y2: 0 };
  ctx.centers = [];
  ctx.centersVis = [];
  const total = ents.length;
  let lastPct = pctFrom;
  if (total > 0) progress(phase, pctFrom);
  for (let i = 0; i < total; i++) {
    const ent = ents[i];
    const t = ent.type;
    try {
      if (t === 'ATTDEF' || t === 'SEQEND' || t === 'VERTEX' || t === 'VIEWPORT') continue;
      if (ent.isVisible === false) continue;
      if (t === 'DIMENSION') {
        convertDimension(ent, ctx);
      } else if (t === 'INSERT') {
        convertInsert(ent as unknown as InsertEnt, ctx);
      } else {
        const rec = convertEntity(ent, ctx, false);
        if (rec) emitRecord(rec, ctx);
      }
      ctx.entityCount++;
    } catch (err) {
      // 单个实体异常不中断整体
      const msg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      ctx.errorSamples.set(msg, (ctx.errorSamples.get(msg) ?? 0) + 1);
      skipType(ctx, t || 'UNKNOWN');
    }
    if (i % 2000 === 0 && i > 0) {
      const pct = pctFrom + Math.round(((pctTo - pctFrom) * i) / total);
      if (pct !== lastPct) { lastPct = pct; progress(phase, pct); }
      ctx.batch.flush(space);
    }
  }
  ctx.batch.flush(space);
  const full: Ext = ctx.haveExt ? { ...ctx.ext } : { x1: 0, y1: 0, x2: 100, y2: 100 };
  ctx.spaceExts.set(space, full);
  // 鲁棒范围: 优先用可见图层实体 (与初始视图一致)
  const src = ctx.centersVis.length > 0 ? ctx.centersVis : ctx.centers;
  const robust = robustExtents(src, 0.97) ?? full;
  ctx.robustExts.set(space, robust);
}

// ---------- 主流程 ----------
async function parse(buf: ArrayBuffer, wasmBase: string): Promise<void> {
  progress('加载解析器 (WASM)…', 3);
  const libredwg = await LibreDwg.create(wasmBase);
  progress('解析 DWG 数据…', 8);
  const ptr = libredwg.dwg_read_data(buf, 0);
  if (ptr == null) throw new Error('DWG 解析失败: 无法读取文件数据');
  const db = libredwg.convert(ptr) as DwgDatabase;
  libredwg.dwg_free(ptr);
  progress('转换实体…', 20);

  const layerEntries = (db.tables?.LAYER?.entries ?? []) as Array<{
    name: string; colorIndex?: number; frozen?: boolean; off?: boolean; locked?: boolean;
  }>;
  const layers = layerEntries.map((l, i) => {
    let ci = l.colorIndex ?? 7;
    if (ci === 256 || ci === 0 || ci < 0) ci = 7;
    // 图层透明度
    let alpha = 255;
    const t = (l as unknown as { transparency?: number }).transparency;
    if (typeof t === 'number' && t > 0) {
      const a = 255 - (t & 0xFF);
      if (a < 255) alpha = Math.max(0, a);
    }
    return {
      name: l.name ?? `Layer${i}`,
      color: ci,
      rgb: aciToRgb(ci, true),
      off: !!l.off,
      frozen: !!l.frozen,
      locked: !!l.locked,
      lt: 0,
      count: 0,
      alpha,
    };
  });
  const layerIdx = new Map<string, number>();
  layers.forEach((l, i) => layerIdx.set(l.name, i));
  const layerRgb = layers.map((l) => l.rgb);
  const layerAci = layers.map((l) => l.color);
  const layerAlpha = layers.map((l) => l.alpha ?? 255);

  const ltypeEntries = (db.tables?.LTYPE?.entries ?? []) as unknown as Array<{
    name?: string; pattern?: Array<{ elementLength?: number }>;
  }>;
  const ltypes: LType[] = ltypeEntries.map((lt) => {
    const dashes: number[] = [];
    for (const el of lt.pattern ?? []) {
      if (typeof el?.elementLength === 'number') dashes.push(el.elementLength);
    }
    return { name: lt.name ?? '', dashes };
  });
  if (!ltypes.some((l) => l.name === 'CONTINUOUS')) ltypes.unshift({ name: 'CONTINUOUS', dashes: [] });

  const blockEntries = (db.tables?.BLOCK_RECORD?.entries ?? []) as unknown as Array<{
    name?: string; flags?: number; basePoint?: { x: number; y: number }; entities?: DwgEntity[];
  }>;
  const isLayoutBlock = (name: string) => name.startsWith('*Model_Space') || name.startsWith('*Paper_Space');

  const ctx: Ctx = {
    layerIdx, layerRgb, layerAci, layerAlpha, dev: 0.5,
    layerOffFlags: layers.map((l) => l.off || l.frozen),
    ext: { x1: 0, y1: 0, x2: 0, y2: 0 }, haveExt: false, centers: [], centersVis: [],
    skipped: 0, skippedTypes: new Map(), missingRefs: new Map(), errorSamples: new Map(),
    entityCount: 0, batch: new Batch(), blocks: new Map(),
    spaceExts: new Map(), robustExts: new Map(), space: 0,
  };

  const header = db.header as Record<string, unknown>;
  const exMin = header?.EXTMIN as { x: number; y: number } | undefined;
  const exMax = header?.EXTMAX as { x: number; y: number } | undefined;
  if (exMin && exMax && isFinite(exMin?.x) && isFinite(exMax?.x) && Math.abs(exMax.x - exMin.x) > 1e-9) {
    const diag = Math.hypot(exMax.x - exMin.x, exMax.y - exMin.y);
    ctx.dev = Math.max(1e-6, diag * 2e-4);
  }

  // 收集非布局块定义 (基点局部坐标); XREF 块单独记录
  progress('收集块定义…', 25);
  const xrefBlocks = new Set<string>();
  for (const b of blockEntries) {
    if (!b.name || isLayoutBlock(b.name)) continue;
    if ((b.flags ?? 0) & 4) { xrefBlocks.add(b.name); continue; } // 外部引用块: 无法加载
    const ents = b.entities ?? [];
    if (ents.length === 0) continue;
    const bx = b.basePoint?.x ?? 0, by = b.basePoint?.y ?? 0;
    const records: EntRecord[] = [];
    for (const ent of ents) {
      try {
        if (ent.type === 'ATTDEF' || ent.type === 'SEQEND' || ent.type === 'VERTEX') continue;
        const rec = convertEntity(ent, ctx, true);
        if (!rec) continue;
        shiftRecord(rec.rec, -bx, -by);
        records.push(rec.rec);
      } catch { /* 块内单实体失败忽略 */ }
    }
    if (records.length > 0) ctx.blocks.set(b.name, { bx, by, records });
  }
  ctx.skipped = 0; // 块收集阶段不计数
  ctx.skippedTypes.clear(); // 块内的嵌套 INSERT / 不支持类型由展开路径处理, 只报告模型空间真实跳过
  // XREF 块即使存在空定义也标记为缺失引用
  for (const name of xrefBlocks) ctx.missingRefs.set(name, 0);

  const blockDefs: BlockDef[] = [];
  for (const [name, def] of ctx.blocks) {
    blockDefs.push({ name, bx: def.bx, by: def.by, records: def.records });
  }
  if (blockDefs.length > 0) post({ t: 'blockdefs', blocks: blockDefs });

  // 空间规划
  const paperBlocks = blockEntries.filter((b) => b.name && b.name.startsWith('*Paper_Space') && (b.entities?.length ?? 0) > 0);
  const spaces: { name: string }[] = [{ name: '模型空间' }];
  for (let i = 0; i < paperBlocks.length; i++) {
    const num = paperBlocks[i].name!.replace('*Paper_Space', '');
    spaces.push({ name: `布局${num === '' ? 1 : parseInt(num, 10) + 1}` });
  }

  post({
    t: 'meta',
    meta: {
      version: (header?.version as string) ?? '',
      extMin: exMin && isFinite(exMin?.x) ? [exMin.x, exMin.y] : [0, 0],
      extMax: exMax && isFinite(exMax?.x) ? [exMax.x, exMax.y] : [100, 100],
      layers,
      ltypes,
      spaces,
    },
  });

  progress('烘焙模型空间…', 40);
  const modelEnts = (db.entities ?? []).filter((e) => !(e as { isInPaperSpace?: boolean }).isInPaperSpace);
  convertSpace(modelEnts, 0, ctx, `转换实体 0/${modelEnts.length}`, 40, 70);

  for (let i = 0; i < paperBlocks.length; i++) {
    const ents = (paperBlocks[i].entities ?? []).filter((e) => e.type !== 'VIEWPORT' && e.type !== 'ATTDEF' && e.type !== 'SEQEND');
    const from = 70 + Math.round((i / paperBlocks.length) * 25);
    const to = 70 + Math.round(((i + 1) / paperBlocks.length) * 25);
    convertSpace(ents, i + 1, ctx, `烘焙${spaces[i + 1].name}…`, from, to);
  }

  // 统计缺失引用 (xref 计数为 0 次引用也保留, 由主线程决定展示)
  const missingXrefs = Array.from(ctx.missingRefs.entries())
    .filter(([, n]) => n >= 0)
    .map(([name, n]) => ({ name, refs: n }));

  const ext0 = ctx.spaceExts.get(0) ?? { x1: 0, y1: 0, x2: 100, y2: 100 };
  post({
    t: 'done',
    entityCount: ctx.entityCount,
    skipped: ctx.skipped,
    exts: Array.from(ctx.spaceExts.values()).map((e) => [e.x1, e.y1, e.x2, e.y2] as [number, number, number, number]),
    robustExts: Array.from(ctx.robustExts.values()).map((e) => [e.x1, e.y1, e.x2, e.y2] as [number, number, number, number]),
    modelExt: [ext0.x1, ext0.y1, ext0.x2, ext0.y2] as [number, number, number, number],
    unsupported: {
      types: Array.from(ctx.skippedTypes.entries()),
      missingRefs: missingXrefs,
      errorSamples: Array.from(ctx.errorSamples.entries()).slice(0, 4),
    },
  });
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.t !== 'parse') return;
  try {
    await parse(msg.buf, msg.wasmBase);
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
