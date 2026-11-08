/** 应用主入口: 组装 doc/renderer/tools/ui, 驱动 worker 加载流程 */
import './style.css';
import { Doc } from './app/document';
import type { Rect } from './app/document';
import { Renderer, dynamicRenderCache } from './render/renderer';
import type { View } from './app/view';
import { Tools } from './app/tools';
import type { ToolId } from './app/tools';
import { UndoStack } from './app/commands';
import { exportSvg } from './export/svgExport';
import { aciToRgb, aciThemeRgb } from './core/aci';
import type { EntRecord } from './core/types';
import {
  buildLayersPanel, buildProgress, buildStatusBar, buildToolbar, showExportDialog, showTip,
} from './ui/ui';
import type { DrawMeta, WorkerOut } from './core/types';

const canvas = document.getElementById('cadCanvas') as HTMLCanvasElement;
const canvasWrap = document.getElementById('canvasWrap')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const marqueeTip = document.getElementById('marqueeTip')!;
const spaceTabs = document.getElementById('spaceTabs')!;

// ---------- 核心对象 ----------
const view: View = { cx: 0, cy: 0, scale: 1, w: 800, h: 600 };
const renderer = new Renderer(canvas);
renderer.start();
const undo = new UndoStack();

const doc = new Doc({
  onLayersChanged() { layers.render(); },
  onEditChanged(layersChanged) { handleEditChanged(layersChanged); },
});
dynamicRenderCache.blocks = doc.blocks;
dynamicRenderCache.dev = 0.1;

// ---------- UI ----------
const progress = buildProgress();
const status = buildStatusBar();

const tools = new Tools(canvas, view, doc, renderer, undo, {
  setToolButton: (id) => toolbar.setToolActive(id),
  showMarquee(rect, crossing) {
    let marquee = document.getElementById('marqueeRect') as HTMLDivElement | null;
    if (!rect) { marquee?.remove(); return; }
    if (!marquee) {
      marquee = document.createElement('div');
      marquee.id = 'marqueeRect';
      marquee.style.cssText = 'position:absolute;border:1px solid;pointer-events:none;z-index:30;';
      canvasWrap.appendChild(marquee);
    }
    marquee.style.borderStyle = 'dashed';
    marquee.style.borderColor = crossing ? '#ff8800' : '#00aaff';
    marquee.style.background = crossing ? 'rgba(255,136,0,0.06)' : 'rgba(0,170,255,0.06)';
    marquee.style.left = `${rect.x}px`;
    marquee.style.top = `${rect.y}px`;
    marquee.style.width = `${rect.w}px`;
    marquee.style.height = `${rect.h}px`;
  },
  onExportRect(rect) { openExportDialog(rect); },
  onCoords(x, y) { status.setCoords(x, y); },
  onStatus(text) { status.setStatus(text); },
  onSelectionChanged(count) {
    toolbar.setDeleteEnabled(count > 0);
    status.setInfo(count > 0 ? `已选 ${count}` : '');
  },
  onEditCommitted() {
    toolbar.setUndoRedo(undo.canUndo, undo.canRedo);
  },
});
tools.attachContextMenu();

const layers = buildLayersPanel(doc, (idx, visible) => {
  doc.layerVisible[idx] = visible;
  for (let s = 0; s < doc.spaceData.length; s++) {
    renderer.setLayerVisible(s, idx, visible);
  }
}, (idx) => {
  tools.setDrawLayer(idx);
  status.setStatus(`绘制图层: ${doc.layers[idx]?.name ?? idx}`);
});

const toolbar = buildToolbar({
  onOpen: () => fileInput.click(),
  onSample: () => openSample(),
  onTool: (id) => {
    tools.setTool(id);
    marqueeTip.classList.toggle('hidden', id !== 'export');
    if (id === 'export') tools.clearSelection();
  },
  onUndo: () => { undo.undo(); toolbar.setUndoRedo(undo.canUndo, undo.canRedo); },
  onRedo: () => { undo.redo(); toolbar.setUndoRedo(undo.canUndo, undo.canRedo); },
  onDelete: () => tools.deleteSelection(),
  onLayers: () => layers.toggle(),
  onFit: () => { tools.zoomToExtents(); },
  onExportSvg: () => {
    // 未选框选工具时提示
    tools.setTool('export');
    marqueeTip.classList.remove('hidden');
  },
  onExportPng: () => exportPng(),
  onSnapToggle: () => { /* 由 snap 按钮点击处理 */ },
  onToggleTheme: () => applyTheme(!themeDark),
});
toolbar.setUndoRedo(false, false);
toolbar.setDeleteEnabled(false);

