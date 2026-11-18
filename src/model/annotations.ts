import { newId } from './named';
import { findIndex, type LogicalPage } from './pages';
import type {
  Annotation,
  AnnotationColor,
  BookSettings,
  HighlightRect,
  HighlightStroke,
  Memo,
  NormPoint,
  NormRect,
  PageRef,
  Side,
} from './types';

/**
 * 注釈(蛍光ペン・位置つきメモ)の操作と座標計算。DOM に依存しない純粋関数。
 * 座標は元画像(見開き1枚)基準の正規化座標(0〜1)で持つ(4章)。分割位置・トリミングを変えても動かない。
 * 削除は消さずに「削除済み」の印(墓標)を残す(同期で他端末に伝えるため)。
 */

export const COLORS: Record<AnnotationColor, { label: string; css: string }> = {
  yellow: { label: '黄', css: '#ffe45e' },
  green: { label: '緑', css: '#7be37b' },
  pink: { label: 'ピンク', css: '#ff8fc7' },
  blue: { label: '青', css: '#7cc4ff' },
};
export const COLOR_KEYS = Object.keys(COLORS) as AnnotationColor[];

/** 自由線の太さ(元画像の幅に対する割合)。中は、見開き2400pxの写真で約29px */
export const STROKE_WIDTHS = { thin: 0.006, medium: 0.012, thick: 0.024 } as const;
export type StrokeThickness = keyof typeof STROKE_WIDTHS;
export const STROKE_WIDTH = STROKE_WIDTHS.medium;

export interface PageSize {
  w: number;
  h: number;
}

const bump = (prev: number, now: number) => Math.max(now, prev + 1);

export function addRect(
  list: readonly Annotation[],
  p: { page: PageRef; color: AnnotationColor; rect: NormRect },
  now = Date.now(),
  id = newId(),
): Annotation[] {
  const a: HighlightRect = { id, kind: 'highlight-rect', page: p.page, color: p.color, rect: p.rect, createdAt: now, updatedAt: now };
  return [...list, a];
}

export function addStroke(
  list: readonly Annotation[],
  p: { page: PageRef; color: AnnotationColor; points: NormPoint[]; width?: number },
  now = Date.now(),
  id = newId(),
): Annotation[] {
  const a: HighlightStroke = {
    id, kind: 'highlight-stroke', page: p.page, color: p.color, points: p.points, width: p.width ?? STROKE_WIDTH,
    createdAt: now, updatedAt: now,
  };
  return [...list, a];
}

export function addMemo(
  list: readonly Annotation[],
  p: { page: PageRef; at: NormPoint; text: string },
  now = Date.now(),
  id = newId(),
): Annotation[] {
  const a: Memo = { id, kind: 'memo', page: p.page, at: p.at, text: p.text, createdAt: now, updatedAt: now };
  return [...list, a];
}

export function updateMemoText(list: readonly Annotation[], id: string, text: string, now = Date.now()): Annotation[] {
  return list.map((a) => (a.id === id && a.kind === 'memo' ? { ...a, text, updatedAt: bump(a.updatedAt, now) } : a));
}

export function deleteAnnotation(list: readonly Annotation[], id: string, now = Date.now()): Annotation[] {
  return list.map((a) => (a.id === id ? { ...a, deleted: true, updatedAt: bump(a.updatedAt, now) } : a));
}

export const visibleAnnotations = (list: readonly Annotation[]): Annotation[] => list.filter((a) => !a.deleted);

/** 削除済みを元に戻す(「元に戻す」用)。更新日時は進めるので、同期で古い状態に負けない。 */
export function restoreAnnotation(list: readonly Annotation[], id: string, now = Date.now()): Annotation[] {
  return list.map((a) => {
    if (a.id !== id) return a;
    const { deleted: _removed, ...rest } = a;
    return { ...rest, updatedAt: bump(a.updatedAt, now) } as Annotation;
  });
}

/** 蛍光ペンの色を変える */
export function setAnnotationColor(list: readonly Annotation[], id: string, color: AnnotationColor, now = Date.now()): Annotation[] {
  return list.map((a) =>
    a.id === id && (a.kind === 'highlight-rect' || a.kind === 'highlight-stroke') ? { ...a, color, updatedAt: bump(a.updatedAt, now) } : a,
  );
}

/**
 * 蛍光ペンの箇所の文字(OCRの結果、または手で直した文字)を保存する。空にすると「未取得」に戻す。
 * 更新日時を進めるので、同期で古い状態に負けない。
 */
