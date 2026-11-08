/** three.js 渲染器: 按 (图层 × 透明度) 合批, 脏标记按需重绘, 支持深/浅主题重映射 */
import * as THREE from 'three';
import type { EntRecord } from '../core/types';
import { TextManager } from './textAtlas';
import { arcPoints, ellipsePoints, polylinePoints } from '../core/tess';
import { expandInsertInto, pushSegs, pushTris, triangulateLoops, type ExpandSink, type BlocksMap } from '../core/expand';

export interface ViewState {
  cx: number;          // 视口中心 (世界)
  cy: number;
  scale: number;       // 世界单位 / 屏幕像素
}

interface VariantObjs {
  lines: THREE.LineSegments | null;
  tris: THREE.Mesh | null;
}

interface LayerObjs {
  staticV: Map<number, VariantObjs>;   // key: alpha (255=不透明)
  dynamicV: Map<number, VariantObjs>;
}

interface SpaceGroup {
  root: THREE.Group;
  layers: Map<number, LayerObjs>;
}

const ADAPTIVE = (aci: number) => aci === 7 || aci === 0;

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
  private spaces = new Map<number, SpaceGroup>();
  private text = new TextManager();
  private needsRender = true;
  private rafId = 0;
  private dark = true;
  private canvas: HTMLCanvasElement;
  private running = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    this.renderer.setClearColor(this.bgColor(), 1);
    this.scene.background = new THREE.Color(this.bgColor());
    // 文字层必须挂进场景
    this.scene.add(this.text.object3d);
    this.resize();
  }

  private bgColor(): string {
    return this.dark ? '#1e1e1e' : '#f2f2f2';
  }

  get textManager(): TextManager {
    return this.text;
  }

  /** 清空全部场景 (重新打开文件) */
  reset(): void {
    for (const [, sg] of this.spaces) {
      disposeObject(sg.root);
      this.scene.remove(sg.root);
    }
    this.spaces.clear();
    this.text.clear();
    this.clearOverlay();
    this.invalidate();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.invalidate();
  }

  // ---------- 主题 ----------
  isDark(): boolean {
    return this.dark;
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    const bg = new THREE.Color(this.bgColor());
    this.renderer.setClearColor(bg, 1);
    this.scene.background = bg;
    // 重映射全部批颜色 (ACI 7 / BYBLOCK 随主题黑白反转)
    for (const [, sg] of this.spaces) {
      for (const [, lo] of sg.layers) {
        for (const [, v] of lo.staticV) {
          recolorLines(v.lines, dark);
          recolorTris(v.tris, dark);
        }
        for (const [, v] of lo.dynamicV) {
          recolorLines(v.lines, dark);
          recolorTris(v.tris, dark);
        }
      }
    }
    this.invalidate();
  }

  // ---------- 批数据 ----------
  addBatch(
    space: number,
    segs: Float32Array, segIds: Uint32Array, segAci: Uint8Array,
    tris: Float32Array, triIds: Uint32Array, triAci: Uint8Array,
    records: EntRecord[],
  ): void {
    const sg = this.space(space);
    for (const rec of records) this.text.addRecord(rec);
    // id → layer / alpha
    const idLayer = new Map<number, number>();
    const idAlpha = new Map<number, number>();
    for (const rec of records) {
      idLayer.set(rec.id, rec.layer);
      idAlpha.set(rec.id, rec.alpha ?? 255);
    }
    // 按 (图层, alpha) 聚合
    const groups = new Map<number, Map<number, { segs: number[]; segIds: number[]; segAci: number[]; tris: number[]; triIds: number[]; triAci: number[] }>>();
    const pushSeg = (layer: number, alpha: number, base: number, id: number, aci: number) => {
      let byAlpha = groups.get(layer);
      if (!byAlpha) { byAlpha = new Map(); groups.set(layer, byAlpha); }
      let b = byAlpha.get(alpha);
      if (!b) { b = { segs: [], segIds: [], segAci: [], tris: [], triIds: [], triAci: [] }; byAlpha.set(alpha, b); }
      for (let k = 0; k < 10; k++) b.segs.push(segs[base + k]);
      b.segIds.push(id);
      b.segAci.push(aci);
    };
    for (let i = 0; i < segs.length; i += 10) {
      const id = segIds[i / 10];
      pushSeg(idLayer.get(id) ?? 0, idAlpha.get(id) ?? 255, i, id, segAci[i / 10]);
    }
    for (let i = 0; i < tris.length; i += 15) {
      const id = triIds[i / 15];
      const layer = idLayer.get(id) ?? 0;
      const alpha = idAlpha.get(id) ?? 255;
      let byAlpha = groups.get(layer);
      if (!byAlpha) { byAlpha = new Map(); groups.set(layer, byAlpha); }
      let b = byAlpha.get(alpha);
      if (!b) { b = { segs: [], segIds: [], segAci: [], tris: [], triIds: [], triAci: [] }; byAlpha.set(alpha, b); }
      for (let k = 0; k < 15; k++) b.tris.push(tris[i + k]);
      b.triIds.push(id);
      b.triAci.push(triAci[i / 15]);
    }
    for (const [layer, byAlpha] of groups) {
      for (const [alpha, b] of byAlpha) {
        const lo = this.layerObjs(sg, layer);
        const v = this.variant(lo, alpha, false);
        if (b.segs.length > 0) {
          v.lines = appendLines(v.lines, b.segs, b.segIds, b.segAci, alpha);
          sg.root.add(v.lines);
        }
        if (b.tris.length > 0) {
          v.tris = appendTris(v.tris, b.tris, b.triIds, b.triAci, alpha);
          sg.root.add(v.tris);
        }
      }
    }
    this.invalidate();
  }

  // ---------- 编辑动态重建 ----------
  rebuildDynamic(space: number, layer: number, records: EntRecord[]): void {
    const sg = this.space(space);
    const lo = this.layerObjs(sg, layer);
    // 清空旧动态对象
    for (const [, v] of lo.dynamicV) {
      if (v.lines) { sg.root.remove(v.lines); v.lines.geometry.dispose(); v.lines = null; }
      if (v.tris) { sg.root.remove(v.tris); v.tris.geometry.dispose(); v.tris = null; }
    }
    lo.dynamicV.clear();
    // 按 alpha 分组重烘焙
    const byAlpha = new Map<number, EntRecord[]>();
    for (const rec of records) {
      const a = rec.alpha ?? 255;
      let arr = byAlpha.get(a);
      if (!arr) { arr = []; byAlpha.set(a, arr); }
      arr.push(rec);
    }
    for (const [alpha, recs] of byAlpha) {
      const sink: ExpandSink = { segs: [], segIds: [], segAci: [], tris: [], triIds: [], triAci: [], records: [] };
      for (const rec of recs) {
        dynamicRenderCache.tessRecordForRender(sink, rec);
      }
      const v = this.variant(lo, alpha, true);
      if (sink.segs.length > 0) {
        v.lines = makeLineSegments(sink.segs, sink.segIds, sink.segAci, alpha);
        recolorLines(v.lines, this.dark);
        sg.root.add(v.lines);
      }
      if (sink.tris.length > 0) {
        v.tris = makeTriMesh(sink.tris, sink.triIds, sink.triAci, alpha);
        recolorTris(v.tris, this.dark);
        sg.root.add(v.tris);
      }
    }
    this.invalidate();
  }

  /** 静态批中过滤已失效实体 */
  filterStatic(space: number, layer: number, removedIds: Set<number>): void {
    const sg = this.spaces.get(space);
    if (!sg) return;
    const lo = sg.layers.get(layer);
    if (!lo) return;
    for (const [, v] of lo.staticV) {
      if (v.lines) {
        const r = filterLines(v.lines, removedIds);
        if (r.geo) { v.lines.geometry = r.geo; v.lines.userData.segIds = r.ids; v.lines.userData.segAci = r.acis; }
        else { sg.root.remove(v.lines); v.lines.geometry.dispose(); v.lines = null; }
      }
      if (v.tris) {
        const r = filterTris(v.tris, removedIds);
        if (r.geo) { v.tris.geometry = r.geo; v.tris.userData.triIds = r.ids; v.tris.userData.triAci = r.acis; }
        else { sg.root.remove(v.tris); v.tris.geometry.dispose(); v.tris = null; }
      }
    }
    this.invalidate();
  }

  setLayerVisible(space: number, layer: number, visible: boolean): void {
    const sg = this.spaces.get(space);
    if (!sg) return;
    const lo = sg.layers.get(layer);
    if (lo) {
      for (const [, v] of lo.staticV) {
        if (v.lines) v.lines.visible = visible;
        if (v.tris) v.tris.visible = visible;
      }
      for (const [, v] of lo.dynamicV) {
        if (v.lines) v.lines.visible = visible;
        if (v.tris) v.tris.visible = visible;
      }
    }
    this.text.setLayerVisible(layer, visible);
    this.invalidate();
  }

  setSpaceVisible(active: number): void {
    for (const [idx, sg] of this.spaces) {
      sg.root.visible = idx === active;
    }
    this.text.setSpaceVisible(active);
    this.invalidate();
  }

  // ---------- 覆盖层 ----------
  private overlay: THREE.LineSegments | null = null;

  setOverlayLines(polylines: number[][], color = 0x00aaff, z = 0.5): void {
    if (this.overlay) {
      this.scene.remove(this.overlay);
      this.overlay.geometry.dispose();
      this.overlay = null;
    }
    const flat: number[] = [];
    for (const pts of polylines) {
      const n = pts.length / 2;
      if (n < 2) continue;
      for (let i = 0; i < n - 1; i++) {
        flat.push(pts[i * 2], pts[i * 2 + 1], z, pts[i * 2 + 2], pts[i * 2 + 3], z);
      }
    }
    if (flat.length === 0) { this.invalidate(); return; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    this.overlay = new THREE.LineSegments(geo, mat);
    this.overlay.renderOrder = 100;
    this.overlay.frustumCulled = false;
    this.scene.add(this.overlay);
    this.invalidate();
  }

  clearOverlay(): void {
    this.setOverlayLines([]);
  }

  // ---------- 相机 ----------
  updateCamera(view: ViewState, widthPx: number, heightPx: number): void {
    const hw = (widthPx / 2) * view.scale;
    const hh = (heightPx / 2) * view.scale;
    this.camera.left = view.cx - hw;
    this.camera.right = view.cx + hw;
    this.camera.top = view.cy + hh;
    this.camera.bottom = view.cy - hh;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate(): void {
    this.needsRender = true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      // 文字队列始终渐进处理 (不依赖 needsRender)
      if (this.text.pending > 0) this.text.flush(400);
      if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** 导出 PNG: 当前画布内容 */
  toBlob(scale = 2): Promise<Blob | null> {
    const src = this.canvas;
    const out = document.createElement('canvas');
    out.width = src.width * scale;
    out.height = src.height * scale;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = this.bgColor();
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return new Promise((res) => out.toBlob(res, 'image/png'));
  }

  private space(idx: number): SpaceGroup {
    let sg = this.spaces.get(idx);
    if (!sg) {
      const root = new THREE.Group();
      root.visible = idx === 0;
      this.scene.add(root);
      sg = { root, layers: new Map() };
      this.spaces.set(idx, sg);
    }
    return sg;
  }

  private layerObjs(sg: SpaceGroup, layer: number): LayerObjs {
    let lo = sg.layers.get(layer);
    if (!lo) {
      lo = { staticV: new Map(), dynamicV: new Map() };
      sg.layers.set(layer, lo);
    }
    return lo;
  }

  private variant(lo: LayerObjs, alpha: number, dynamic: boolean): VariantObjs {
    const map = dynamic ? lo.dynamicV : lo.staticV;
    let v = map.get(alpha);
    if (!v) { v = { lines: null, tris: null }; map.set(alpha, v); }
    return v;
  }
}

// ---------- 主题重映射 ----------
function recolorLines(ls: THREE.LineSegments | null, dark: boolean): void {
  if (!ls) return;
  const acis = ls.userData.segAci as Uint8Array | number[] | undefined;
  const col = ls.geometry.getAttribute('color') as THREE.BufferAttribute;
  if (!col || !acis) return;
  const arr = col.array as Float32Array;
  const target = dark ? [1, 1, 1] : [0, 0, 0];
  for (let s = 0; s < acis.length; s++) {
    if (!ADAPTIVE(Number(acis[s]))) continue;
    for (let vtx = 0; vtx < 2; vtx++) {
      const o = (s * 2 + vtx) * 3;
      arr[o] = target[0]; arr[o + 1] = target[1]; arr[o + 2] = target[2];
    }
  }
  col.needsUpdate = true;
}

function recolorTris(mesh: THREE.Mesh | null, dark: boolean): void {
  if (!mesh) return;
  const acis = mesh.userData.triAci as Uint8Array | number[] | undefined;
  const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  if (!col || !acis) return;
  const arr = col.array as Float32Array;
  const target = dark ? [1, 1, 1] : [0, 0, 0];
  for (let t = 0; t < acis.length; t++) {
    if (!ADAPTIVE(Number(acis[t]))) continue;
    for (let vtx = 0; vtx < 3; vtx++) {
      const o = (t * 3 + vtx) * 3;
      arr[o] = target[0]; arr[o + 1] = target[1]; arr[o + 2] = target[2];
    }
  }
  col.needsUpdate = true;
}

// ---------- 几何辅助 ----------
function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
    else m?.dispose();
  });
}

