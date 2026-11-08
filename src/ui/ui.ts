/** UI 构建: 工具栏 / 图层面板 / 状态栏 / 对话框 */
import type { Doc } from '../app/document';
import type { ToolId } from '../app/tools';

// ---------- 图标 (内联 SVG) ----------
const I = {
  open: '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  cursor: '<svg viewBox="0 0 24 24"><path d="M7 2l12 11-5 1 3 6-3 1.5-3-6-4 4V2z"/></svg>',
  pan: '<svg viewBox="0 0 24 24"><path d="M12 2a2 2 0 0 1 2 2v6h1V5a2 2 0 1 1 4 0v9a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6V9a2 2 0 1 1 4 0v1h1V4a2 2 0 0 1 2-2z"/></svg>',
  line: '<svg viewBox="0 0 24 24"><path d="M4 20L20 4l1.4 1.4L5.4 21.4 4 20z"/></svg>',
  pline: '<svg viewBox="0 0 24 24"><path d="M3 19l5-9 5 4 6-10 2 1.2-7 11.6-5-4-4.4 7.9L3 19z"/></svg>',
  circle: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/></svg>',
  arc: '<svg viewBox="0 0 24 24"><path d="M4 20a12 12 0 0 1 16-9l-.7 1.9A10 10 0 0 0 6 20H4z"/></svg>',
  rect: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3V5zm2 2v10h14V7H5z"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M8 6L3 11l5 5v-3.5h6A4.5 4.5 0 0 0 18.5 8V7h-2v1a2.5 2.5 0 0 1-2.5 2.5H8V6z"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M16 6l5 5-5 5v-3.5h-6A4.5 4.5 0 0 1 5.5 8V7h2v1A2.5 2.5 0 0 0 10 10.5h6V6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 3l10 5-10 5L2 8l10-5zm0 7.2L4.5 6.4 2 8l10 5 10-5-2.5-1.6L12 10.2zM2 12l10 5 10-5v2.5L12 19.5 2 14.5V12z"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/></svg>',
  exportSvg: '<svg viewBox="0 0 24 24"><path d="M5 3h9l5 5v13H5V3zm8 1.5V9h4.5L13 4.5zM8 12h8v2l3-3-3-3v2H8v2zm0 4h8v-2l3 3-3 3v-2H8v-2z"/></svg>',
  exportPng: '<svg viewBox="0 0 24 24"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 12l3-4 2.5 3 3-4.5L19 17H7zm2.5-7a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>',
  theme: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>',
  snap: '<svg viewBox="0 0 24 24"><path d="M12 2l3 5h-2v4h4V9l5 3-5 3v-2h-4v4h2l-3 5-3-5h2v-4H7v2l-5-3 5-3v2h4V7H9l3-5z"/></svg>',
};

export interface ToolbarCallbacks {
  onOpen(): void;
  onSample(): void;
  onTool(id: ToolId): void;
  onUndo(): void;
  onRedo(): void;
  onDelete(): void;
  onLayers(): void;
  onFit(): void;
  onExportSvg(): void;
  onExportPng(): void;
  onSnapToggle(on: boolean): void;
  onToggleTheme(): void;
}

export interface ToolbarHandles {
  el: HTMLElement;
  setToolActive(id: ToolId): void;
  setUndoRedo(canUndo: boolean, canRedo: boolean): void;
  setDeleteEnabled(on: boolean): void;
  setSnap(on: boolean): void;
  setThemeDark(dark: boolean): void;
}

