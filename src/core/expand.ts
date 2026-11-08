/** 块展开 / 记录变换 —— worker 与主线程共用 */
import { arcPoints, ellipsePoints, polylinePoints } from './tess';
import type { EntRecord } from './types';
import earcut from 'earcut';

export interface ExpandSink {
  segs: number[];      // 段顶点 [x,y,r,g,b] ×2/段
  segIds: number[];
  segAci: number[];    // 每段一个有效 ACI
  tris: number[];
  triIds: number[];
  triAci: number[];
  records: EntRecord[];
}

export interface ExpandAcc {
  bb: { x1: number; y1: number; x2: number; y2: number };
  ok: boolean;
}

export type BlocksMap = Map<string, { bx: number; by: number; records: EntRecord[] }>;

let idSeq = 100_000_000; // 共享 id 池 (主线程新增实体用, 避免与解析 id 冲突)
export const allocId = () => idSeq++;

export function pushSegs(sink: ExpandSink, pts: number[], id: number, rgb: number, close: boolean, aci = 7): void {
  const r = ((rgb >> 16) & 255) / 255, g = ((rgb >> 8) & 255) / 255, b = (rgb & 255) / 255;
  const n = pts.length / 2;
  if (n < 2) return;
  const count = close ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    sink.segs.push(pts[i * 2], pts[i * 2 + 1], r, g, b);
    sink.segs.push(pts[j * 2], pts[j * 2 + 1], r, g, b);
    sink.segIds.push(id);
    sink.segAci.push(aci);
  }
}

export function pushTris(sink: ExpandSink, tris: number[], id: number, rgb: number, aci = 7): void {
  const r = ((rgb >> 16) & 255) / 255, g = ((rgb >> 8) & 255) / 255, b = (rgb & 255) / 255;
  for (let i = 0; i < tris.length; i += 2) sink.tris.push(tris[i], tris[i + 1], r, g, b);
  const triCount = tris.length / 6;
  for (let i = 0; i < triCount; i++) {
    sink.triIds.push(id);
    sink.triAci.push(aci);
  }
}

export function triangulateLoops(loops: Float32Array[]): number[] | null {
  const vertsAll: number[] = [];
  const holeIdx: number[] = [];
  for (const loop of loops) {
    holeIdx.push(vertsAll.length / 2);
    for (let i = 0; i < loop.length; i += 2) vertsAll.push(loop[i], loop[i + 1]);
  }
  holeIdx.shift();
  try {
    const triIdx = earcut(vertsAll, holeIdx.length ? holeIdx : undefined, 2);
    const tris: number[] = [];
    for (const ti of triIdx) tris.push(vertsAll[ti * 2], vertsAll[ti * 2 + 1]);
    return tris.length >= 6 ? tris : null;
  } catch {
    return null;
  }
}

/** 块定义记录 → 本地坐标离散点 */
export function tessDefRecord(d: EntRecord, dev: number): number[] | null {
  switch (d.type) {
    case 'LINE': return d.d as number[];
    case 'CIRCLE': {
      const [cx, cy, r] = d.d as [number, number, number];
      const out: number[] = [];
      arcPoints(cx, cy, r, 0, Math.PI * 2, dev, out);
      return out;
    }
    case 'ARC': {
      const [cx, cy, r, a0, a1] = d.d as [number, number, number, number, number];
      const out: number[] = [];
      arcPoints(cx, cy, r, a0, a1, dev, out);
      return out;
    }
    case 'ELLIPSE': {
      const [cx, cy, mx, my, ratio, a0, a1] = d.d as [number, number, number, number, number, number, number];
      const out: number[] = [];
      ellipsePoints(cx, cy, mx, my, ratio, a0, a1, dev, out);
      return out;
    }
    case 'PLINE': {
      const pl = d.d as { v: Float32Array; b?: Float32Array; closed: boolean };
      const out: number[] = [];
      polylinePoints(pl.v, pl.b ?? null, pl.closed, dev, out);
      return out;
    }
    case 'SOLID': {
      const v = (d.d as { v: Float32Array }).v;
      return [v[0], v[1], v[2], v[3], v[6], v[7], v[8], v[9], v[0], v[1]];
    }
    default: return null;
  }
}