function lineMaterial(alpha: number): THREE.LineBasicMaterial {
  const transparent = alpha < 255;
  return new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent,
    opacity: transparent ? alpha / 255 : 1,
    depthWrite: !transparent,
  });
}

function triMaterial(alpha: number): THREE.MeshBasicMaterial {
  const transparent = alpha < 255;
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent,
    opacity: transparent ? alpha / 255 : 1,
    depthWrite: !transparent,
  });
}

function makeLineSegments(segs: number[], ids: number[], acis: number[], alpha: number): THREE.LineSegments {
  const pos: number[] = [], col: number[] = [];
  for (let i = 0; i < segs.length; i += 5) {
    pos.push(segs[i], segs[i + 1], 0.1);
    col.push(segs[i + 2], segs[i + 3], segs[i + 4]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const ls = new THREE.LineSegments(geo, lineMaterial(alpha));
  ls.frustumCulled = false;
  ls.renderOrder = 10;
  ls.userData.segIds = ids;
  ls.userData.segAci = acis;
  return ls;
}

function makeTriMesh(tris: number[], ids: number[], acis: number[], alpha: number): THREE.Mesh {
  const pos: number[] = [], col: number[] = [];
  for (let i = 0; i < tris.length; i += 5) {
    pos.push(tris[i], tris[i + 1], 0.0);
    col.push(tris[i + 2], tris[i + 3], tris[i + 4]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, triMaterial(alpha));
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.userData.triIds = ids;
  mesh.userData.triAci = acis;
  return mesh;
}

function appendLines(existing: THREE.LineSegments | null, segs: number[], ids: number[], acis: number[], alpha: number): THREE.LineSegments {
  if (!existing) return makeLineSegments(segs, ids, acis, alpha);
  const oldPos = existing.geometry.getAttribute('position') as THREE.BufferAttribute;
  const oldCol = existing.geometry.getAttribute('color') as THREE.BufferAttribute;
  const pos: number[] = [], col: number[] = [];
  for (let i = 0; i < segs.length; i += 5) {
    pos.push(segs[i], segs[i + 1], 0.1);
    col.push(segs[i + 2], segs[i + 3], segs[i + 4]);
  }
  const newCount = oldPos.count + pos.length / 3;
  const np = new Float32Array(newCount * 3);
  np.set(oldPos.array as Float32Array, 0);
  np.set(pos, oldPos.count * 3);
  const nc = new Float32Array(newCount * 3);
  nc.set(oldCol.array as Float32Array, 0);
  nc.set(col, oldCol.count * 3);
  existing.geometry.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(np, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(nc, 3));
  existing.geometry = geo;
  existing.userData.segIds = (existing.userData.segIds as number[]).concat(ids);
  existing.userData.segAci = (existing.userData.segAci as number[]).concat(acis);
  return existing;
}

function appendTris(existing: THREE.Mesh | null, tris: number[], ids: number[], acis: number[], alpha: number): THREE.Mesh {
  if (!existing) return makeTriMesh(tris, ids, acis, alpha);
  const oldPos = existing.geometry.getAttribute('position') as THREE.BufferAttribute;
  const oldCol = existing.geometry.getAttribute('color') as THREE.BufferAttribute;
  const pos: number[] = [], col: number[] = [];
  for (let i = 0; i < tris.length; i += 5) {
    pos.push(tris[i], tris[i + 1], 0.0);
    col.push(tris[i + 2], tris[i + 3], tris[i + 4]);
  }
  const newCount = oldPos.count + pos.length / 3;
  const np = new Float32Array(newCount * 3);
  np.set(oldPos.array as Float32Array, 0);
  np.set(pos, oldPos.count * 3);
  const nc = new Float32Array(newCount * 3);
  nc.set(oldCol.array as Float32Array, 0);
  nc.set(col, oldCol.count * 3);
  existing.geometry.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(np, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(nc, 3));
  existing.geometry = geo;
  existing.userData.triIds = (existing.userData.triIds as number[]).concat(ids);
  existing.userData.triAci = (existing.userData.triAci as number[]).concat(acis);
  return existing;
}

function filterLines(ls: THREE.LineSegments, removed: Set<number>): { geo: THREE.BufferGeometry | null; ids: number[]; acis: number[] } {
  const ids = ls.userData.segIds as number[];
  const acisIn = (ls.userData.segAci ?? []) as number[];
  const pos = ls.geometry.getAttribute('position') as THREE.BufferAttribute;
  const col = ls.geometry.getAttribute('color') as THREE.BufferAttribute;
  const keep: number[] = [];
  let anyRemoved = false;
  for (let i = 0; i < ids.length; i++) {
    if (removed.has(ids[i])) { anyRemoved = true; continue; }
    keep.push(i);
  }
  if (!anyRemoved) return { geo: ls.geometry, ids, acis: acisIn };
  const newPos = new Float32Array(keep.length * 6);
  const newCol = new Float32Array(keep.length * 6);
  const newIds: number[] = [];
  const newAcis: number[] = [];
  for (let k = 0; k < keep.length; k++) {
    const s = keep[k];
    for (let v = 0; v < 2; v++) {
      const src = (s * 2 + v) * 3;
      newPos[k * 6 + v * 3] = pos.array[src] as number;
      newPos[k * 6 + v * 3 + 1] = pos.array[src + 1] as number;
      newPos[k * 6 + v * 3 + 2] = pos.array[src + 2] as number;
      newCol[k * 6 + v * 3] = col.array[src] as number;
      newCol[k * 6 + v * 3 + 1] = col.array[src + 1] as number;
      newCol[k * 6 + v * 3 + 2] = col.array[src + 2] as number;
    }
    newIds.push(ids[s]);
    if (acisIn.length > 0) newAcis.push(acisIn[s]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(newCol, 3));
  return { geo, ids: newIds, acis: newAcis };
}

function filterTris(mesh: THREE.Mesh, removed: Set<number>): { geo: THREE.BufferGeometry | null; ids: number[]; acis: number[] } {
  const ids = mesh.userData.triIds as number[];
  const acisIn = (mesh.userData.triAci ?? []) as number[];
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  const keep: number[] = [];
  let anyRemoved = false;
  for (let i = 0; i < ids.length; i++) {
    if (removed.has(ids[i])) { anyRemoved = true; continue; }
    keep.push(i);
  }
  if (!anyRemoved) return { geo: mesh.geometry, ids, acis: acisIn };
  const newPos = new Float32Array(keep.length * 9);
  const newCol = new Float32Array(keep.length * 9);
  const newIds: number[] = [];
  const newAcis: number[] = [];
  for (let k = 0; k < keep.length; k++) {
    const s = keep[k];
    for (let v = 0; v < 3; v++) {
      const src = (s * 3 + v) * 3;
      newPos[k * 9 + v * 3] = pos.array[src] as number;
      newPos[k * 9 + v * 3 + 1] = pos.array[src + 1] as number;
      newPos[k * 9 + v * 3 + 2] = pos.array[src + 2] as number;
      newCol[k * 9 + v * 3] = col.array[src] as number;
      newCol[k * 9 + v * 3 + 1] = col.array[src + 1] as number;
      newCol[k * 9 + v * 3 + 2] = col.array[src + 2] as number;
    }
    newIds.push(ids[s]);
    if (acisIn.length > 0) newAcis.push(acisIn[s]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(newCol, 3));
  return { geo, ids: newIds, acis: newAcis };
}

// ---------- 编辑实体的重烘焙 (主线程) ----------
export const dynamicRenderCache = {
  blocks: null as BlocksMap | null,
  dev: 0.1,
  tessRecordForRender(sink: ExpandSink, rec: EntRecord): void {
    const rgb = rec.color;
    const aci = rec.aci ?? 7;
    switch (rec.type) {
      case 'LINE': {
        pushSegs(sink, rec.d as number[], rec.id, rgb, false, aci);
        break;
      }
      case 'CIRCLE': {
        const [cx, cy, r] = rec.d as [number, number, number];
        const pts: number[] = [];
        arcPoints(cx, cy, r, 0, Math.PI * 2, dynamicRenderCache.dev, pts);
        pushSegs(sink, pts, rec.id, rgb, true, aci);
        break;
      }
      case 'ARC': {
        const [cx, cy, r, a0, a1] = rec.d as [number, number, number, number, number];
        const pts: number[] = [];
        arcPoints(cx, cy, r, a0, a1, dynamicRenderCache.dev, pts);
        pushSegs(sink, pts, rec.id, rgb, false, aci);
        break;
      }
      case 'ELLIPSE': {
        const [cx, cy, mx, my, ratio, a0, a1] = rec.d as [number, number, number, number, number, number, number];
        const pts: number[] = [];
        ellipsePoints(cx, cy, mx, my, ratio, a0, a1, dynamicRenderCache.dev, pts);
        pushSegs(sink, pts, rec.id, rgb, false, aci);
        break;
      }
      case 'PLINE': {
        const pl = rec.d as { v: Float32Array; b?: Float32Array; closed: boolean };
        const pts: number[] = [];
        polylinePoints(pl.v, pl.b ?? null, pl.closed, dynamicRenderCache.dev, pts);
        pushSegs(sink, pts, rec.id, rgb, pl.closed, aci);
        break;
      }
      case 'HATCH': {
        const hd = rec.d as { loops: Float32Array[]; solid: boolean };
        const t = triangulateLoops(hd.loops);
        if (t) pushTris(sink, t, rec.id, rgb, aci);
        for (const loop of hd.loops) {
          pushSegs(sink, Array.from(loop), rec.id, rgb, true, aci);
        }
        break;
      }
      case 'SOLID': {
        const v = (rec.d as { v: Float32Array }).v;
        pushTris(sink, Array.from(v), rec.id, rgb, aci);
        break;
      }
      case 'INSERT': {
        const blocks = dynamicRenderCache.blocks;
        if (!blocks) break;
        const d = rec.d as { name: string; x: number; y: number; sx: number; sy: number; rot: number };
        const def = blocks.get(d.name);
        if (!def) break;
        const tmpSink: ExpandSink = { segs: [], segIds: [], segAci: [], tris: [], triIds: [], triAci: [], records: [] };
        expandInsertInto(tmpSink, def, blocks, d.x, d.y, d.sx, d.sy, (d.rot * Math.PI) / 180, rgb,
          dynamicRenderCache.dev, 0, new Set([d.name]), rec.id, undefined, aci, rec.alpha ?? 255);
        for (let i = 0; i < tmpSink.segs.length; i += 5) {
          sink.segs.push(tmpSink.segs[i], tmpSink.segs[i + 1], tmpSink.segs[i + 2], tmpSink.segs[i + 3], tmpSink.segs[i + 4]);
          sink.segIds.push(rec.id);
          sink.segAci.push(tmpSink.segAci[i / 10] ?? aci);
        }
        for (let i = 0; i < tmpSink.tris.length; i += 5) {
          sink.tris.push(tmpSink.tris[i], tmpSink.tris[i + 1], tmpSink.tris[i + 2], tmpSink.tris[i + 3], tmpSink.tris[i + 4]);
          sink.triIds.push(rec.id);
          sink.triAci.push(tmpSink.triAci[i / 15] ?? aci);
        }
        break;
      }
      case 'POINT': {
        const [x, y] = rec.d as [number, number];
        const s = dynamicRenderCache.dev * 3;
        pushSegs(sink, [x - s, y, x + s, y, x, y - s, x, y + s], rec.id, rgb, false, aci);
        break;
      }
      default:
        break;
    }
  },
};
