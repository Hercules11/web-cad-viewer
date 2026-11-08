/** 对象捕捉: 端点/中点/圆心/象限/最近点 */
import { Doc } from './document';
import type { EntRecord } from '../core/types';

export type SnapKind = 'END' | 'MID' | 'CEN' | 'QUA' | 'NEA';

export interface SnapPoint {
  x: number;
  y: number;
  kind: SnapKind;
  rec: EntRecord;
}

const KIND_ORDER: Record<SnapKind, number> = { END: 0, MID: 1, CEN: 2, QUA: 3, NEA: 9 };

/** 在容差内找最佳捕捉点 */
export function findSnap(doc: Doc, space: number, x: number, y: number, tol: number): SnapPoint | null {
  const rect = { x1: x - tol, y1: y - tol, x2: x + tol, y2: y + tol };
  const cands = doc.queryRect(space, rect);
  let best: SnapPoint | null = null;
  let bestD = Infinity;
  let bestRank = 99;
  for (const rec of cands) {
    for (const sp of snapPointsOf(rec)) {
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > tol) continue;
      const rank = KIND_ORDER[sp.kind];
      if (rank < bestRank || (rank === bestRank && d < bestD)) {
        best = sp;
        bestD = d;
        bestRank = rank;
      }
    }
  }
  if (best) return best;
  // 最近点捕捉
  const rec = doc.pick(space, x, y, tol);
  if (rec) {
    const np = nearestOnRecord(rec, x, y);
    if (np) return { x: np[0], y: np[1], kind: 'NEA', rec };
  }
  return null;
}

export function* snapPointsOf(rec: EntRecord): Generator<SnapPoint> {
  const d = rec.d as never;
  const mk = (x: number, y: number, kind: SnapKind): SnapPoint => ({ x, y, kind, rec });
  switch (rec.type) {
    case 'LINE': {
      const [x1, y1, x2, y2] = d as number[];
      yield mk(x1, y1, 'END');
      yield mk(x2, y2, 'END');
      yield mk((x1 + x2) / 2, (y1 + y2) / 2, 'MID');
      break;
    }
    case 'CIRCLE': {
      const [cx, cy, r] = d as [number, number, number];
      yield mk(cx, cy, 'CEN');
      yield mk(cx + r, cy, 'QUA');
      yield mk(cx - r, cy, 'QUA');
      yield mk(cx, cy + r, 'QUA');
      yield mk(cx, cy - r, 'QUA');
      break;
    }
    case 'ARC': {
      const [cx, cy, r, a0, a1] = d as [number, number, number, number, number];
      yield mk(cx, cy, 'CEN');
      yield mk(cx + r * Math.cos(a0), cy + r * Math.sin(a0), 'END');
      yield mk(cx + r * Math.cos(a1), cy + r * Math.sin(a1), 'END');
      break;
    }
    case 'ELLIPSE': {
      const [cx, cy] = d as [number, number, ...number[]];
      yield mk(cx, cy, 'CEN');
      break;
    }
    case 'PLINE': {
      const pl = d as { v: Float32Array; closed: boolean };
      const n = pl.v.length / 2;
      for (let i = 0; i < n; i++) {
        yield mk(pl.v[i * 2], pl.v[i * 2 + 1], 'END');
      }
      break;
    }
    case 'POINT': {
      const [px, py] = d as [number, number];
      yield mk(px, py, 'END');
      break;
    }
    default:
      break;
  }
}

function nearestOnRecord(rec: EntRecord, x: number, y: number): [number, number] | null {
  const d = rec.d as never;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  const check = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    const dd = (qx - x) ** 2 + (qy - y) ** 2;
    if (dd < bestD) { bestD = dd; best = [qx, qy]; }
  };
  switch (rec.type) {
    case 'LINE': {
      const [x1, y1, x2, y2] = d as number[];
      check(x1, y1, x2, y2);
      break;
    }
    case 'PLINE': {
      const pl = d as { v: Float32Array; closed: boolean };
      const n = pl.v.length / 2;
      const segs = pl.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        check(pl.v[i * 2], pl.v[i * 2 + 1], pl.v[j * 2], pl.v[j * 2 + 1]);
      }
      break;
    }
    default:
      return null;
  }
  return best;
}