export function buildToolbar(cb: ToolbarCallbacks): ToolbarHandles {
  const el = document.getElementById('toolbar')!;
  el.innerHTML = '';
  const mk = (html: string, tip: string, fn: () => void, id?: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.innerHTML = html;
    b.title = tip;
    b.addEventListener('click', fn);
    if (id) b.dataset.tool = id;
    el.appendChild(b);
    return b;
  };
  const sep = () => {
    const s = document.createElement('div');
    s.className = 'tb-sep';
    el.appendChild(s);
  };

  mk(I.open, '打开本地 DWG/DXF 文件', cb.onOpen);
  mk('示例', '打开示例图纸 (VLCC 轮廓图)', cb.onSample);
  sep();
  mk(I.cursor, '选择/框选 (V)', () => cb.onTool('select'), 'select');
  mk(I.pan, '平移 (按住中键/右键拖拽也可平移)', () => cb.onTool('pan'), 'pan');
  mk(I.line, '直线 (L)', () => cb.onTool('line'), 'line');
  mk(I.pline, '多段线 (P)', () => cb.onTool('pline'), 'pline');
  mk(I.circle, '圆 (C)', () => cb.onTool('circle'), 'circle');
  mk(I.arc, '圆弧 (A)', () => cb.onTool('arc'), 'arc');
  mk(I.rect, '矩形 (R)', () => cb.onTool('rect'), 'rect');
  sep();
  const undoBtn = mk(I.undo, '撤销 (Ctrl+Z)', cb.onUndo, 'undo');
  const redoBtn = mk(I.redo, '重做 (Ctrl+Y)', cb.onRedo, 'redo');
  const delBtn = mk(I.trash, '删除所选 (Delete)', cb.onDelete, 'del');
  sep();
  const snapBtn = mk(I.snap, '对象捕捉开关', () => {
    /* 由 main 重写 */ }, 'snap');
  const themeBtn = mk(I.theme, '深/浅主题切换 (ACI 7 黑白随背景反转)', () => {
    cb.onToggleTheme();
  }, 'theme');
  sep();
  mk(I.fit, '缩放范围 (Zoom Extents)', cb.onFit, 'fit');
  mk(I.layers, '图层面板', cb.onLayers, 'layers');
  sep();
  mk(I.exportSvg, '框选导出 SVG (核心功能)', () => cb.onTool('export'), 'export');
  mk(I.exportPng, '导出当前视图 PNG', cb.onExportPng, 'png');

  const toolBtns = new Map<string, HTMLButtonElement>();
  el.querySelectorAll('[data-tool]').forEach((b) => toolBtns.set((b as HTMLElement).dataset.tool!, b as HTMLButtonElement));

  snapBtn.classList.add('active');
  snapBtn.addEventListener('click', () => {
    snapBtn.classList.toggle('active');
  });

  return {
    el,
    setToolActive(id: ToolId) {
      for (const [tid, b] of toolBtns) {
        if (['select', 'pan', 'line', 'pline', 'circle', 'arc', 'rect', 'export'].includes(tid)) {
          b.classList.toggle('active', tid === id);
        }
      }
    },
    setUndoRedo(canUndo: boolean, canRedo: boolean) {
      undoBtn.disabled = !canUndo;
      redoBtn.disabled = !canRedo;
    },
    setDeleteEnabled(on: boolean) {
      delBtn.disabled = !on;
    },
    setSnap(on: boolean) {
      snapBtn.classList.toggle('active', on);
    },
    setThemeDark(dark: boolean) {
      themeBtn.classList.toggle('active', !dark);
      themeBtn.title = dark ? '切换到浅色主题 (仿 TrueView 白底黑字)' : '切换到深色主题';
    },
  };
}

// ---------- 图层面板 ----------
export interface LayersPanelHandles {
  el: HTMLElement;
  render(): void;
  toggle(): void;
  get visible(): boolean;
}

export function buildLayersPanel(
  doc: Doc,
  onToggle: (idx: number, visible: boolean) => void,
  onPickLayer: (idx: number) => void,
): LayersPanelHandles {
  const el = document.getElementById('layersPanel')!;
  let currentLayer = 0;

  const render = (): void => {
    el.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'lp-header';
    header.innerHTML = `<span>图层 (${doc.layers.length})</span>`;
    el.appendChild(header);
    const rgbHex = (c: number) => '#' + c.toString(16).padStart(6, '0');
    doc.layers.forEach((layer, i) => {
      const row = document.createElement('div');
      row.className = 'lp-row' + (i === currentLayer ? ' current' : '');
      const eye = document.createElement('span');
      eye.className = 'lp-eye' + (doc.layerVisible[i] ? '' : ' off');
      eye.textContent = doc.layerVisible[i] ? '👁' : '🚫';
      eye.title = '显示/隐藏';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        onToggle(i, !doc.layerVisible[i]);
        render();
      });
      const swatch = document.createElement('span');
      swatch.className = 'lp-swatch';
      swatch.style.background = rgbHex(layer.rgb);
      const name = document.createElement('span');
      name.className = 'lp-name';
      name.textContent = layer.name;
      name.title = layer.name;
      const count = document.createElement('span');
      count.className = 'lp-count';
      count.textContent = String(layer.count);
      row.append(eye, swatch, name, count);
      row.addEventListener('click', () => {
        currentLayer = i;
        onPickLayer(i);
        render();
      });
      el.appendChild(row);
    });
  };

  const toggle = (): void => { el.classList.toggle('hidden'); };
  return { el, render, toggle, get visible() { return !el.classList.contains('hidden'); } };
}

