import { croppedRegion, unionRect } from './crop';
import type { LogicalPage } from './pages';
import { formatPageLabel, pageNumbers } from './pages';
import type { BookSettings, NormRect } from './types';

/** 描画するもの: PDFの1ページ(見開き1枚)の、元画像基準の範囲 */
export interface ViewSpec {
  pdfPage: number;
  region: NormRect;
}

export interface Shown {
  /** 画面に出ている論理ページ(読む順)。1ページ表示なら1件、2ページ表示なら通常2件 */
  indices: number[];
  spec: ViewSpec;
}

/** 同じPDFページ(見開き1枚)に属する論理ページの範囲 [先頭, 末尾] */
export function sheetRange(list: LogicalPage[], index: number): [number, number] {
  const page = list[index]?.ref.pdfPage;
  let first = index;
  let last = index;
  while (first > 0 && list[first - 1]?.ref.pdfPage === page) first--;
  while (last < list.length - 1 && list[last + 1]?.ref.pdfPage === page) last++;
  return [first, last];
}

/** 2ページ表示では、見開きの先頭ページに揃える */
export function normalizeIndex(list: LogicalPage[], index: number, double: boolean): number {
  return double ? sheetRange(list, index)[0] : index;
}

/**
 * 表示するもの。2ページ表示は「撮影した見開き1枚の左右をそのまま並べる」(D-6)ため、
 * 左右それぞれのトリミング範囲を含む、元画像上の連続した1つの矩形を描画する。
 */
export function groupAt(list: LogicalPage[], index: number, double: boolean, settings: BookSettings): Shown | null {
  const page = list[index];
  if (!page) return null;
  if (!double) {
    return { indices: [index], spec: { pdfPage: page.ref.pdfPage, region: croppedRegion(page.ref, settings) } };
  }
  const [first, last] = sheetRange(list, index);
  const indices: number[] = [];
  const rects: NormRect[] = [];
  for (let i = first; i <= last; i++) {
    const p = list[i];
    if (!p) continue;
    indices.push(i);
    rects.push(croppedRegion(p.ref, settings));
  }
  return { indices, spec: { pdfPage: page.ref.pdfPage, region: unionRect(rects) } };
}

export function nextIndex(list: LogicalPage[], index: number, double: boolean): number {
  if (!double) return Math.min(index + 1, list.length - 1);
  const [first, last] = sheetRange(list, index);
  return last + 1 < list.length ? last + 1 : first;
}

export function prevIndex(list: LogicalPage[], index: number, double: boolean): number {
  if (!double) return Math.max(index - 1, 0);
  const [first] = sheetRange(list, index);
  return first > 0 ? sheetRange(list, first - 1)[0] : first;
}

/** 例: 「p.45(通し番号52)」「p.45–46(通し番号52–53)」 */
export function formatShownLabel(indices: number[], settings: BookSettings): string {
  const first = indices[0];
  const last = indices[indices.length - 1];
  if (first === undefined || last === undefined) return '';
  if (first === last) return formatPageLabel(first, settings);
  const a = pageNumbers(first, settings);
  const b = pageNumbers(last, settings);
  const serial = `通し番号${a.serial}–${b.serial}`;
  return a.printed !== null && b.printed !== null ? `p.${a.printed}–${b.printed}(${serial})` : serial;
}