export function setHighlightText(list: readonly Annotation[], id: string, text: string, now = Date.now()): Annotation[] {
  return list.map((a) => {
    if (a.id !== id || a.kind === 'memo') return a;
    const { ocrText: _old, ...rest } = a;
    const t = text.trim();
    return { ...rest, ...(t === '' ? {} : { ocrText: t }), updatedAt: bump(a.updatedAt, now) } as Annotation;
  });
}

/** 自由線の太さを変える */
export function setStrokeWidth(list: readonly Annotation[], id: string, width: number, now = Date.now()): Annotation[] {
  return list.map((a) => (a.id === id && a.kind === 'highlight-stroke' ? { ...a, width, updatedAt: bump(a.updatedAt, now) } : a));
}

// ---- 蛍光ペンの修正(動かす・伸ばす・縮める) ----

export type RectCorner = 'nw' | 'ne' | 'sw' | 'se';
export type StrokeEnd = 'start' | 'end';

const MIN_RECT = 0.002;
/** 動かせる範囲(正規化)。既定はページ全体。いま表示している範囲を渡すと、見えない所へ動かしてしまわない */
const WHOLE: NormRect = { x: 0, y: 0, w: 1, h: 1 };
const clampIn = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 蛍光ペン・メモを、正規化座標で (dx, dy) だけ動かす。ページの外へはみ出さない */
export function movedGeometry(a: Annotation, dx: number, dy: number, bounds: NormRect = WHOLE): Geometry | null {
  const x0 = bounds.x;
  const y0 = bounds.y;
  const x1 = bounds.x + bounds.w;
  const y1 = bounds.y + bounds.h;
  if (a.kind === 'memo') return { at: { x: clampIn(a.at.x + dx, x0, x1), y: clampIn(a.at.y + dy, y0, y1) } };
  if (a.kind === 'highlight-rect') {
    const x = clampIn(a.rect.x + dx, x0, Math.max(x0, x1 - a.rect.w));
    const y = clampIn(a.rect.y + dy, y0, Math.max(y0, y1 - a.rect.h));
    return { rect: { ...a.rect, x, y } };
  }
  if (a.kind === 'highlight-stroke') {
    const xs = a.points.map((p) => p.x);
    const ys = a.points.map((p) => p.y);
    const sx = Math.max(x0 - Math.min(...xs), Math.min(x1 - Math.max(...xs), dx));
    const sy = Math.max(y0 - Math.min(...ys), Math.min(y1 - Math.max(...ys), dy));
    return { points: a.points.map((p) => ({ x: p.x + sx, y: p.y + sy })) };
  }
  return null;
}

/** 四角の、角をつかんで動かした結果。反対側の角は動かさない。裏返ってもよい */
export function resizedRect(r: NormRect, corner: RectCorner, p: NormPoint, bounds: NormRect = WHOLE): NormRect {
  const opp: NormPoint = {
    x: corner === 'nw' || corner === 'sw' ? r.x + r.w : r.x,
    y: corner === 'nw' || corner === 'ne' ? r.y + r.h : r.y,
  };
  const q = { x: clampIn(p.x, bounds.x, bounds.x + bounds.w), y: clampIn(p.y, bounds.y, bounds.y + bounds.h) };
  const out = rectFrom(opp, q);
  return { x: out.x, y: out.y, w: Math.max(MIN_RECT, out.w), h: Math.max(MIN_RECT, out.h) };
}

/**
 * なぞった線の、端をつかんで伸ばす・縮める。反対側の端は動かさず、つかんだ端が指の位置に来るように、
 * 線全体を拡大・縮小・回転する(まっすぐに近い線が、自然に伸び縮みする)。計算は画面と同じ縦横比のピクセルで行う。
 */
export function stretchedStroke(points: readonly NormPoint[], end: StrokeEnd, p: NormPoint, page: PageSize, bounds: NormRect = WHOLE): NormPoint[] {
  if (points.length < 2) return [...points];
  const fixed = end === 'end' ? points[0]! : points[points.length - 1]!;
  const grabbed = end === 'end' ? points[points.length - 1]! : points[0]!;
  const fx = fixed.x * page.w;
  const fy = fixed.y * page.h;
  const v0x = grabbed.x * page.w - fx;
  const v0y = grabbed.y * page.h - fy;
  const v1x = clampIn(p.x, bounds.x, bounds.x + bounds.w) * page.w - fx;
  const v1y = clampIn(p.y, bounds.y, bounds.y + bounds.h) * page.h - fy;
  const l0 = Math.hypot(v0x, v0y);
  const l1 = Math.hypot(v1x, v1y);
  if (l0 < 1e-6) return points.map((q) => ({ ...q }));
  const s = Math.max(0.02, l1 / l0);
  const theta = l1 < 1e-6 ? 0 : Math.atan2(v1y, v1x) - Math.atan2(v0y, v0x);
  const cos = Math.cos(theta) * s;
  const sin = Math.sin(theta) * s;
  return points.map((q) => {
    const dx = q.x * page.w - fx;
    const dy = q.y * page.h - fy;
    return {
      x: clampIn((fx + dx * cos - dy * sin) / page.w, bounds.x, bounds.x + bounds.w),
      y: clampIn((fy + dx * sin + dy * cos) / page.h, bounds.y, bounds.y + bounds.h),
    };
  });
}

