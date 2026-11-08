/** 几何离散化 —— worker 解析与主线程编辑共用 */

export interface TessOut {
  segs: number[];   // x,y 坐标对序列 (折线段)
  tris: number[];   // 填充三角形 (HATCH/SOLID)
}

export function newTessOut(): TessOut {
  return { segs: [], tris: [] };
}

/** 圆弧离散: 从角 a0 逆时针扫到 a1 (自动归一化) */
export function arcPoints(
  cx: number, cy: number, r: number,
  a0: number, a1: number, dev: number, out: number[],
): void {
  if (r <= 0) return;
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += Math.PI * 2; // 逆时针, 最小整圆保护
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  // 弦高偏差 → 步进角
  let step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - dev / r)));
  if (!isFinite(step) || step <= 0) step = Math.PI / 12;
  const n = Math.max(2, Math.min(1024, Math.ceil(sweep / step) + 1));
  for (let i = 0; i < n; i++) {
    const a = a0 + (sweep * i) / (n - 1);
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** 椭圆弧离散 (参数角) */
export function ellipsePoints(
  cx: number, cy: number, mx: number, my: number, ratio: number,
  a0: number, a1: number, dev: number, out: number[],
): void {
  const mj = Math.hypot(mx, my);
  if (mj < 1e-12) return;
  const mn = mj * ratio;
  const ca = mx / mj, sa = my / mj;   // 主轴方向
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  const rEff = Math.max(mj, mn);
  let step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - dev / rEff)));
  if (!isFinite(step) || step <= 0) step = Math.PI / 12;
  const n = Math.max(2, Math.min(1024, Math.ceil(sweep / step) + 1));
  for (let i = 0; i < n; i++) {
    const t = a0 + (sweep * i) / (n - 1);
    const u = mj * Math.cos(t), v = mn * Math.sin(t);
    // (u,v) 沿主轴/副轴 → 旋转到世界
    out.push(cx + u * ca - v * sa, cy + u * sa + v * ca);
  }
}

export interface BulgeArc {
  cx: number; cy: number; r: number;
  a0: number; a1: number; ccw: boolean;
}

/** LWPOLYLINE bulge → 圆弧参数 */
export function bulgeToArc(
  x1: number, y1: number, x2: number, y2: number, b: number,
): BulgeArc | null {
  if (Math.abs(b) < 1e-9) return null;
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return null;
  const th = 4 * Math.atan(b);            // 圆心角 (带符号)
  const half = chord / 2;
  const r = half / Math.abs(Math.sin(th / 2));
  const apothem = half / Math.tan(th / 2); // 带符号: 中点到圆心距离
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  // 垂线方向 (旋转90°)
  const px = -dy / chord, py = dx / chord;
  const cx = mx + px * apothem, cy = my + py * apothem;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const a1 = Math.atan2(y2 - cy, x2 - cx);
  return { cx, cy, r, a0, a1, ccw: b > 0 };
}

/** 带 bulge 的折线离散 */
export function polylinePoints(
  v: Float32Array, bulges: Float32Array | null, closed: boolean,
  dev: number, out: number[],
): void {
  const n = v.length / 2;
  if (n === 0) return;
  const segCount = closed ? n : n - 1;
  out.push(v[0], v[1]);
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const x1 = v[i * 2], y1 = v[i * 2 + 1];
    const x2 = v[j * 2], y2 = v[j * 2 + 1];
    const b = bulges ? bulges[i] : 0;
    if (Math.abs(b) > 1e-9) {
      const arc = bulgeToArc(x1, y1, x2, y2, b);
      if (arc) {
        const tmp: number[] = [];
        arcPointsSigned(arc, dev, tmp);
        // 第一点和上一点重复, 跳过
        for (let k = 1; k < tmp.length; k += 2) out.push(tmp[k - 1], tmp[k]);
        continue;
      }
    }
    out.push(x2, y2);
  }
}

/** 带方向 (顺/逆时针) 的圆弧离散 */
export function arcPointsSigned(arc: BulgeArc, dev: number, out: number[]): void {
  let a0 = arc.a0, a1 = arc.a1;
  if (arc.ccw) {
    let sweep = a1 - a0;
    while (sweep <= 1e-9) sweep += Math.PI * 2;
    emitArc(arc.cx, arc.cy, arc.r, a0, sweep, dev, out);
  } else {
    let sweep = a0 - a1;
    while (sweep <= 1e-9) sweep += Math.PI * 2;
    emitArc(arc.cx, arc.cy, arc.r, a0, -sweep, dev, out);
  }
}

function emitArc(cx: number, cy: number, r: number, a0: number, sweep: number, dev: number, out: number[]): void {
  if (r <= 0) return;
  const absSweep = Math.abs(sweep);
  let step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - dev / r)));
  if (!isFinite(step) || step <= 0) step = Math.PI / 12;
  const n = Math.max(2, Math.min(1024, Math.ceil(absSweep / step) + 1));
  for (let i = 0; i < n; i++) {
    const a = a0 + (sweep * i) / (n - 1);
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** 三次均匀 B 样条 / NURBS 展平 (简化 de Boor, 均匀采样) */
export function splinePoints(
  ctrl: number[],      // x,y 平铺
  knots: number[],
  weights: number[] | null,
  degree: number,
  out: number[],
): void {
  const ncp = ctrl.length / 2;
  if (ncp < 2) return;
  if (knots.length < ncp + degree + 1) {
    // 缺节点 → 退化为折线
    for (let i = 0; i < ncp; i++) out.push(ctrl[i * 2], ctrl[i * 2 + 1]);
    return;
  }
  // 节点区间 [knots[degree], knots[ncp]]
  const t0 = knots[degree], t1 = knots[ncp];
  if (!(t1 > t0)) {
    for (let i = 0; i < ncp; i++) out.push(ctrl[i * 2], ctrl[i * 2 + 1]);
    return;
  }
  const perSpan = 16;
  const nSpan = ncp - degree;
  const total = Math.min(2048, Math.max(8, nSpan * perSpan));
  for (let i = 0; i <= total; i++) {
    const t = t0 + ((t1 - t0) * i) / total;
    // 找节点区间
    let k = degree;
    while (k < ncp && knots[k + 1] <= t) k++;
    if (k > ncp - 1) k = ncp - 1;
    // de Boor 递推
    const dx: number[] = [], dy: number[] = [], dw: number[] = [];
    for (let j = 0; j <= degree; j++) {
      const idx = k - degree + j;
      const w = weights ? weights[idx] : 1;
      dx.push(ctrl[idx * 2] * w); dy.push(ctrl[idx * 2 + 1] * w); dw.push(w);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i0 = k - degree + j;
        const denom = knots[i0 + 1] - knots[i0 + 1 - r];
        const alpha = denom > 1e-12 ? (t - knots[i0 + 1 - r]) / denom : 0;
        dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
        dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
        dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
      }
    }
    const w = dw[degree] > 1e-12 ? dw[degree] : 1;
    out.push(dx[degree] / w, dy[degree] / w);
  }
}

/** 两点距离的平方 */
export function distPtSeg2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + t * dx - px, qy = y1 + t * dy - py;
  return qx * qx + qy * qy;
}
