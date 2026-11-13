import { describe, expect, it } from 'vitest';
import { applyCrop, effectiveCrop, marginsToRect, mirrorRect, pageCropKey, rectToMargins, unionRect } from '../src/model/crop';
import { formatShownLabel, groupAt, nextIndex, normalizeIndex, prevIndex, sheetRange } from '../src/model/layout';
import { buildPageList } from '../src/model/pages';
import { DEFAULT_SETTINGS, type BookSettings } from '../src/model/types';

const s = (over: Partial<BookSettings> = {}): BookSettings => ({ ...DEFAULT_SETTINGS, pageOverrides: {}, ...over });

describe('余白トリミング(D-5)', () => {
  const frame = { x: 0.1, y: 0.05, w: 0.8, h: 0.9 }; // 右ページ基準

  it('共通枠は右ページにそのまま、左ページには左右反転で適用する', () => {
    const settings = s({ cropFrame: frame });
    expect(effectiveCrop({ pdfPage: 1, side: 'R' }, settings)).toEqual(frame);
    const left = effectiveCrop({ pdfPage: 1, side: 'L' }, settings);
    expect(left.x).toBeCloseTo(0.1, 9); // 1 - 0.1 - 0.8 = 0.1(この枠は左右対称)
    const asym = s({ cropFrame: { x: 0.2, y: 0, w: 0.7, h: 1 } });
    expect(effectiveCrop({ pdfPage: 1, side: 'L' }, asym).x).toBeCloseTo(0.1, 9);
  });

  it('ページ単位の調整は共通枠より優先され、反転しない', () => {
    const own = { x: 0.3, y: 0, w: 0.6, h: 1 };
    const settings = s({ cropFrame: frame, pageOverrides: { [pageCropKey({ pdfPage: 2, side: 'L' })]: { crop: own } } });
    expect(effectiveCrop({ pdfPage: 2, side: 'L' }, settings)).toEqual(own);
    expect(effectiveCrop({ pdfPage: 2, side: 'R' }, settings)).toEqual(frame);
  });

  it('枠が無ければ全体', () => {
    expect(effectiveCrop({ pdfPage: 1, side: 'R' }, s())).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('分割後ページの相対矩形を元画像基準に直す', () => {
    const region = { x: 0.5, y: 0, w: 0.5, h: 1 };
    const r = applyCrop(region, { x: 0.2, y: 0.1, w: 0.6, h: 0.8 });
    expect(r.x).toBeCloseTo(0.6);
    expect(r.w).toBeCloseTo(0.3);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.h).toBeCloseTo(0.8);
  });

  it('余白(%)と矩形の相互変換・反転', () => {
    const m = { top: 0.05, right: 0.1, bottom: 0.02, left: 0.2 };
    expect(rectToMargins(marginsToRect(m))).toEqual({
      top: 0.05, right: expect.closeTo(0.1, 9), bottom: expect.closeTo(0.02, 9), left: 0.2,
    });
    expect(mirrorRect(mirrorRect({ x: 0.2, y: 0, w: 0.7, h: 1 })).x).toBeCloseTo(0.2, 9);
  });

  it('unionRect', () => {
    expect(unionRect([{ x: 0.0, y: 0.1, w: 0.4, h: 0.8 }, { x: 0.6, y: 0.0, w: 0.4, h: 0.9 }])).toEqual({
      x: 0, y: 0, w: 1, h: expect.closeTo(0.9, 9),
    });
  });
});

describe('2ページ表示(D-6): 撮影した見開きのまま並べる', () => {
  const list = buildPageList(3, s());

  it('1ページ表示は論理ページ1件、2ページ表示は同じ見開きの2件', () => {
    expect(groupAt(list, 0, false, s())?.indices).toEqual([0]);
    expect(groupAt(list, 0, true, s())?.indices).toEqual([0, 1]);
  });

  it('2ページ表示の描画範囲は、左右のトリミング範囲を含む連続した矩形', () => {
    const settings = s({ cropFrame: { x: 0.1, y: 0.05, w: 0.85, h: 0.9 } });
    const shown = groupAt(list, 0, true, settings);
    expect(shown?.spec.pdfPage).toBe(1);
    const r = shown?.spec.region;
    expect(r?.x).toBeGreaterThan(0);
    expect(r?.x).toBeLessThan(0.1);
    expect((r?.x ?? 0) + (r?.w ?? 0)).toBeLessThan(1);
    expect(r?.y).toBeCloseTo(0.05);
  });

  it('表紙が片側だけの見開きは、その1ページだけを出す', () => {
    const cover = buildPageList(2, s({ firstPage: 'R' }));
    expect(groupAt(cover, 0, true, s({ firstPage: 'R' }))?.indices).toEqual([0]);
    expect(groupAt(cover, 1, true, s({ firstPage: 'R' }))?.indices).toEqual([1, 2]);
  });

  it('ページ送りは見開き単位。端では動かない', () => {
    expect(nextIndex(list, 0, true)).toBe(2);
    expect(nextIndex(list, 2, true)).toBe(4);
    expect(nextIndex(list, 4, true)).toBe(4);
    expect(prevIndex(list, 4, true)).toBe(2);
    expect(prevIndex(list, 0, true)).toBe(0);
    expect(nextIndex(list, 1, false)).toBe(2);
  });

  it('見開きの2枚目にいても先頭に揃える', () => {
    expect(normalizeIndex(list, 3, true)).toBe(2);
    expect(sheetRange(list, 3)).toEqual([2, 3]);
    expect(normalizeIndex(list, 3, false)).toBe(3);
  });

  it('ラベル: 範囲で表示する', () => {
    expect(formatShownLabel([2, 3], s())).toBe('通し番号3–4');
    const settings = s({ printedNumber: { serial: 3, printed: 1 } });
    expect(formatShownLabel([2, 3], settings)).toBe('p.1–2(通し番号3–4)');
    expect(formatShownLabel([5], settings)).toBe('p.4(通し番号6)');
  });
});