// snap 开关
document.querySelector('[data-tool="snap"')?.addEventListener('click', () => {
  tools.snapEnabled = !tools.snapEnabled;
  toolbar.setSnap(tools.snapEnabled);
});

// ---------- 主题 ----------
let themeDark = localStorage.getItem('cad-theme') !== 'light';

function applyTheme(dark: boolean): void {
  themeDark = dark;
  localStorage.setItem('cad-theme', dark ? 'dark' : 'light');
  renderer.setTheme(dark);
  // 文字全部重着色
  const texts: EntRecord[] = [];
  for (const sd of doc.spaceData) {
    for (const r of sd.texts) {
      if (doc.records.get(r.id) === r) texts.push(r);
    }
  }
  renderer.textManager.setTheme(dark, texts);
  // 图层面板色块随主题
  for (const l of doc.layers) {
    l.rgb = aciThemeRgb(l.color, aciToRgb(l.color, dark), dark);
  }
  layers.render();
  toolbar.setThemeDark(dark);
  status.setStatus(dark ? '深色主题 (ACI 7 显示为白色)' : '浅色主题 (ACI 7 显示为黑色, 仿 TrueView)');
}
applyTheme(themeDark);

// ---------- 视图尺寸 ----------
function resize(): void {
  const r = canvas.getBoundingClientRect();
  view.w = r.width;
  view.h = r.height;
  renderer.resize();
  renderer.updateCamera(view, view.w, view.h);
}
window.addEventListener('resize', resize);
resize();

// ---------- Worker ----------
const worker = new Worker(new URL('./parse/parser.worker.ts', import.meta.url), { type: 'module' });
let loading = false;
let loadedCount = 0;

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'progress':
      progress.update(msg.pct, msg.phase);
      break;
    case 'meta':
      onMeta(msg.meta);
      break;
    case 'blockdefs':
      doc.addBlockDefs(msg.blocks);
      break;
    case 'batch':
      loadedCount += msg.records.length;
      doc.addBatch(msg.space, msg.records);
      renderer.addBatch(msg.space, msg.segs, msg.segIds, msg.segAci, msg.tris, msg.triIds, msg.triAci, msg.records);
      progress.update(75, `已加载 ${loadedCount} 实体…`);
      break;
    case 'done': {
      doc.finishLoad(msg.exts, msg.robustExts);
      progress.update(100, `完成: ${msg.entityCount} 实体${msg.skipped ? `, ${msg.skipped} 不支持已跳过` : ''}`);
      setTimeout(() => progress.hide(), 400);
      loading = false;
      // 重新应用图层可见性 (批数据在 meta 之后才到, meta 阶段的设置对后建对象无效)
      for (let s = 0; s < doc.spaceData.length; s++) {
        doc.layerVisible.forEach((vis, i) => renderer.setLayerVisible(s, i, vis));
      }
      tools.zoomToExtents();
      status.setStatus(`加载完成: ${msg.entityCount} 实体${msg.skipped ? `, 跳过 ${msg.skipped}` : ''} | 图层 ${doc.layers.length} | 块 ${doc.blocks.size}`);
      layers.render();
      // 缺失内容提示 (XREF 外部引用 / 不支持的实体类型)
      showUnsupportedReport(msg.unsupported);
      break;
    }
    case 'error':
      progress.error(msg.message);
      loading = false;
      break;
  }
};

function onMeta(meta: DrawMeta): void {
  doc.initMeta(meta);
  layers.render();
  buildSpaceTabs();
  // 应用初始图层可见性
  doc.layerVisible.forEach((vis, i) => {
    if (!vis) {
      for (let s = 0; s < doc.spaceData.length; s++) renderer.setLayerVisible(s, i, false);
    }
  });
}

