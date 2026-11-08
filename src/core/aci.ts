/** AutoCAD Color Index (ACI) → RGB */

// 标准 ACI 0-9
const ACI_BASE: [number, number, number][] = [
  [0, 0, 0],        // 0 BYBLOCK
  [255, 0, 0],      // 1 红
  [255, 255, 0],    // 2 黄
  [0, 255, 0],      // 3 绿
  [0, 255, 255],    // 4 青
  [0, 0, 255],      // 5 蓝
  [255, 0, 255],    // 6 品红
  [255, 255, 255],  // 7 白/黑 (按背景)
  [65, 65, 65],     // 8 深灰
  [128, 128, 128],  // 9 浅灰
];

// ACI 10-249: 24 色相 × 10 灰阶 (标准近似生成)
function genAciTable(): Uint8Array {
  const table = new Uint8Array(256 * 3);
  const set = (i: number, r: number, g: number, b: number) => {
    table[i * 3] = r; table[i * 3 + 1] = g; table[i * 3 + 2] = b;
  };
  for (let i = 0; i < 10; i++) set(i, ACI_BASE[i][0], ACI_BASE[i][1], ACI_BASE[i][2]);

  for (let band = 0; band < 24; band++) {
    const hue = band * 15;
    for (let row = 0; row < 10; row++) {
      const idx = 10 + band * 10 + row;
      let r: number, g: number, b: number;
      if (row < 2) {
        // 淡色行: 饱和度递减
        const s = row === 0 ? 0.3 : 0.6;
        [r, g, b] = hsvToRgb(hue, s, 1);
      } else {
        const v = 1 - (row - 2) * 0.2;
        [r, g, b] = hsvToRgb(hue, 1, v);
      }
      set(idx, Math.round(r), Math.round(g), Math.round(b));
    }
  }
  // 250-255 灰阶
  const grays = [51, 80, 105, 130, 190, 255];
  for (let i = 0; i < 6; i++) set(250 + i, grays[i], grays[i], grays[i]);
  return table;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const ACI = genAciTable();

/**
 * ACI → 0xRRGGBB。dark=true 时 (深色背景) ACI 7 渲染为白色, 否则黑色。
 * colorIndex 0 (BYBLOCK) 无法在解析期确定 → 按 7 处理。
 */
export function aciToRgb(idx: number | undefined, dark = true): number {
  if (idx == null || idx < 0 || idx > 255) idx = 7;
  let r: number, g: number, b: number;
  if (idx === 7) {
    [r, g, b] = dark ? [255, 255, 255] : [0, 0, 0];
  } else if (idx === 0) {
    [r, g, b] = dark ? [255, 255, 255] : [0, 0, 0]; // BYBLOCK 保守处理
  } else {
    r = ACI[idx * 3]; g = ACI[idx * 3 + 1]; b = ACI[idx * 3 + 2];
  }
  return (r << 16) | (g << 8) | b;
}

export function rgbToFloats(rgb: number): [number, number, number] {
  return [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
}

export function rgbToHex(rgb: number): string {
  return '#' + rgb.toString(16).padStart(6, '0');
}

/** 主题相关的白/黑: 深色背景用白, 浅色背景用黑 (ACI 7 / BYBLOCK 的行为) */
export function themeAdaptiveRgb(dark: boolean): number {
  return dark ? 0xffffff : 0x000000;
}

/** 有效 ACI → 主题化 RGB。aci: 0-255 = ACI, 256+ = 真彩色 (按 darkRgb 原样) */
export function aciThemeRgb(aci: number | undefined, resolvedRgb: number, dark: boolean): number {
  if (aci === 7 || aci === 0) return themeAdaptiveRgb(dark);
  return resolvedRgb;
}
