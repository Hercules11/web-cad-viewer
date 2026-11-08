/** 视图状态: 世界↔屏幕坐标换算 */

export interface View {
  cx: number;      // 视口中心 (世界坐标)
  cy: number;
  scale: number;   // 世界单位 / 屏幕像素
  w: number;       // 画布 CSS 像素
  h: number;
}

export function screenToWorld(v: View, sx: number, sy: number): [number, number] {
  return [
    v.cx + (sx - v.w / 2) * v.scale,
    v.cy - (sy - v.h / 2) * v.scale,
  ];
}

export function worldToScreen(v: View, wx: number, wy: number): [number, number] {
  return [
    v.w / 2 + (wx - v.cx) / v.scale,
    v.h / 2 - (wy - v.cy) / v.scale,
  ];
}

/** 以光标为中心缩放 */
export function zoomAt(v: View, sx: number, sy: number, factor: number): void {
  const [wx, wy] = screenToWorld(v, sx, sy);
  v.scale *= factor;
  v.scale = Math.min(1e9, Math.max(1e-9, v.scale));
  // 保持光标下的世界点不动
  v.cx = wx - (sx - v.w / 2) * v.scale;
  v.cy = wy + (sy - v.h / 2) * v.scale;
}

/** 范围缩放 */
export function zoomExtents(v: View, x1: number, y1: number, x2: number, y2: number, margin = 0.05): void {
  const w = Math.max(x2 - x1, 1e-9);
  const h = Math.max(y2 - y1, 1e-9);
  v.cx = (x1 + x2) / 2;
  v.cy = (y1 + y2) / 2;
  const scaleX = v.w / (w * (1 + margin * 2));
  const scaleY = v.h / (h * (1 + margin * 2));
  v.scale = 1 / Math.min(scaleX, scaleY);
}

/** 世界容差 → 屏幕像素下的取整 */
export function pixelToleranceWorld(v: View, px: number): number {
  return px * v.scale;
}
