import { regionOf } from './pages';
import type { BookSettings, NormRect, PageRef } from './types';

/**
 * 余白のトリミング(D-5)。
 * - 本ごとの共通枠は、右ページ用 BookSettings.cropFrame(分割しない1ページ=Wも使う)と、
 *   左ページ用 BookSettings.cropFrameLeft の2つ。どちらも画面で見たままの向きで持つ。
 *   左ページ用が未設定(null)の間は、右ページ用を左右反転して左ページに使う
 *   (綴じ側・小口側の余白は見開きで対称なため。第1回〜の従来の動き)。
 * - ページ単位の調整は pageOverrides["<pdfPage>:<L|R|W>"].crop に、
 *   画面で見たままの向き(反転なし)で持つ。
 * - どちらも「分割後のページ範囲」に対する相対矩形(0〜1)。
 */
export const FULL_RECT: NormRect = { x: 0, y: 0, w: 1, h: 1 };

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function mirrorRect(c: NormRect): NormRect {
  return { x: 1 - c.x - c.w, y: c.y, w: c.w, h: c.h };
}

export function pageCropKey(ref: PageRef): string {
  return `${ref.pdfPage}:${ref.side}`;
}

/** 画面で見たままの向きでの、そのページの余白トリミング(分割後ページに対する相対矩形)。 */
export function effectiveCrop(ref: PageRef, settings: BookSettings): NormRect {
  const own = settings.pageOverrides[pageCropKey(ref)]?.crop;
  if (own) return own;
  return commonFrame(ref.side, settings);
}

/** 共通枠(ページ単位の個別設定は含まない)。画面で見たままの向き */
export function commonFrame(side: PageRef['side'], settings: BookSettings): NormRect {
  if (side === 'L') {
    if (settings.cropFrameLeft) return settings.cropFrameLeft;
    return settings.cropFrame ? mirrorRect(settings.cropFrame) : FULL_RECT;
  }
  return settings.cropFrame ?? FULL_RECT;
}

export function applyCrop(region: NormRect, crop: NormRect): NormRect {
  return {
    x: region.x + region.w * crop.x,
    y: region.y + region.h * crop.y,
    w: region.w * crop.w,
    h: region.h * crop.h,
  };
}

/** 元画像基準の、トリミング後の表示範囲 */
export function croppedRegion(ref: PageRef, settings: BookSettings): NormRect {
  return applyCrop(regionOf(ref, settings), effectiveCrop(ref, settings));
}

export function unionRect(rects: NormRect[]): NormRect {
  const first = rects[0];
  if (!first) return FULL_RECT;
  let x0 = first.x;
  let y0 = first.y;
  let x1 = first.x + first.w;
  let y1 = first.y + first.h;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function marginsToRect(m: Margins): NormRect {
  return { x: m.left, y: m.top, w: 1 - m.left - m.right, h: 1 - m.top - m.bottom };
}

export function rectToMargins(r: NormRect): Margins {
  return { left: r.x, top: r.y, right: 1 - r.x - r.w, bottom: 1 - r.y - r.h };
}

export function isFullRect(r: NormRect, eps = 1e-6): boolean {
  return r.x < eps && r.y < eps && r.w > 1 - eps && r.h > 1 - eps;
}
