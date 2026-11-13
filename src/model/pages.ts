import type { BookSettings, NormRect, PageOverride, PageRef } from './types';

export interface LogicalPage {
  /** 0 始まりの論理ページ位置(通し番号 = index + 1) */
  index: number;
  ref: PageRef;
}

function overrideOf(settings: BookSettings, pdfPage: number): PageOverride | undefined {
  return settings.pageOverrides[String(pdfPage)];
}

/** 開き方向に応じた、見開き内の読む順 */
function readingOrder(settings: BookSettings): ('L' | 'R')[] {
  return settings.openDirection === 'rtl' ? ['R', 'L'] : ['L', 'R'];
}

/** PDFの全ページから、1ページずつ読む順の論理ページ列を作る。 */
export function buildPageList(numPages: number, settings: BookSettings): LogicalPage[] {
  const list: LogicalPage[] = [];
  for (let p = 1; p <= numPages; p++) {
    const ov = overrideOf(settings, p);
    let refs: PageRef[];
    if (ov?.split === false) {
      refs = [{ pdfPage: p, side: 'W' }];
    } else if (p === 1 && settings.firstPage !== 'both') {
      refs = [{ pdfPage: p, side: settings.firstPage }];
    } else {
      refs = readingOrder(settings).map((side) => ({ pdfPage: p, side }));
    }
    for (const ref of refs) list.push({ index: list.length, ref });
  }
  return list;
}

/** 物理位置から、元画像上の表示範囲(正規化)を返す。トリミングは含まない。 */
export function regionOf(ref: PageRef, settings: BookSettings): NormRect {
  if (ref.side === 'W') return { x: 0, y: 0, w: 1, h: 1 };
  const split = overrideOf(settings, ref.pdfPage)?.splitPosition ?? settings.splitPosition;
  return ref.side === 'L'
    ? { x: 0, y: 0, w: split, h: 1 }
    : { x: split, y: 0, w: 1 - split, h: 1 };
}

export function samePage(a: PageRef, b: PageRef): boolean {
  return a.pdfPage === b.pdfPage && a.side === b.side;
}

/** 物理位置から論理ページ位置を探す。見つからなければ同じPDFページの先頭、それも無ければ 0。 */
export function findIndex(list: LogicalPage[], ref: PageRef): number {
  const exact = list.find((l) => samePage(l.ref, ref));
  if (exact) return exact.index;
  const sameSheet = list.find((l) => l.ref.pdfPage === ref.pdfPage);
  return sameSheet ? sameSheet.index : 0;
}

export function clampIndex(list: LogicalPage[], index: number): number {
  return Math.max(0, Math.min(list.length - 1, index));
}

/** 通し番号は 1 始まり。印刷番号は設定があるときだけ計算する。 */
export function pageNumbers(
  index: number,
  settings: BookSettings,
): { serial: number; printed: number | null } {
  const serial = index + 1;
  const pn = settings.printedNumber;
  const printed = pn ? serial - pn.serial + pn.printed : null;
  // 表紙・前付けなど、印刷番号が1未満になるページには印刷番号を付けない
  return { serial, printed: printed !== null && printed >= 1 ? printed : null };
}

/** 例: 「p.45(通し番号52)」。印刷番号が無いときは「通し番号52」。 */
export function formatPageLabel(index: number, settings: BookSettings): string {
  const { serial, printed } = pageNumbers(index, settings);
  return printed === null ? `通し番号${serial}` : `p.${printed}(通し番号${serial})`;
}

/**
 * ページジャンプ(N-2)。通し番号(1始まり)または印刷番号から、論理ページ位置(0始まり)を返す。
 * 範囲外、印刷番号の対応が未設定のときは null。
 */
export function jumpTarget(
  list: LogicalPage[],
  settings: BookSettings,
  mode: 'serial' | 'printed',
  n: number,
): number | null {
  if (!Number.isInteger(n)) return null;
  let serial = n;
  if (mode === 'printed') {
    const pn = settings.printedNumber;
    if (!pn) return null;
    serial = n - pn.printed + pn.serial;
  }
  return serial >= 1 && serial <= list.length ? serial - 1 : null;
}