export type Geometry = { rect: NormRect } | { points: NormPoint[] } | { at: NormPoint };

/**
 * 蛍光ペン・メモの形(位置・大きさ)を置き換える。更新日時を進めるので、同期で古い状態に負けない。
 * 文字(ocrText・メモの本文)はそのまま残す。page を渡すと、属するページ(左/右)も置き換える(動かして、左右をまたいだとき)。
 */
export function setAnnotationGeometry(list: readonly Annotation[], id: string, g: Geometry, now = Date.now(), page?: PageRef): Annotation[] {
  return list.map((a) => {
    if (a.id !== id) return a;
    const pg = page ? { page: { ...page } } : {};
    if (a.kind === 'highlight-rect' && 'rect' in g) return { ...a, ...pg, rect: { ...g.rect }, updatedAt: bump(a.updatedAt, now) };
    if (a.kind === 'highlight-stroke' && 'points' in g) return { ...a, ...pg, points: g.points.map((q) => ({ ...q })), updatedAt: bump(a.updatedAt, now) };
    if (a.kind === 'memo' && 'at' in g) return { ...a, ...pg, at: { ...g.at }, updatedAt: bump(a.updatedAt, now) };
    return a;
  });
}

/** 現在の形(元に戻す用の控え) */
export function geometryOf(a: Annotation): Geometry | null {
  if (a.kind === 'highlight-rect') return { rect: { ...a.rect } };
  if (a.kind === 'highlight-stroke') return { points: a.points.map((q) => ({ ...q })) };
  return { at: { ...a.at } };
}

