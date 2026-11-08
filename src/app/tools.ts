/** 交互工具状态机: 选择/平移/绘制/框选导出 */
import { allocId, shiftRecord } from '../core/expand';
import { dynamicRenderCache } from '../render/renderer';
import type { Renderer } from '../render/renderer';
import type { View } from './view';
import { screenToWorld, zoomAt, zoomExtents } from './view';
import type { Doc, Rect } from './document';
import { AddCommand, DeleteCommand, MoveCommand, type UndoStack } from './commands';
import { findSnap } from './snapping';
import { aciToRgb } from '../core/aci';
import type { EntRecord } from '../core/types';

/** 兜底: 无主题解析器时按深色主题取色 */
function aciFallback(aci: number): number {
  return aciToRgb(aci, true);
}

export type ToolId = 'select' | 'pan' | 'line' | 'pline' | 'circle' | 'arc' | 'rect' | 'export';

export interface ToolHooks {
  setToolButton(id: ToolId): void;
  showMarquee(rectCss: { x: number; y: number; w: number; h: number } | null, crossing: boolean): void;
  onExportRect(rect: Rect): void;
  onCoords(x: number, y: number): void;
  onStatus(text: string): void;
  onSelectionChanged(count: number): void;
  onEditCommitted(): void;
}

export class Tools {
  tool: ToolId = 'select';
  snapEnabled = true;
  selection = new Set<number>();
  private dragMode: 'none' | 'pan' | 'marquee' | 'move' = 'none';
  private downScreen = { x: 0, y: 0 };
  private lastScreen = { x: 0, y: 0 };
  private panning = false;
  // 绘制状态
  private pending: [number, number][] = [];   // 已确认的点 (世界)
  private moveStart: [number, number] | null = null;
  private space = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private view: View,
    private doc: Doc,
    private renderer: Renderer,
    private undo: UndoStack,
    private hooks: ToolHooks,
  ) {
    this.bind();
  }

  setSpace(s: number): void {
    this.space = s;
    this.cancel();
  }

  setTool(id: ToolId): void {
    this.cancel();
    this.tool = id;
    this.hooks.setToolButton(id);
    const hints: Record<ToolId, string> = {
      select: '单击选择 / 拖拽框选 (左→右包含, 右→左相交) / 拖动所选移动',
      pan: '拖拽平移视图, 滚轮缩放',
      line: '直线: 依次点击起点、终点; 连续绘制, 右键或 ESC 结束',
      pline: '多段线: 连续点击顶点; 右键或 ESC 结束',
      circle: '圆: 点击圆心, 再点击确定半径',
      arc: '圆弧: 依次点击圆心、起点、终点方向',
      rect: '矩形: 点击两个对角点',
      export: '框选导出: 拖拽选择矩形区域后松开',
    };
    this.hooks.onStatus(hints[id]);
  }

  cancel(): void {
    this.pending = [];
    this.dragMode = 'none';
    this.moveStart = null;
    this.hooks.showMarquee(null, false);
    this.renderer.clearOverlay();
    this.refreshSelectionOverlay();
  }

  setSelection(ids: Iterable<number>): void {
    this.selection = new Set(ids);
    this.refreshSelectionOverlay();
    this.hooks.onSelectionChanged(this.selection.size);
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  deleteSelection(): void {
    if (this.selection.size === 0) return;
    const recs: EntRecord[] = [];
    for (const id of this.selection) {
      const rec = this.doc.records.get(id);
      if (rec) recs.push(rec);
    }
    if (recs.length === 0) return;
    const cmd = new DeleteCommand(this.doc, recs);
    cmd.redo();
    this.undo.push(cmd);
    this.clearSelection();
    this.hooks.onEditCommitted();
  }

  zoomToExtents(): void {
    const sd = this.doc.spaceData[this.space];
    if (!sd) return;
    const e = sd.zoomExt ?? sd.ext;
    zoomExtents(this.view, e.x1, e.y1, e.x2, e.y2);
    this.syncCamera();
  }

  // ---------- 事件绑定 ----------
  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => { this.hooks.onCoords(NaN, NaN); });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    c.addEventListener('dblclick', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private toLocal(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return screenToWorld(this.view, sx, sy);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.pending.length > 0) this.cancel();
      else this.clearSelection();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection.size > 0 && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        this.deleteSelection();
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.toLocal(e);
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    zoomAt(this.view, x, y, factor);
    this.syncCamera();
  }

  private snapTol(): number {
    return 9 * this.view.scale;
  }

  private applySnap(wx: number, wy: number): [number, number] {
    if (!this.snapEnabled) return [wx, wy];
    const sp = findSnap(this.doc, this.space, wx, wy, this.snapTol());
    if (sp) return [sp.x, sp.y];
    return [wx, wy];
  }

  private onDown(e: PointerEvent): void {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 捕获失败不影响交互 */ }
    const { x, y } = this.toLocal(e);
    this.downScreen = { x, y };
    this.lastScreen = { x, y };
    this.lastScreen = { x, y };
    const [wx, wy] = this.toWorld(x, y);

    if (e.button === 1 || e.button === 2 || this.tool === 'pan') {
      this.panning = true;
      return;
    }
    if (e.button !== 0) return;

    switch (this.tool) {
      case 'select': {
        // 点击在已选实体上 → 准备移动
        const tol = 6 * this.view.scale;
        const hit = this.doc.pick(this.space, wx, wy, tol);
        if (hit && this.selection.has(hit.id)) {
          this.dragMode = 'move';
          this.moveStart = this.applySnap(wx, wy);
        } else {
          this.dragMode = 'marquee';
          this.hooks.showMarquee({ x, y, w: 0, h: 0 }, false);
        }
        break;
      }
      case 'export': {
        this.dragMode = 'marquee';
        this.hooks.showMarquee({ x, y, w: 0, h: 0 }, false);
        break;
      }
      case 'line':
      case 'pline':
      case 'rect':
      case 'circle':
      case 'arc': {
        const [sx, sy] = this.applySnap(wx, wy);
        this.pending.push([sx, sy]);
        this.updateDrawGhost();
        break;
      }
      default:
        break;
    }
  }

  private onMove(e: PointerEvent): void {
    const { x, y } = this.toLocal(e);
    const [wx, wy] = this.toWorld(x, y);
    this.hooks.onCoords(wx, wy);

    if (this.panning) {
      const dx = (x - this.lastScreen.x) * this.view.scale;
      const dy = (y - this.lastScreen.y) * this.view.scale;
      this.view.cx -= dx;
      this.view.cy += dy;
      this.lastScreen = { x, y };
      this.syncCamera();
      return;
    }
    this.lastScreen = { x, y };

    // 捕捉点提示
    if ((this.tool === 'select' || isDrawTool(this.tool)) && this.dragMode === 'none') {
      if (this.snapEnabled) {
        const sp = findSnap(this.doc, this.space, wx, wy, this.snapTol());
        if (sp) {
          const s = 5 * this.view.scale;
          const sq = [sp.x - s, sp.y - s, sp.x + s, sp.y - s, sp.x + s, sp.y + s, sp.x - s, sp.y + s, sp.x - s, sp.y - s];
          const ghost = this.drawGhostPoints(sp.x, sp.y);
          this.renderer.setOverlayLines([sq, ...ghost], 0xffcc00, 0.6);
        } else if (this.pending.length > 0) {
          this.renderer.setOverlayLines(this.drawGhostPoints(wx, wy), 0x00aaff, 0.6);
        } else {
          this.renderer.clearOverlay();
        }
      }
    }

    if (this.dragMode === 'marquee') {
      const w = x - this.downScreen.x;
      const h = y - this.downScreen.y;
      this.hooks.showMarquee(
        { x: Math.min(x, this.downScreen.x), y: Math.min(y, this.downScreen.y), w: Math.abs(w), h: Math.abs(h) },
        w < 0,
      );
      return;
    }

    if (this.dragMode === 'move' && this.moveStart) {
      const [sx, sy] = this.applySnap(wx, wy);
      const dx = sx - this.moveStart[0];
      const dy = sy - this.moveStart[1];
      this.showMoveGhost(dx, dy);
      return;
    }

    if (isDrawTool(this.tool) && this.pending.length > 0) {
      this.updateDrawGhost();
    }
  }

  private onUp(e: PointerEvent): void {
    try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
    const { x, y } = this.toLocal(e);
    const [wx, wy] = this.toWorld(x, y);

    if (this.panning) {
      this.panning = false;
      return;
    }

    if (this.dragMode === 'marquee') {
      const dx = x - this.downScreen.x;
      const dy = y - this.downScreen.y;
      this.hooks.showMarquee(null, false);
      if (Math.abs(dx) < 4 || Math.abs(dy) < 4) {
        this.dragMode = 'none';
        if (this.tool === 'select') this.clickSelect(wx, wy, e.shiftKey);
        return;
      }
      const r: Rect = {
        x1: Math.min(this.downScreen.x, x),
        y1: Math.min(this.downScreen.y, y),
        x2: Math.max(this.downScreen.x, x),
        y2: Math.max(this.downScreen.y, y),
      };
      if (this.tool === 'export') {
        const [wx1, wy1] = this.toWorld(r.x1, r.y1);
        const [wx2, wy2] = this.toWorld(r.x2, r.y2);
        this.dragMode = 'none';
        this.hooks.onExportRect({ x1: Math.min(wx1, wx2), y1: Math.min(wy1, wy2), x2: Math.max(wx1, wx2), y2: Math.max(wy1, wy2) });
        return;
      }
      // 框选
      const [wx1, wy1] = this.toWorld(r.x1, r.y1);
      const [wx2, wy2] = this.toWorld(r.x2, r.y2);
      const rect: Rect = {
        x1: Math.min(wx1, wx2), y1: Math.min(wy1, wy2),
        x2: Math.max(wx1, wx2), y2: Math.max(wy1, wy2),
      };
      const crossing = dx < 0;
      const hits = this.doc.queryRect(this.space, rect).filter((rec) => {
        if (crossing) return true; // 相交即可 (bbox 已过滤)
        // 包含: 实体包围盒完全在框内
        return rec.bb.x1 >= rect.x1 && rec.bb.x2 <= rect.x2 && rec.bb.y1 >= rect.y1 && rec.bb.y2 <= rect.y2;
      });
      const ids = hits.map((h) => h.id);
      if (e.shiftKey) {
        for (const id of ids) this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
      } else {
        this.selection = new Set(ids);
      }
      this.refreshSelectionOverlay();
      this.hooks.onSelectionChanged(this.selection.size);
      this.hooks.onStatus(`已选择 ${this.selection.size} 个实体${crossing ? ' (相交模式)' : ' (包含模式)'}`);
      this.dragMode = 'none';
      return;
    }

    if (this.dragMode === 'move' && this.moveStart) {
      const [sx, sy] = this.applySnap(wx, wy);
      const dx = sx - this.moveStart[0];
      const dy = sy - this.moveStart[1];
      this.dragMode = 'none';
      this.moveStart = null;
      this.renderer.clearOverlay();
      if (Math.abs(dx) * this.view.scale < 2 && Math.abs(dy) * this.view.scale < 2) {
        this.refreshSelectionOverlay();
        return;
      }
      const ids = [...this.selection];
      const cmd = new MoveCommand(this.doc, ids, dx, dy);
      cmd.redo();
      this.undo.push(cmd);
      this.refreshSelectionOverlay();
      this.hooks.onEditCommitted();
      return;
    }

    this.dragMode = 'none';

    // 绘制工具的完成判定 (捕捉坐标)
    const [swx, swy] = this.applySnap(wx, wy);
    if (this.tool === 'circle' && this.pending.length === 2) {
      const [cx, cy] = this.pending[0];
      const r = Math.hypot(swx - cx, swy - cy);
      if (r > 1e-9) {
        this.commitCircle(cx, cy, r);
      }
      this.pending = [];
      this.updateDrawGhost();
    } else if (this.tool === 'arc' && this.pending.length === 3) {
      const [cx, cy] = this.pending[0];
      const a0 = Math.atan2(this.pending[1][1] - cy, this.pending[1][0] - cx);
      const a1 = Math.atan2(swy - cy, swx - cx);
      const r = Math.hypot(this.pending[1][0] - cx, this.pending[1][1] - cy);
      if (r > 1e-9) this.commitArc(cx, cy, r, a0, a1);
      this.pending = [];
      this.updateDrawGhost();
    } else if (this.tool === 'rect' && this.pending.length === 2) {
      const [x1, y1] = this.pending[0];
      this.commitRect(x1, y1, swx, swy);
      this.pending = [];
      this.updateDrawGhost();
    } else if (this.tool === 'line' && this.pending.length === 2) {
      const [x1, y1] = this.pending[0];
      const [x2, y2] = this.pending[1];
      this.commitLine(x1, y1, x2, y2);
      // 连续绘制: 从终点继续
      this.pending = [[x2, y2]];
      this.updateDrawGhost();
    }
    // pline 持续加点, 由右键/ESC 提交
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.tool === 'pline' && this.pending.length >= 2) {
      const pts = this.pending;
      this.commitPline(pts, false);
      this.pending = [];
      this.updateDrawGhost();
    } else if (isDrawTool(this.tool)) {
      this.pending = [];
      this.updateDrawGhost();
    }
  };

  private clickSelect(wx: number, wy: number, additive: boolean): void {
    const tol = 6 * this.view.scale;
    const hit = this.doc.pick(this.space, wx, wy, tol);
    if (!hit) {
      if (!additive) this.clearSelection();
      return;
    }
    const ids = new Set<number>(additive ? this.selection : []);
    // 组选择: 尺寸标注等
    if (hit.group != null) {
      const sd = this.doc.spaceData[this.space];
      if (sd) {
        const all = [...sd.arr, ...sd.dynamic, ...sd.texts];
        for (const rec of all) {
          if (rec.group === hit.group) ids.add(rec.id);
        }
      }
      ids.add(hit.group); // INSERT 主记录
    } else {
      ids.add(hit.id);
    }
    this.setSelection(ids);
    this.hooks.onStatus(`选中: ${hit.type} (图层 ${this.doc.layers[hit.layer]?.name ?? hit.layer})`);
  }

  // ---------- 提交绘制 ----------
  private curLayer = 0;
  /** 新绘颜色: 'bylayer' 跟随图层, 或显式 ACI */
  drawColorMode: 'bylayer' | 'aci' = 'bylayer';
  drawAci = 7;
  /** 主题感知的颜色解析器 (main 注入) */
  colorResolver: ((aci: number) => number) | null = null;

  setDrawLayer(layer: number): void {
    this.curLayer = layer;
  }

  getDrawLayer(): number {
    return this.curLayer;
  }

  setDrawColor(mode: 'bylayer' | 'aci', aci: number): void {
    this.drawColorMode = mode;
    this.drawAci = aci;
  }

  /** 解析当前绘制颜色: BYLAYER 跟随图层色, 显式色随主题反转 */
  private resolveDrawColor(): { color: number; aci: number } {
    if (this.drawColorMode === 'bylayer') {
      const layer = this.doc.layers[this.curLayer];
      return { color: layer?.rgb ?? 0xffffff, aci: layer?.color ?? 7 };
    }
    const color = this.colorResolver ? this.colorResolver(this.drawAci) : aciFallback(this.drawAci);
    return { color, aci: this.drawAci };
  }

  private commitLine(x1: number, y1: number, x2: number, y2: number): void {
    const { color, aci } = this.resolveDrawColor();
    const rec: EntRecord = {
      id: allocId(), type: 'LINE', layer: this.curLayer, color, lt: -1, sp: this.space, aci,
      bb: { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) },
      d: [x1, y1, x2, y2],
    };
    this.commitRecords([rec]);
  }

  private commitPline(pts: [number, number][], closed: boolean): void {
    if (pts.length < 2) return;
    const { color, aci } = this.resolveDrawColor();
    const v = new Float32Array(pts.length * 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      v[i * 2] = pts[i][0]; v[i * 2 + 1] = pts[i][1];
      minX = Math.min(minX, pts[i][0]); minY = Math.min(minY, pts[i][1]);
      maxX = Math.max(maxX, pts[i][0]); maxY = Math.max(maxY, pts[i][1]);
    }
    const rec: EntRecord = {
      id: allocId(), type: 'PLINE', layer: this.curLayer, color, lt: -1, sp: this.space, aci,
      bb: { x1: minX, y1: minY, x2: maxX, y2: maxY },
      d: { v, closed },
    };
    this.commitRecords([rec]);
  }

  private commitCircle(cx: number, cy: number, r: number): void {
    const { color, aci } = this.resolveDrawColor();
    const rec: EntRecord = {
      id: allocId(), type: 'CIRCLE', layer: this.curLayer, color, lt: -1, sp: this.space, aci,
      bb: { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r },
      d: [cx, cy, r],
    };
    this.commitRecords([rec]);
  }

  private commitArc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const { color, aci } = this.resolveDrawColor();
    const rec: EntRecord = {
      id: allocId(), type: 'ARC', layer: this.curLayer, color, lt: -1, sp: this.space, aci,
      bb: { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r },
      d: [cx, cy, r, a0, a1],
    };
    this.commitRecords([rec]);
  }

  private commitRect(x1: number, y1: number, x2: number, y2: number): void {
    this.commitPline([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true);
  }

  private commitRecords(recs: EntRecord[]): void {
    const cmd = new AddCommand(this.doc, recs);
    cmd.redo();
    this.undo.push(cmd);
    this.hooks.onEditCommitted();
  }

  // ---------- 幽灵预览 ----------
  private drawGhostPoints(sx: number, sy: number): number[][] {
    if (this.pending.length === 0) return [];
    const out: number[][] = [];
    const base: [number, number][] = [...this.pending, [sx, sy]];
    if (this.tool === 'circle' && this.pending.length === 1) {
      const [cx, cy] = this.pending[0];
      const r = Math.hypot(sx - cx, sy - cy);
      out.push(circlePts(cx, cy, r));
      return out;
    }
    if (this.tool === 'arc' && this.pending.length >= 1) {
      const [cx, cy] = this.pending[0];
      if (this.pending.length === 2) {
        const a0 = Math.atan2(this.pending[1][1] - cy, this.pending[1][0] - cx);
        const a1 = Math.atan2(sy - cy, sx - cx);
        const r = Math.hypot(this.pending[1][0] - cx, this.pending[1][1] - cy);
        out.push(arcPts(cx, cy, r, a0, a1));
      } else {
        out.push(base.flat() as unknown as number[]);
      }
      return out;
    }
    out.push(base.flat() as unknown as number[]);
    return out;
  }

  private updateDrawGhost(): void {
    if (this.pending.length === 0) { this.renderer.clearOverlay(); return; }
    const last = this.pending[this.pending.length - 1];
    const ghost = this.drawGhostPoints(last[0], last[1]);
    this.renderer.setOverlayLines(ghost, 0x00aaff, 0.6);
  }

  private showMoveGhost(dx: number, dy: number): void {
    const lines: number[][] = [];
    for (const id of this.selection) {
      const rec = this.doc.records.get(id);
      if (!rec) continue;
      const clone = cloneRecordShallow(rec);
      shiftRecord(clone, dx, dy);
      lines.push(...recordPolylines(clone));
    }
    this.renderer.setOverlayLines(lines, 0xff8800, 0.55);
  }

  refreshSelectionOverlay(): void {
    if (this.selection.size === 0) { this.renderer.clearOverlay(); return; }
    const lines: number[][] = [];
    for (const id of this.selection) {
      const rec = this.doc.records.get(id);
      if (!rec) continue;
      lines.push(...recordPolylines(rec));
    }
    this.renderer.setOverlayLines(lines, 0x00ffaa, 0.55);
  }

  private syncCamera(): void {
    this.renderer.updateCamera(this.view, this.view.w, this.view.h);
  }

  /** 右键提交多段线 */
  attachContextMenu(): void {
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }
}

function isDrawTool(t: ToolId): boolean {
  return t === 'line' || t === 'pline' || t === 'circle' || t === 'arc' || t === 'rect';
}

function circlePts(cx: number, cy: number, r: number, seg = 48): number[] {
  const out: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, seg = 32): number[] {
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += Math.PI * 2;
  const out: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + (sweep * i) / seg;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

export function cloneRecordShallow(rec: EntRecord): EntRecord {
  return { ...rec, bb: { ...rec.bb } };
}

/** 记录 → 高亮折线组 */
export function recordPolylines(rec: EntRecord): number[][] {
  const sink = { segs: [], segIds: [], segAci: [], tris: [], triIds: [], triAci: [], records: [] };
  dynamicRenderCache.tessRecordForRender(sink, rec);
  const out: number[][] = [];
  let cur: number[] = [];
  let lastId = -1;
  for (let i = 0; i < sink.segs.length; i += 10) {
    const id = sink.segIds[i / 10];
    if (id !== lastId) {
      if (cur.length >= 4) out.push(cur);
      cur = [];
      lastId = id;
    }
    if (cur.length === 0) cur.push(sink.segs[i], sink.segs[i + 1]);
    cur.push(sink.segs[i + 5], sink.segs[i + 6]);
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}