// ---------- 状态栏 ----------
export interface StatusBarHandles {
  setCoords(x: number, y: number): void;
  setStatus(text: string): void;
  setInfo(text: string): void;
}

export function buildStatusBar(): StatusBarHandles {
  const el = document.getElementById('statusBar')!;
  el.innerHTML = `
    <span>坐标</span><span class="sb-val" id="sbCoord">-, -</span>
    <span id="sbInfo"></span>
    <span class="sb-hint" id="sbStatus">就绪</span>`;
  const coord = el.querySelector('#sbCoord')!;
  const info = el.querySelector('#sbInfo')!;
  const status = el.querySelector('#sbStatus')!;
  return {
    setCoords(x: number, y: number) {
      coord.textContent = Number.isFinite(x) ? `${x.toFixed(2)}, ${y.toFixed(2)}` : '-, -';
    },
    setStatus(text: string) {
      status.textContent = text;
    },
    setInfo(text: string) {
      info.textContent = text;
    },
  };
}

// ---------- 进度条 ----------
export interface ProgressHandles {
  show(title: string): void;
  update(pct: number, detail: string): void;
  hide(): void;
  error(msg: string): void;
}

export function buildProgress(): ProgressHandles {
  const overlay = document.getElementById('progressOverlay')!;
  const title = document.getElementById('progressTitle')!;
  const fill = document.getElementById('progressFill')!;
  const detail = document.getElementById('progressDetail')!;
  return {
    show(t: string) {
      overlay.classList.remove('hidden');
      title.textContent = t;
      fill.style.width = '0%';
      detail.textContent = '';
    },
    update(pct: number, d: string) {
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      if (d) detail.textContent = d;
    },
    hide() {
      overlay.classList.add('hidden');
    },
    error(msg: string) {
      overlay.classList.remove('hidden');
      title.textContent = '打开失败';
      detail.textContent = msg;
      fill.style.width = '0%';
    },
  };
}

// ---------- 导出对话框 ----------
export interface ExportDialogOpts {
  decimals: number;
  includeInvisible: boolean;
  background: 'white' | 'transparent';
  patternFill: boolean;
}

export function showExportDialog(
  infoText: string,
  defaults: ExportDialogOpts,
  onConfirm: (opts: ExportDialogOpts) => void,
  onCancel: () => void,
): void {
  const mask = document.createElement('div');
  mask.className = 'dlg-mask';
  mask.innerHTML = `
    <div class="dlg">
      <h3>导出 SVG</h3>
      <div class="dlg-info">${infoText}</div>
      <div class="dlg-row"><label>坐标小数位</label><input type="number" id="edDec" min="0" max="6" value="${defaults.decimals}"></div>
      <div class="dlg-row"><label>背景</label><select id="edBg"><option value="white">白色</option><option value="transparent">透明</option></select></div>
      <div class="dlg-row"><label>包含隐藏图层</label><input type="checkbox" id="edInv" ${defaults.includeInvisible ? 'checked' : ''}></div>
      <div class="dlg-row"><label>图案填充半透明</label><input type="checkbox" id="edPat" ${defaults.patternFill ? 'checked' : ''}></div>
      <div class="dlg-btns">
        <button id="edCancel">取消</button>
        <button id="edOk" class="primary">导出</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  (mask.querySelector('#edBg') as HTMLSelectElement).value = defaults.background;
  mask.querySelector('#edCancel')!.addEventListener('click', () => {
    mask.remove();
    onCancel();
  });
  mask.querySelector('#edOk')!.addEventListener('click', () => {
    const opts: ExportDialogOpts = {
      decimals: parseInt((mask.querySelector('#edDec') as HTMLInputElement).value, 10) || 2,
      includeInvisible: (mask.querySelector('#edInv') as HTMLInputElement).checked,
      background: (mask.querySelector('#edBg') as HTMLSelectElement).value as 'white' | 'transparent',
      patternFill: (mask.querySelector('#edPat') as HTMLInputElement).checked,
    };
    mask.remove();
    onConfirm(opts);
  });
}

export function showTip(msg: string, ms = 2600): void {
  const el = document.createElement('div');
  el.className = 'dlg-mask';
  el.style.pointerEvents = 'none';
  el.innerHTML = `<div class="dlg" style="pointer-events:auto">${msg}</div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
