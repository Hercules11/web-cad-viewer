/** 内部实体模型 —— 以 DXF 实体结构为内核，与渲染/编辑/导出共用 */

export type EntType =
  | 'LINE'
  | 'CIRCLE'
  | 'ARC'
  | 'ELLIPSE'
  | 'PLINE'
  | 'TEXT'
  | 'MTEXT'
  | 'INSERT'
  | 'HATCH'
  | 'SOLID'
  | 'POINT';

export interface BBox {
  x1: number; y1: number; x2: number; y2: number;
}

export interface EntRecord {
  id: number;
  type: EntType;
  layer: number;        // 图层索引
  color: number;        // 已解析的 0xRRGGBB (深色主题基准; 块内 BYBLOCK 记为 -1)
  lt: number;           // 线型索引, -1 = BYLAYER
  /** 有效 ACI 索引 (0=BYBLOCK, 7=随主题黑白反转, 256=真彩色), 主题切换重映射用 */
  aci?: number;
  /** 透明度 alpha 0-255, 255/undefined = 不透明 */
  alpha?: number;
  /** 所属空间索引 (模型=0, 布局=1..N), 块定义记录无此字段 */
  sp?: number;
  /** 包围盒 (编辑时会同步更新) */
  bb: BBox;
  /** 按类型的负载数据, 见下方说明 */
  d: unknown;
  /** 尺寸标注等组合实体的组 id (可选) */
  group?: number;
}

/*
 * 各类型 d 字段:
 * LINE    : [x1,y1,x2,y2]
 * CIRCLE  : [cx,cy,r]
 * ARC     : [cx,cy,r,a0,a1]            (弧度, 逆时针)
 * ELLIPSE : [cx,cy,mjx,mjy,ratio,a0,a1] (major 为向量, a 为相对主轴参数角)
 * PLINE   : { v: Float32Array, b?: Float32Array(bulge), closed: boolean }  (SPLINE/LEADER 展平后也归入此形)
 * TEXT    : { x,y,h,rot,text,ha,va,wf }  ha:0左1中2右  va:0基线1下2中3上
 * MTEXT   : { x,y,h,rot,text(含\n),attach }
 * INSERT  : { name,x,y,sx,sy,rot }
 * HATCH   : { loops: Float32Array[](已展平闭合环), solid: boolean, pattern: string }
 * SOLID   : { v: Float32Array }  (6顶点两三角, 已填充)
 * POINT   : [x,y]
 */

export interface LayerInfo {
  name: string;
  color: number;      // ACI 索引
  rgb: number;        // 已解析 (深色主题基准)
  off: boolean;
  frozen: boolean;
  locked: boolean;
  lt: number;         // 线型索引
  count: number;      // 实体计数
  alpha?: number;     // 图层透明度 0-255
}

export interface LType {
  name: string;
  /** 归一化 dash 段长 (>0 实线段, <0 空段), 0 = 实线 */
  dashes: number[];
}

export interface BlockDef {
  name: string;
  bx: number;         // 基点 (记录坐标已减去基点)
  by: number;
  records: EntRecord[];
}

export interface SpaceInfo {
  name: string;
}

export interface DrawMeta {
  version: string;
  extMin: [number, number];
  extMax: [number, number];
  layers: LayerInfo[];
  ltypes: LType[];
  spaces: SpaceInfo[];
}

/** worker 消息 */
export type WorkerOut =
  | { t: 'meta'; meta: DrawMeta }
  | {
      t: 'batch';
      space: number;
      segs: Float32Array;    // [x,y,r,g,b] × 2/段
      segIds: Uint32Array;   // 每段一个实体 id
      segAci: Uint8Array;    // 每段一个有效 ACI (主题重映射用)
      tris: Float32Array;    // [x,y,r,g,b] × 3/三角
      triIds: Uint32Array;
      triAci: Uint8Array;
      records: EntRecord[];  // 本批实体记录 (INSERT 也在内, 几何已展开进 segs/tris)
    }
  | { t: 'blockdefs'; blocks: BlockDef[] }
  | { t: 'progress'; phase: string; pct: number }
  | {
      t: 'done';
      entityCount: number;
      skipped: number;
      /** 每个空间的完整范围 [x1,y1,x2,y2] */
      exts: [number, number, number, number][];
      /** 每个空间的鲁棒范围 (覆盖 97% 实体, 排除离群) */
      robustExts: [number, number, number, number][];
      modelExt: [number, number, number, number];
      /** 无法呈现的内容: 不支持的实体类型 + 缺失的外部引用 (XREF 等) */
      unsupported: {
        types: [string, number][];
        missingRefs: { name: string; refs: number }[];
        errorSamples?: [string, number][];
      };
    }
  | { t: 'error'; message: string };

export type WorkerIn =
  | { t: 'parse'; buf: ArrayBuffer; wasmBase: string }
  | { t: 'abort' };

/** 线段烘焙缓冲 (每图层一份) */
export interface SegBuf {
  segs: Float32Array;
  segIds: Uint32Array;
}

export interface TriBuf {
  tris: Float32Array;
  triIds: Uint32Array;
}