/** 加载完成后的缺失内容报告: 外部引用 (XREF) + 不支持的实体类型 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showUnsupportedReport(u: { types: [string, number][]; missingRefs: { name: string; refs: number }[]; errorSamples?: [string, number][] }): void {
  const lines: string[] = [];
  const xrefs = u.missingRefs.filter((m) => m.name && !m.name.startsWith('*'));
  if (xrefs.length > 0) {
    const shown = xrefs.slice(0, 6).map((m) => `${m.name}${m.refs > 0 ? ` (引用 ${m.refs} 次)` : ''}`);
    lines.push(`<b>未加载的外部引用 (XREF) ${xrefs.length} 个</b>: ${shown.join('、')}${xrefs.length > 6 ? ' 等' : ''}`);
  }
  if (u.types.length > 0) {
    const total = u.types.reduce((s, [, n]) => s + n, 0);
    const shown = u.types.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t}×${n}`);
    lines.push(`<b>暂不支持已跳过的实体 ${total} 个</b>: ${shown.join('、')}${u.types.length > 5 ? ' 等' : ''}`);
    if (u.errorSamples && u.errorSamples.length > 0) {
      lines.push(`<span style="color:#b06">内部异常: ${esc(u.errorSamples[0][0])} ×${u.errorSamples[0][1]}</span>`);
    }
  }
  if (lines.length > 0) {
    showTip(`<div style="max-width:520px;text-align:left;line-height:1.7">${lines.join('<br>')}<br><span style="color:#888">以上内容已忽略, 不影响其余部分的查看与编辑。</span></div>`, 9000);
  }
}

function buildSpaceTabs(): void {
  spaceTabs.innerHTML = '';
  if (doc.spaces.length <= 1) { spaceTabs.classList.add('hidden'); return; }
  spaceTabs.classList.remove('hidden');
  doc.spaces.forEach((sp, i) => {
    const tab = document.createElement('div');
    tab.className = 'space-tab' + (i === doc.activeSpace ? ' active' : '');
    tab.textContent = sp.name;
    tab.addEventListener('click', () => {
      doc.activeSpace = i;
      renderer.setSpaceVisible(i);
      tools.setSpace(i);
      spaceTabs.querySelectorAll('.space-tab').forEach((t, j) => t.classList.toggle('active', j === i));
      tools.zoomToExtents();
    });
    spaceTabs.appendChild(tab);
  });
}

// ---------- 编辑响应 ----------
function handleEditChanged(layerIds: Iterable<number>): void {
  const space = doc.activeSpace;
  const sd = doc.spaceData[space];
  for (const layer of layerIds) {
    // 静态过滤 + 动态重建
    renderer.filterStatic(space, layer, sd.invalid);
    renderer.rebuildDynamic(space, layer, doc.dynamicRecords(space, layer));
    // 动态对象继承图层可见性
    renderer.setLayerVisible(space, layer, doc.layerVisible[layer]);
    // 文字重建
    const textRecs = sd.texts.filter((r) => r.layer === layer && doc.records.get(r.id) === r);
    renderer.textManager.rebuildLayer(layer, textRecs);
  }
  toolbar.setUndoRedo(undo.canUndo, undo.canRedo);
}

// ---------- 文件打开 ----------
async function openFile(file: File): Promise<void> {
  if (loading) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) {
    showTip('仅支持 .dwg / .dxf 文件');
    return;
  }
  loading = true;
  loadedCount = 0;
  progress.show(`正在打开 ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`);
  resetDoc();
  try {
    const buf = await file.arrayBuffer();
    // 相对页面 baseURI 解析, 兼容 GitHub Pages 子路径部署
    const wasmBase = new URL('wasm/', document.baseURI).href;
    worker.postMessage({ t: 'parse', buf, wasmBase }, [buf]);
  } catch (err) {
    progress.error(err instanceof Error ? err.message : String(err));
    loading = false;
  }
}

async function openSample(): Promise<void> {
  if (loading) return;
  loading = true;
  loadedCount = 0;
  progress.show('正在打开示例图纸 (25 MB)…');
  resetDoc();
  try {
    const resp = await fetch(new URL('sample.dwg', document.baseURI).href);
    if (resp.status === 404) {
      throw new Error('示例文件未随仓库分发 (.dwg 已被 gitignore)。请用工具栏「打开」选择本地 DWG 文件');
    }
    if (!resp.ok) throw new Error(`示例文件加载失败 (${resp.status})`);
    const buf = await resp.arrayBuffer();
    const wasmBase = new URL('wasm/', document.baseURI).href;
    worker.postMessage({ t: 'parse', buf, wasmBase }, [buf]);
  } catch (err) {
    progress.error(err instanceof Error ? err.message : String(err));
    loading = false;
  }
}

function resetDoc(): void {
  doc.clear();
  undo.clear();
  tools.clearSelection();
  toolbar.setUndoRedo(false, false);
  toolbar.setDeleteEnabled(false);
  // 清空渲染场景: 重建 renderer 场景中的空间组
  renderer.reset();
}

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
  fileInput.value = '';
});

// 拖拽打开
canvasWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  canvasWrap.classList.add('dragover');
});
canvasWrap.addEventListener('dragleave', () => canvasWrap.classList.remove('dragover'));
canvasWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  canvasWrap.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// ---------- 导出 ----------
const exportDefaults = { decimals: 2, includeInvisible: false, background: 'white' as const, patternFill: true };

function openExportDialog(rect: Rect): void {
  const candidates = doc.queryRect(doc.activeSpace, rect);
  const sizeMb = 0;
  showExportDialog(
    `区域: ${fmt(rect.x1)},${fmt(rect.y1)} → ${fmt(rect.x2)},${fmt(rect.y2)} (世界单位)<br>区域内实体: <b>${candidates.length}</b> 个`,
    { ...exportDefaults },
    (opts) => {
      Object.assign(exportDefaults, opts);
      doExportSvg(rect, opts);
    },
    () => { /* 取消 */ },
  );
  void sizeMb;
}

