/** 文字渲染: canvas 图集 + 世界坐标四边形, 按 (空间 × 图层) 分组便于显隐/主题切换 */
import * as THREE from 'three';
import type { EntRecord } from '../core/types';
import { themeAdaptiveRgb } from '../core/aci';

const ATLAS_SIZE = 2048;
const FONT_PX = 56;
const PAD = 2;

const FONT_STACK = "'SimSun','NSimSun','Microsoft YaHei','PingFang SC',Arial,sans-serif";

interface Job {
  rec: EntRecord;
}

interface Atlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  x: number;
  y: number;
  rowH: number;
}

interface MeshGroup {
  atlas: Atlas;
  space: number;
  layer: number;
  pos: number[];
  uv: number[];
  col: number[];
  idx: number[];
  mesh: THREE.Mesh | null;
}

export class TextManager {
  private queue: Job[] = [];
  private atlases: Atlas[] = [];
  private groups = new Map<string, MeshGroup>();
  private roots: THREE.Group[] = [];
  private dark = true;
  /** 主题切换/重建用: 记录已登记的记录 */
  private known: Map<number, EntRecord> = new Map();

  constructor() {
    this.ensureRoot(0);
  }

  private ensureRoot(space: number): THREE.Group {
    while (this.roots.length <= space) {
      const g = new THREE.Group();
      g.visible = this.roots.length === 0;
      g.renderOrder = 20;
      this.roots.push(g);
      this.holder.add(g);
    }
    return this.roots[space];
  }

  get object3d(): THREE.Object3D {
    // 容器: 把所有空间 root 挂在一个 holder 上
    return this.holder;
  }

