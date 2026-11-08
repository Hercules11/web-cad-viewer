/** 框选区域 → SVG 导出 (矢量, 世界坐标 → y 翻转) */
import type { Doc, Rect } from '../app/document';
import type { EntRecord } from '../core/types';

export interface SvgExportOpts {
  decimals: number;
  includeInvisible: boolean;
  background: 'white' | 'transparent';
  /** 图案填充: true=半透明填充, false=仅边界 */
  patternFill: boolean;
}

export interface SvgExportResult {
  svg: string;
  count: number;
  bytes: number;
}

export function exportSvg(doc: Doc, space: number, rect: Rect, opts: SvgExportOpts): SvgExportResult {
  const dec = Math.max(0, Math.min(6, opts.decimals));
  const f = (n: number): string => {
    const v = +n.toFixed(dec);
    return Object.is(v, -0) ? '0' : String(v);
  };

  // 收集实体
  let recs: EntRecord[];
  if (opts.includeInvisible) {
    const all: EntRecord[] = [];
    // 直接全量扫描 (忽略图层可见性)
    const sd = doc.spaceData[space];
    if (sd) {
      for (const rec of sd.arr) if (rectsI(rec.bb, rect)) all.push(rec);
      for (const rec of sd.texts) if (doc.records.get(rec.id) === rec && rectsI(rec.bb, rect)) all.push(rec);
      for (const rec of sd.dynamic) if (doc.records.get(rec.id) === rec && rectsI(rec.bb, rect)) all.push(rec);
    }
    recs = all;
  } else {
    recs = doc.queryRect(space, rect);
  }

  // 引用的块 (含嵌套)
  const usedBlocks = new Set<string>();
  const collectBlocks = (recs: EntRecord[]) => {
    for (const rec of recs) {
      if (rec.type !== 'INSERT') continue;
      const name = (rec.d as { name: string }).name;
      if (usedBlocks.has(name)) continue;
      usedBlocks.add(name);
      const def = doc.blocks.get(name);
      if (def) collectBlocks(def.records);
    }
  };
  collectBlocks(recs);

  const parts: string[] = [];
  const w = rect.x2 - rect.x1;
  const h = rect.y2 - rect.y1;
  // 视图像素尺寸 (保持长宽, 最长边 2400px)
  const maxPx = 2400;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const outW = +(w * scale).toFixed(2);
  const outH = +(h * scale).toFixed(2);

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${outW}" height="${outH}" viewBox="${f(rect.x1)} ${f(-rect.y2)} ${f(w)} ${f(h)}">`,
  );
  parts.push(`<!-- Exported by Web CAD Viewer | region [${f(rect.x1)}, ${f(rect.y1)}) - [${f(rect.x2)}, ${f(rect.y2)}] | entities: ${recs.length} -->`);
  if (opts.background === 'white') {
    parts.push(`<rect x="${f(rect.x1)}" y="${f(-rect.y2)}" width="${f(w)}" height="${f(h)}" fill="#ffffff"/>`);
  }

  parts.push(`<g transform="scale(1,-1)" stroke-linecap="round" stroke-linejoin="round">`);

  let count = 0;
  const body: string[] = [];
  const emitEntity = (rec: EntRecord, out: string[], isDef: boolean): void => {
    if (!isDef && !opts.includeInvisible && !doc.layerVisible[rec.layer]) return;
    const rgb = remapColor(rec.color);
    const col = hex(rgb);
    const opRaw = (rec.alpha ?? 255) / 255;
    const d = rec.d as never;
    if (opRaw < 1) out.push(`<g opacity="${opRaw.toFixed(3)}">`);
    switch (rec.type) {
      case 'LINE': {
        const [x1, y1, x2, y2] = d as number[];
        out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        count++;
        break;
      }
      case 'CIRCLE': {
        const [cx, cy, r] = d as [number, number, number];
        out.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        count++;
        break;
      }
      case 'ARC': {
        const [cx, cy, r, a0, a1] = d as [number, number, number, number, number];
        out.push(`<path d="${arcPath(cx, cy, r, a0, a1, f)}" fill="none" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        count++;
        break;
      }
      case 'ELLIPSE': {
        const [cx, cy, mx, my, ratio, a0, a1] = d as [number, number, number, number, number, number, number];
        const mj = Math.hypot(mx, my);
        const full = Math.abs((a1 ?? Math.PI * 2) - (a0 ?? 0)) >= Math.PI * 2 - 1e-6;
        if (full) {
          const deg = +(Math.atan2(my, mx) * 180 / Math.PI).toFixed(3);
          out.push(`<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(mj)}" ry="${f(mj * ratio)}" transform="rotate(${deg} ${f(cx)} ${f(cy)})" fill="none" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        } else {
          // 椭圆弧: 离散为折线路径 (v1)
          const pts = ellipseFlatten(cx, cy, mx, my, ratio, a0, a1);
          out.push(`<path d="${polyPath(pts, f)}" fill="none" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        }
        count++;
        break;
      }
      case 'PLINE': {
        const pl = d as { v: Float32Array; b?: Float32Array; closed: boolean; spline?: boolean };
        out.push(`<path d="${plinePath(pl, f)}" fill="none" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        count++;
        break;
      }
      case 'HATCH': {
        const hd = d as { loops: Float32Array[]; solid: boolean; pattern: string };
        let dstr = '';
        for (const loop of hd.loops) {
          dstr += loopPath(loop, f);
        }
        if (hd.solid || opts.patternFill) {
          const op = hd.solid ? 1 : 0.25;
          out.push(`<path d="${dstr}" fill="${col}" fill-opacity="${op}" fill-rule="evenodd" stroke="none"/>`);
        } else {
          out.push(`<path d="${dstr}" fill="none" stroke="${col}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`);
        }
        count++;
        break;
      }
      case 'SOLID': {
        const v = (d as { v: Float32Array }).v;
        let dstr = `M ${f(v[0])} ${f(v[1])}`;
        for (let i = 2; i < v.length; i += 2) dstr += ` L ${f(v[i])} ${f(v[i + 1])}`;
        dstr += ' Z';
        out.push(`<path d="${dstr}" fill="${col}" stroke="none"/>`);
        count++;
        break;
      }
      case 'TEXT': {
        const td = d as { x: number; y: number; h: number; rot: number; text: string; ha?: number };
        const anchor = td.ha === 1 ? 'middle' : td.ha === 2 ? 'end' : 'start';
        const txt = escXml(td.text);
        out.push(`<text transform="translate(${f(td.x)} ${f(td.y)}) scale(1,-1) rotate(${f(-td.rot)})" font-size="${f(td.h)}" font-family="${FONT_FAMILY}" fill="${col}" text-anchor="${anchor}">${txt}</text>`);
        count++;
        break;
      }
      case 'MTEXT': {
        const md = d as { x: number; y: number; h: number; rot: number; text: string; attach?: number };
        const lines = md.text.split('\n');
        const attach = md.attach ?? 1;
        const row = Math.floor((attach - 1) / 3);
        const colA = (attach - 1) % 3;
        const lineStep = md.h * 1.66;
        const totalH = lines.length * lineStep;
        const blockTop = row === 0 ? md.y : row === 1 ? md.y + totalH / 2 : md.y + totalH;
        const rot = -md.rot;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const baseY = blockTop - i * lineStep - md.h;
          const anchor = colA === 0 ? 'start' : colA === 1 ? 'middle' : 'end';
          const lx = colA === 0 ? md.x : colA === 1 ? md.x : md.x; // 锚点均为插入点, 用 text-anchor 对齐
          out.push(`<text transform="translate(${f(lx)} ${f(baseY)}) scale(1,-1) rotate(${f(rot)})" font-size="${f(md.h)}" font-family="${FONT_FAMILY}" fill="${col}" text-anchor="${anchor}">${escXml(lines[i])}</text>`);
        }
        count++;
        break;
      }
      case 'INSERT': {
        const id = d as { name: string; x: number; y: number; sx: number; sy: number; rot: number };
        const tr = `translate(${f(id.x)} ${f(id.y)}) rotate(${f(id.rot)}) scale(${f(id.sx)} ${f(id.sy)})`;
        out.push(`<use xlink:href="#${escId(id.name)}" href="#${escId(id.name)}" transform="${tr}"/>`);
        count++;
        break;
      }
      case 'POINT': {
        const [px, py] = d as [number, number];
        out.push(`<circle cx="${f(px)}" cy="${f(py)}" r="0.5" fill="${col}"/>`);
        count++;
        break;
      }
      default:
        break;
    }
    if (opRaw < 1) out.push('</g>');
  };

  // 块定义 <defs> (放在翻转组内合法: defs 不直接渲染)
  if (usedBlocks.size > 0) {
    const defParts: string[] = ['<defs>'];
    const emitted = new Set<string>();
    const emitBlock = (name: string, depth: number): void => {
      if (emitted.has(name) || depth > 8) return;
      emitted.add(name);
      const def = doc.blocks.get(name);
      if (!def) return;
      // 先发嵌套块
      for (const rec of def.records) {
        if (rec.type === 'INSERT') emitBlock((rec.d as { name: string }).name, depth + 1);
      }
      const blkBody: string[] = [];
      for (const rec of def.records) {
        emitEntity(rec, blkBody, true);
      }
      defParts.push(`<g id="${escId(name)}">${blkBody.join('')}</g>`);
    };
    for (const name of usedBlocks) emitBlock(name, 0);
    defParts.push('</defs>');
    parts.push(defParts.join(''));
  }

  for (const rec of recs) emitEntity(rec, body, false);
  parts.push(body.join(''));
  parts.push('</g>');
  parts.push('</svg>');

  const svg = parts.join('\n');
  return { svg, count, bytes: new Blob([svg]).size };
}