const MAX_DEPTH = 8;

/** 将块定义按插入变换展开进 sink */
export function expandInsertInto(
  sink: ExpandSink,
  def: { records: EntRecord[] },
  blocks: BlocksMap,
  ox: number, oy: number, sx: number, sy: number, rot: number, colorOverride: number,
  dev: number, depth: number, seen: Set<string>, insertId: number,
  acc?: ExpandAcc,
  aciOverride = 7, alpha = 255,
): ExpandAcc | null {
  if (depth > MAX_DEPTH) return acc ?? null;
  const A: ExpandAcc = acc ?? { bb: { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }, ok: false };
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  const subAci = (d: EntRecord): number => (d.color < 0 ? aciOverride : (d.aci ?? 7));

  const pushPoint = (lx: number, ly: number): [number, number] => {
    // CAD 插入变换: world = O + R(rot)·S(sx,sy)·local (先缩放后旋转)
    const px = lx * sx, py = ly * sy;
    const wx = ox + px * cosr - py * sinr;
    const wy = oy + px * sinr + py * cosr;
    if (wx < A.bb.x1) A.bb.x1 = wx;
    if (wy < A.bb.y1) A.bb.y1 = wy;
    if (wx > A.bb.x2) A.bb.x2 = wx;
    if (wy > A.bb.y2) A.bb.y2 = wy;
    A.ok = true;
    return [wx, wy];
  };

  for (const d of def.records) {
    const rgb = d.color < 0 ? colorOverride : d.color;
    const aci = subAci(d);
    if (d.type === 'INSERT') {
      const nd = d.d as { name: string; x: number; y: number; sx: number; sy: number; rot: number };
      const inner = blocks.get(nd.name);
      if (inner && !seen.has(nd.name)) {
        const s2 = new Set(seen);
        s2.add(nd.name);
        const [wx, wy] = pushPoint(nd.x, nd.y);
        expandInsertInto(sink, inner, blocks, wx, wy, sx * nd.sx, sy * nd.sy, rot + (nd.rot * Math.PI) / 180,
          rgb, dev, depth + 1, s2, insertId, A, aci, alpha);
      }
      continue;
    }
    if (d.type === 'TEXT' || d.type === 'MTEXT') {
      const td = d.d as { x: number; y: number; h: number; rot: number; text: string; ha?: number; va?: number; attach?: number; wf?: number };
      const [wx, wy] = pushPoint(td.x, td.y);
      const h = td.h * Math.abs(sy);
      sink.records.push({
        id: allocId(), type: d.type, layer: d.layer, color: rgb, lt: -1, sp: d.sp, aci, alpha,
        bb: { x1: wx, y1: wy, x2: wx + h * td.text.length * 0.8, y2: wy + h },
        d: { x: wx, y: wy, h, rot: td.rot + (rot * 180) / Math.PI, text: td.text, ha: td.ha ?? 0, va: td.va ?? 0, attach: td.attach ?? 1, wf: td.wf ?? 1 },
        group: insertId,
      });
      continue;
    }
    if (d.type === 'HATCH') {
      const hd = d.d as { loops: Float32Array[]; solid: boolean; pattern: string };
      const wLoops: Float32Array[] = [];
      const hbb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
      for (const loop of hd.loops) {
        const w = new Float32Array(loop.length);
        for (let i = 0; i < loop.length; i += 2) {
          const [wx, wy] = pushPoint(loop[i], loop[i + 1]);
          w[i] = wx; w[i + 1] = wy;
          if (wx < hbb.x1) hbb.x1 = wx;
          if (wy < hbb.y1) hbb.y1 = wy;
          if (wx > hbb.x2) hbb.x2 = wx;
          if (wy > hbb.y2) hbb.y2 = wy;
        }
        wLoops.push(w);
      }
      sink.records.push({
        id: allocId(), type: 'HATCH', layer: d.layer, color: rgb, lt: -1, sp: d.sp, aci, alpha,
        bb: hbb, d: { loops: wLoops, solid: hd.solid, pattern: hd.pattern }, group: insertId,
      });
      const tris = triangulateLoops(wLoops);
      if (tris) pushTris(sink, tris, insertId, rgb, aci);
      continue;
    }
    if (d.type === 'SOLID') {
      const v = (d.d as { v: Float32Array }).v;
      const world: number[] = [];
      for (let i = 0; i < v.length; i += 2) {
        const [wx, wy] = pushPoint(v[i], v[i + 1]);
        world.push(wx, wy);
      }
      sink.records.push({
        id: allocId(), type: 'SOLID', layer: d.layer, color: rgb, lt: -1, sp: d.sp, aci, alpha,
        bb: { x1: A.bb.x1, y1: A.bb.y1, x2: A.bb.x2, y2: A.bb.y2 },
        d: { v: new Float32Array(world) }, group: insertId,
      });
      pushTris(sink, world, insertId, rgb, aci);
      continue;
    }
    const pts = tessDefRecord(d, dev);
    if (!pts) continue;
    const world: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const [wx, wy] = pushPoint(pts[i], pts[i + 1]);
      world.push(wx, wy);
    }
    pushSegs(sink, world, insertId, rgb, !!(d.type === 'CIRCLE' || (d.type === 'PLINE' && (d.d as { closed?: boolean }).closed)), aci);
  }
  return A.ok ? A : null;
}

