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