const FONT_FAMILY = "SimSun,NSimSun,'Microsoft YaHei','PingFang SC',Arial,sans-serif";

function remapColor(rgb: number): number {
  // 深色主题烘焙: ACI 7 = 白 → 导出白底时转黑
  if (rgb === 0xffffff) return 0x000000;
  return rgb;
}

function hex(rgb: number): string {
  return '#' + rgb.toString(16).padStart(6, '0');
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escId(name: string): string {
  return 'blk_' + name.replace(/[^A-Za-z0-9_-]/g, '_') + '_' + Math.abs(hashStr(name));
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function rectsI(a: { x1: number; y1: number; x2: number; y2: number }, b: Rect): boolean {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
}

/** 圆弧路径 (世界坐标, 供翻转组内使用) */
function arcPath(
  cx: number, cy: number, r: number, a0: number, a1: number,
  f: (n: number) => string,
): string {
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
  const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1);
  const large = sweep > Math.PI ? 1 : 0;
  // 根组 y 翻转: CAD 逆时针 → svg sweep=0
  return `M ${f(sx)} ${f(sy)} A ${f(r)} ${f(r)} 0 ${large} 0 ${f(ex)} ${f(ey)}`;
}

/** 椭圆弧离散 */
function ellipseFlatten(
  cx: number, cy: number, mx: number, my: number, ratio: number, a0: number, a1: number,
): number[] {
  const mj = Math.hypot(mx, my);
  const mn = mj * ratio;
  const ca = mx / (mj || 1), sa = my / (mj || 1);
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += Math.PI * 2;
  const n = Math.max(16, Math.min(512, Math.ceil((sweep / (Math.PI * 2)) * 256)));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    const u = mj * Math.cos(t), v = mn * Math.sin(t);
    out.push(cx + u * ca - v * sa, cy + u * sa + v * ca);
  }
  return out;
}