  private holder: THREE.Group = (() => {
    const h = new THREE.Group();
    h.renderOrder = 20;
    return h;
  })();

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    this.known.clear();
    this.clearMeshes();
    for (const a of this.atlases) a.texture.dispose();
    this.atlases = [];
  }

  private clearMeshes(): void {
    for (const g of this.groups.values()) {
      if (g.mesh) {
        g.mesh.geometry.dispose();
        this.roots[g.space]?.remove(g.mesh);
      }
    }
    this.groups.clear();
  }

  addRecord(rec: EntRecord): void {
    if (rec.type !== 'TEXT' && rec.type !== 'MTEXT') return;
    this.known.set(rec.id, rec);
    this.queue.push({ rec });
    this.ensureRoot(rec.sp ?? 0);
  }

  /** 主题切换: 重着色全部文字 (传入当前有效的文字记录集合) */
  setTheme(dark: boolean, records: EntRecord[]): void {
    this.dark = dark;
    this.clearMeshes();
    this.known.clear();
    for (const rec of records) {
      this.known.set(rec.id, rec);
      this.ensureRoot(rec.sp ?? 0);
    }
    // 重新入队 (直接加入 groups)
    for (const rec of records) {
      this.processJob({ rec });
    }
    this.rebuildAllGroups();
  }

  setSpaceVisible(active: number): void {
    this.roots.forEach((r, i) => {
      r.visible = i === active;
    });
  }

  setLayerVisible(layer: number, visible: boolean): void {
    for (const g of this.groups.values()) {
      if (g.layer === layer && g.mesh) g.mesh.visible = visible;
    }
  }

  /** 重建某层的全部文字 (编辑后调用) */
  rebuildLayer(layer: number, records: EntRecord[]): void {
    for (const [key, g] of this.groups) {
      if (g.layer === layer) {
        if (g.mesh) {
          g.mesh.geometry.dispose();
          this.roots[g.space]?.remove(g.mesh);
        }
        this.groups.delete(key);
      }
    }
    for (const rec of records) {
      if (rec.type === 'TEXT' || rec.type === 'MTEXT') {
        this.known.set(rec.id, rec);
        this.processJob({ rec });
      }
    }
    this.rebuildAllGroups();
  }

  /** 处理队列, 返回是否全部完成 */
  flush(maxItems = 600): boolean {
    let n = 0;
    while (this.queue.length > 0 && n < maxItems) {
      const job = this.queue.shift()!;
      this.processJob(job);
      n++;
    }
    this.rebuildAllGroups();
    this.onProgress?.(this.queue.length);
    return this.queue.length === 0;
  }

  onProgress: ((remaining: number) => void) | null = null;

  private measure(text: string, wf: number): Measured {
    const c = this.scratchCtx();
    c.font = `${FONT_PX}px ${FONT_STACK}`;
    const m = c.measureText(text);
    const ascent = (m as TextMetrics).actualBoundingBoxAscent ?? FONT_PX * 0.72;
    const descent = (m as TextMetrics).actualBoundingBoxDescent ?? FONT_PX * 0.2;
    return { w: m.width * wf, ascent, descent };
  }

  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx(): CanvasRenderingContext2D {
    if (!this.scratch) {
      this.scratch = document.createElement('canvas');
      this.scratch.width = 10;
      this.scratch.height = 10;
    }
    return this.scratch.getContext('2d')!;
  }

  private newAtlas(): Atlas {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${FONT_PX}px ${FONT_STACK}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const texture = new THREE.CanvasTexture(canvas);
    // 关闭 mipmap: 避免 canvas 透明底在低级 mip 中稀释字形 (缩小时文字渐隐消失的经典问题)
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const a: Atlas = { canvas, ctx, texture, x: 0, y: 0, rowH: 0 };
    this.atlases.push(a);
    return a;
  }

  private pack(meas: Measured): { atlas: Atlas; px: number; py: number } {
    const w = Math.ceil(meas.w) + PAD * 2;
    const h = Math.ceil(meas.ascent + meas.descent) + PAD * 2;
    let atlas = this.atlases[this.atlases.length - 1];
    if (!atlas) atlas = this.newAtlas();
    if (atlas.x + w > ATLAS_SIZE) {
      atlas.y += atlas.rowH + PAD;
      atlas.x = 0;
      atlas.rowH = 0;
    }
    if (atlas.y + h > ATLAS_SIZE) {
      atlas = this.newAtlas();
    }
    const px = atlas.x + PAD;
    const py = atlas.y + PAD;
    atlas.x += w;
    if (h > atlas.rowH) atlas.rowH = h;
    return { atlas, px, py };
  }

  private renderGlyph(atlas: Atlas, text: string, wf: number, px: number, py: number, meas: Measured): void {
    const ctx = atlas.ctx;
    ctx.save();
    ctx.font = `${FONT_PX}px ${FONT_STACK}`;
    // 字形边缘加粗 1px (stroke), 弥补线性采样在缩小时的边缘稀释
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    if (wf !== 1) {
      ctx.scale(wf, 1);
      ctx.strokeText(text, px / wf, py + meas.ascent);
      ctx.fillText(text, px / wf, py + meas.ascent);
    } else {
      ctx.strokeText(text, px, py + meas.ascent);
      ctx.fillText(text, px, py + meas.ascent);
    }
    ctx.restore();
    atlas.texture.needsUpdate = true;
  }

  private group(atlas: Atlas, space: number, layer: number): MeshGroup {
    const key = `${this.atlases.indexOf(atlas)}:${space}:${layer}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { atlas, space, layer, pos: [], uv: [], col: [], idx: [], mesh: null };
      this.groups.set(key, g);
    }
    return g;
  }

  private recColor(rec: EntRecord): number {
    const aci = rec.aci;
    if (aci === 7 || aci === 0) return themeAdaptiveRgb(this.dark);
    return rec.color;
  }

  private processJob(job: Job): void {
    const rec = job.rec;
    const d = rec.d as {
      x: number; y: number; h: number; rot: number; text: string;
      ha?: number; va?: number; attach?: number; wf?: number;
    };
    const rotRad = (d.rot * Math.PI) / 180;
    const cosr = Math.cos(rotRad), sinr = Math.sin(rotRad);
    const wf = d.wf && d.wf > 0.05 ? d.wf : 1;
    const isMText = rec.type === 'MTEXT';
    const lines = isMText ? d.text.split('\n') : [d.text];
    const lineStep = d.h * 1.66;
    const attach = d.attach ?? 1;
    const row = isMText ? Math.floor((attach - 1) / 3) : 1;
    const colA = isMText ? (attach - 1) % 3 : (d.ha === 1 ? 1 : d.ha === 2 ? 2 : 0);
    const tint = this.recColor(rec);

    let minBx = Infinity, minBy = Infinity, maxBx = -Infinity, maxBy = -Infinity;

    const totalH = lines.length * lineStep;
    const blockTop = row === 0 ? d.y : row === 1 ? d.y + totalH / 2 : d.y + totalH;

    for (let li = 0; li < lines.length; li++) {
      const text = lines[li];
      if (!text.trim()) continue;
      const meas = this.measure(text, wf);
      if (meas.w < 0.5) continue;
      const packed = this.pack(meas);
      this.renderGlyph(packed.atlas, text, wf, packed.px, packed.py, meas);

      const scale = d.h / meas.ascent;
      const wWorld = meas.w * scale;

      let baseX: number, baseY: number;
      if (isMText) {
        const lineTop = blockTop - li * lineStep;
        baseY = lineTop - d.h;
        baseX = colA === 0 ? d.x : colA === 1 ? d.x - wWorld / 2 : d.x - wWorld;
      } else {
        baseX = colA === 0 ? d.x : colA === 1 ? d.x - wWorld / 2 : d.x - wWorld;
        const va = d.va ?? 0;
        const dh = meas.ascent + meas.descent;
        const dy = va === 0 ? 0 : va === 1 ? meas.descent * scale : va === 2 ? (meas.ascent - dh / 2) * scale : (meas.ascent - dh) * scale;
        baseY = d.y + dy;
      }

      const l = 0, r = wWorld;
      const t = meas.ascent * scale, b = -meas.descent * scale;
      const corners: [number, number][] = [
        [l, b], [r, b], [r, t], [l, t],
      ];

      const space = rec.sp ?? 0;
      this.ensureRoot(space);
      const g = this.group(packed.atlas, space, rec.layer);
      const u0 = packed.px / ATLAS_SIZE;
      const v1 = 1 - packed.py / ATLAS_SIZE;
      const u1 = (packed.px + meas.w) / ATLAS_SIZE;
      const v0 = 1 - (packed.py + meas.ascent + meas.descent) / ATLAS_SIZE;
      const uvs: [number, number][] = [
        [u0, v0], [u1, v0], [u1, v1], [u0, v1],
      ];

      const base = g.pos.length / 3;
      const cr = ((tint >> 16) & 255) / 255;
      const cg = ((tint >> 8) & 255) / 255;
      const cb = (tint & 255) / 255;
      for (let i = 0; i < 4; i++) {
        const [lx, ly] = corners[i];
        const wx = baseX + lx * cosr - ly * sinr;
        const wy = baseY + lx * sinr + ly * cosr;
        g.pos.push(wx, wy, 0.15);
        g.uv.push(uvs[i][0], uvs[i][1]);
        g.col.push(cr, cg, cb);
        if (wx < minBx) minBx = wx;
        if (wy < minBy) minBy = wy;
        if (wx > maxBx) maxBx = wx;
        if (wy > maxBy) maxBy = wy;
      }
      g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    if (isFinite(minBx) && (rec.type === 'TEXT' || rec.type === 'MTEXT')) {
      rec.bb.x1 = minBx; rec.bb.y1 = minBy;
      rec.bb.x2 = maxBx; rec.bb.y2 = maxBy;
    }
  }

  private rebuildAllGroups(): void {
    for (const g of this.groups.values()) {
      this.rebuildGroup(g);
    }
  }

  private rebuildGroup(g: MeshGroup): void {
    if (g.mesh) {
      g.mesh.geometry.dispose();
      this.roots[g.space]?.remove(g.mesh);
      g.mesh = null;
    }
    if (g.pos.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
    geo.setIndex(g.idx);
    const mat = new THREE.MeshBasicMaterial({
      map: g.atlas.texture,
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    g.mesh = mesh;
    this.ensureRoot(g.space);
    this.roots[g.space].add(mesh);
    // 尊重图层可见性
    g.mesh.visible = true;
  }
}

interface Measured {
  w: number;
  ascent: number;
  descent: number;
}