/** 形の中心(正規化)。属するページ(左/右)を決めるのに使う */
export function geometryCenter(g: Geometry): NormPoint {
  if ('rect' in g) return centerOf(g.rect);
  if ('at' in g) return g.at;
  const xs = g.points.map((p) => p.x);
  const ys = g.points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// ---- 座標 ----

/** 画面上の点(表示領域の左上が原点)を、元画像基準の正規化座標に直す。表示範囲(region)の外へはみ出さない。 */
export function pointToNorm(
  x: number,
  y: number,
  layout: { tx: number; ty: number; scale: number },
  fit: { w: number; h: number },
  region: NormRect,
): NormPoint {
  const px = (x - layout.tx) / layout.scale;
  const py = (y - layout.ty) / layout.scale;
  const fx = Math.min(1, Math.max(0, px / fit.w));
  const fy = Math.min(1, Math.max(0, py / fit.h));
  return { x: region.x + fx * region.w, y: region.y + fy * region.h };
}

/** 点が見開きのどちら側にあるか。「分割しない」ページは W。 */
export function sideAt(nx: number, pdfPage: number, settings: BookSettings): Side {
  const ov = settings.pageOverrides[String(pdfPage)];
  if (ov?.split === false) return 'W';
  const split = ov?.splitPosition ?? settings.splitPosition;
  return nx < split ? 'L' : 'R';
}

export function rectFrom(a: NormPoint, b: NormPoint): NormRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function centerOf(r: NormRect): NormPoint {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** 注釈を囲む矩形(正規化)。自由線は線の太さの分だけ広げる。 */
export function annotationBounds(a: Annotation, page: PageSize): NormRect {
  if (a.kind === 'highlight-rect') return a.rect;
  if (a.kind === 'memo') return { x: a.at.x, y: a.at.y, w: 0, h: 0 };
  const xs = a.points.map((p) => p.x);
  const ys = a.points.map((p) => p.y);
  const hx = a.width / 2;
  const hy = (a.width / 2) * (page.w / page.h); // 幅の割合を、高さ方向の割合に直す
  const x0 = Math.min(...xs) - hx;
  const y0 = Math.min(...ys) - hy;
  return { x: x0, y: y0, w: Math.max(...xs) + hx - x0, h: Math.max(...ys) + hy - y0 };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 点(正規化)が、蛍光ペンの上か。tol は元画像のピクセル単位の余裕。メモは対象外(ピンの操作で扱う)。 */
export function hitHighlight(a: Annotation, p: NormPoint, tol: number, page: PageSize): boolean {
  const px = p.x * page.w;
  const py = p.y * page.h;
  if (a.kind === 'highlight-rect') {
    return (
      px >= a.rect.x * page.w - tol && px <= (a.rect.x + a.rect.w) * page.w + tol &&
      py >= a.rect.y * page.h - tol && py <= (a.rect.y + a.rect.h) * page.h + tol
    );
  }
  if (a.kind === 'highlight-stroke') {
    const half = (a.width * page.w) / 2 + tol;
    const pts = a.points;
    if (pts.length === 1) return Math.hypot(px - pts[0]!.x * page.w, py - pts[0]!.y * page.h) <= half;
    for (let i = 1; i < pts.length; i++) {
      const s = pts[i - 1]!;
      const e = pts[i]!;
      if (distToSegment(px, py, s.x * page.w, s.y * page.h, e.x * page.w, e.y * page.h) <= half) return true;
    }
  }
  return false;
}

// ---- 自由線の補正 ----

/** 水平とみなす角度(度)。これ以内なら、きれいな水平にする */
export const SNAP_HORIZONTAL_DEG = 5;

/**
 * 定規で引いたような、2点の直線。始点から終点まで、まっすぐ結ぶ。
 * ほぼ水平(SNAP_HORIZONTAL_DEG 以内)のときは、終点の高さを始点に合わせて、水平にする。
 * 角度は、画面の見た目(ページの縦横の大きさを掛けた値)で測る。
 */
export function straightLine(a: NormPoint, b: NormPoint, page: PageSize, snapDeg = SNAP_HORIZONTAL_DEG): NormPoint[] {
  const dx = (b.x - a.x) * page.w;
  const dy = (b.y - a.y) * page.h;
  const flat = dx !== 0 && (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI <= snapDeg;
  return [{ ...a }, { x: b.x, y: flat ? a.y : b.y }];
}

/**
 * 自由線の点を間引く(Ramer–Douglas–Peucker)。tol は元PDFの単位(ポイント)での許容のずれ。
 * 細かい手ぶれの点を捨てつつ、曲がり角は残す。データも小さくなる。
 */
export function simplifyPoints(points: readonly NormPoint[], tol: number, page: PageSize): NormPoint[] {
  if (points.length <= 2) return [...points];
  const px = (p: NormPoint) => ({ x: p.x * page.w, y: p.y * page.h });
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    const a = px(points[lo]!);
    const b = px(points[hi]!);
    let worst = -1;
    let worstDist = tol;
    for (let i = lo + 1; i < hi; i++) {
      const p = px(points[i]!);
      const d = distToSegment(p.x, p.y, a.x, a.y, b.x, b.y);
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * 点列を、角の無い滑らかな曲線にする SVG のパス。各点を制御点、隣り合う点の中点を通過点とする二次曲線。
 * 手ぶれのカクカクが目立たなくなる。画面表示と書き出し画像で同じ形になるよう、共通の規則にする。
 */
export function smoothPath(points: readonly { x: number; y: number }[]): string {
  const n = points.length;
  if (n === 0) return '';
  const f = (v: number) => Number(v.toFixed(3));
  const p0 = points[0]!;
  if (n === 1) return `M ${f(p0.x)} ${f(p0.y)} l 0.01 0`;
  if (n === 2) return `M ${f(p0.x)} ${f(p0.y)} L ${f(points[1]!.x)} ${f(points[1]!.y)}`;
  let d = `M ${f(p0.x)} ${f(p0.y)}`;
  for (let i = 1; i < n - 1; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    d += ` Q ${f(p.x)} ${f(p.y)} ${f((p.x + q.x) / 2)} ${f((p.y + q.y) / 2)}`;
  }
  const last = points[n - 1]!;
  return `${d} L ${f(last.x)} ${f(last.y)}`;
}

// ---- ページとの対応・番号 ----

/** 注釈を、論理ページ(読む順)ごとにまとめる。削除済みは除く。設定変更で無くなった面は、同じ見開きの先頭ページに寄せる。 */
export function groupByPage(pages: LogicalPage[], list: readonly Annotation[]): Map<number, Annotation[]> {
  const map = new Map<number, Annotation[]>();
  if (pages.length === 0) return map;
  for (const a of visibleAnnotations(list)) {
    const i = findIndex(pages, a.page);
    const arr = map.get(i);
    if (arr) arr.push(a);
    else map.set(i, [a]);
  }
  for (const arr of map.values()) arr.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
  return map;
}

/** メモの番号(ページ内で作成順に 1, 2, …)。画像の番号と Markdown の番号を一致させるために使う。 */
export function numberMemos(list: readonly Annotation[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const a of list) if (a.kind === 'memo') out.set(a.id, ++n);
  return out;
}