function fmt(n: number): string {
  return +n.toFixed(2) + '';
}

function doExportSvg(rect: Rect, opts: exportOpts): void {
  try {
    const result = exportSvg(doc, doc.activeSpace, rect, opts);
    const blob = new Blob([result.svg], { type: 'image/svg+xml' });
    downloadBlob(blob, `cad-export-${Date.now()}.svg`);
    status.setStatus(`SVG 已导出: ${result.count} 实体, ${(result.bytes / 1048576).toFixed(2)} MB`);
    showTip(`导出完成: ${result.count} 个实体, ${(result.bytes / 1048576).toFixed(2)} MB`);
  } catch (err) {
    showTip(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  tools.setTool('select');
  marqueeTip.classList.add('hidden');
}
type exportOpts = Parameters<typeof exportSvg>[3];

async function exportPng(): Promise<void> {
  const blob = await renderer.toBlob(2);
  if (blob) downloadBlob(blob, `cad-view-${Date.now()}.png`);
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- 键盘快捷键 ----------
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo.undo(); toolbar.setUndoRedo(undo.canUndo, undo.canRedo); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); undo.redo(); toolbar.setUndoRedo(undo.canUndo, undo.canRedo); }
  else if (!e.ctrlKey && !e.altKey) {
    const map: Record<string, ToolId> = {
      v: 'select', l: 'line', p: 'pline', c: 'circle', a: 'arc', r: 'rect',
    };
    const t = map[e.key.toLowerCase()];
    if (t) tools.setTool(t);
  }
});

status.setStatus('打开 DWG 文件开始使用 (拖拽文件到窗口, 或点击"打开"/"示例")');

// 调试句柄
declare global {
  interface Window { __cad?: Record<string, unknown> }
}
window.__cad = {
  doc, view, tools, renderer, undo,
  exportRegion: (x1: number, y1: number, x2: number, y2: number, opts?: Record<string, unknown>) =>
    exportSvg(doc, doc.activeSpace,
      { x1, y1, x2, y2 },
      { decimals: 2, includeInvisible: false, background: 'white', patternFill: true, ...(opts ?? {}) }),
};