function polyPath(pts: number[], f: (n: number) => string): string {
  if (pts.length < 4) return '';
  let s = `M ${f(pts[0])} ${f(pts[1])}`;
  for (let i = 2; i < pts.length; i += 2) s += ` L ${f(pts[i])} ${f(pts[i + 1])}`;
  return s;
}

function loopPath(loop: Float32Array, f: (n: number) => string): string {
  if (loop.length < 6) return '';
  let s = `M ${f(loop[0])} ${f(loop[1])}`;
  for (let i = 2; i < loop.length; i += 2) s += ` L ${f(loop[i])} ${f(loop[i + 1])}`;
  return s + ' Z';
}

/** 带 bulge 的多段线路径 */
function plinePath(
  pl: { v: Float32Array; b?: Float32Array; closed: boolean },
  f: (n: number) => string,
): string {
  const v = pl.v;
  const n = v.length / 2;
  if (n === 0) return '';
  const segs = pl.closed ? n : n - 1;
  let s = `M ${f(v[0])} ${f(v[1])}`;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const x1 = v[i * 2], y1 = v[i * 2 + 1];
    const x2 = v[j * 2], y2 = v[j * 2 + 1];
    const b = pl.b ? pl.b[i] : 0;
    if (Math.abs(b) > 1e-9) {
      // bulge → 圆弧
      const th = 4 * Math.atan(b);
      const chord = Math.hypot(x2 - x1, y2 - y1);
      if (chord > 1e-12) {
        const half = chord / 2;
        const r = half / Math.abs(Math.sin(th / 2));
        const large = Math.abs(th) > Math.PI ? 1 : 0;
        const sweep = b > 0 ? 0 : 1; // CAD 逆时针 → svg sweep 0 (翻转组内)
        s += ` A ${f(r)} ${f(r)} 0 ${large} ${sweep} ${f(x2)} ${f(y2)}`;
        continue;
      }
    }
    s += ` L ${f(x2)} ${f(y2)}`;
  }
  if (pl.closed) s += ' Z';
  return s;
}