/** 平移记录 (原地) */
export function shiftRecord(rec: EntRecord, dx: number, dy: number): void {
  rec.bb.x1 += dx; rec.bb.x2 += dx; rec.bb.y1 += dy; rec.bb.y2 += dy;
  switch (rec.type) {
    case 'LINE': {
      const d = rec.d as number[];
      d[0] += dx; d[1] += dy; d[2] += dx; d[3] += dy;
      break;
    }
    case 'CIRCLE': case 'ARC': case 'ELLIPSE': case 'POINT': {
      const d = rec.d as number[];
      d[0] += dx; d[1] += dy;
      break;
    }
    case 'PLINE': {
      const d = rec.d as { v: Float32Array };
      for (let i = 0; i < d.v.length; i += 2) { d.v[i] += dx; d.v[i + 1] += dy; }
      break;
    }
    case 'TEXT': case 'MTEXT': case 'INSERT': {
      const d = rec.d as { x: number; y: number };
      d.x += dx; d.y += dy;
      break;
    }
    case 'HATCH': {
      const d = rec.d as { loops: Float32Array[] };
      for (const loop of d.loops) {
        for (let i = 0; i < loop.length; i += 2) { loop[i] += dx; loop[i + 1] += dy; }
      }
      break;
    }
    case 'SOLID': {
      const d = rec.d as { v: Float32Array };
      for (let i = 0; i < d.v.length; i += 2) { d.v[i] += dx; d.v[i + 1] += dy; }
      break;
    }
  }
}

/** MTEXT 内联格式码剥离 */
export function stripMText(s: string): string {
  let out = s;
  out = out.replace(/\\P/g, '\n').replace(/\\~/g, ' ');
  out = out.replace(/\\[fFhHcCaAwWqQtTbBlLoOpPrRsSkKxXzZ][^;\\{}]*;/g, '');
  out = out.replace(/\\\{/g, '\u0001').replace(/\\\}/g, '\u0002');
  out = out.replace(/[{}]/g, '');
  out = out.replace(/\u0001/g, '{').replace(/\u0002/g, '}');
  out = out.replace(/\\S([^;]*);/g, '$1');
  out = out.replace(/\\[A-Za-z][0-9]*;?/g, '');
  return out.trim();
}

/** TEXT 特殊字符解码 */
export function decodeText(s: string): string {
  return s
    .replace(/%%c/gi, 'Ø').replace(/%%d/gi, '°').replace(/%%p/gi, '±')
    .replace(/%%u/gi, '').replace(/%%o/gi, '').replace(/%%%/g, '%');
}
