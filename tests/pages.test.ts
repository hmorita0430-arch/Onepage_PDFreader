import { describe, expect, it } from 'vitest';
import { buildPageList, clampIndex, findIndex, formatPageLabel, regionOf } from '../src/model/pages';
import { keyAction, tapZone } from '../src/model/tap';
import { DEFAULT_SETTINGS, type BookSettings } from '../src/model/types';

const s = (over: Partial<BookSettings> = {}): BookSettings => ({
  ...DEFAULT_SETTINGS,
  pageOverrides: {},
  ...over,
});

describe('buildPageList', () => {
  it('右開きは各見開きを 右→左 の順に並べる', () => {
    const list = buildPageList(2, s());
    expect(list.map((l) => `${l.ref.pdfPage}${l.ref.side}`)).toEqual(['1R', '1L', '2R', '2L']);
  });

  it('左開きは 左→右', () => {
    const list = buildPageList(1, s({ openDirection: 'ltr' }));
    expect(list.map((l) => l.ref.side)).toEqual(['L', 'R']);
  });

  it('1枚目が片側のみ(表紙)なら、その側だけを含める', () => {
    const list = buildPageList(2, s({ firstPage: 'R' }));
    expect(list.map((l) => `${l.ref.pdfPage}${l.ref.side}`)).toEqual(['1R', '2R', '2L']);
  });

  it('ページ単位の「分割しない」上書きは全体1ページになる', () => {
    const list = buildPageList(2, s({ pageOverrides: { '2': { split: false } } }));
    expect(list.map((l) => `${l.ref.pdfPage}${l.ref.side}`)).toEqual(['1R', '1L', '2W']);
  });

  it('index は 0 始まりの連番', () => {
    expect(buildPageList(3, s()).map((l) => l.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('regionOf', () => {
  it('既定は中心で左右に分割する', () => {
    expect(regionOf({ pdfPage: 1, side: 'L' }, s())).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(regionOf({ pdfPage: 1, side: 'R' }, s())).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('本ごとの分割位置と、ページ単位の分割位置を反映する', () => {
    const settings = s({ splitPosition: 0.48, pageOverrides: { '3': { splitPosition: 0.52 } } });
    expect(regionOf({ pdfPage: 1, side: 'R' }, settings).x).toBe(0.48);
    expect(regionOf({ pdfPage: 3, side: 'L' }, settings).w).toBe(0.52);
  });

  it('W は全体', () => {
    expect(regionOf({ pdfPage: 1, side: 'W' }, s())).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('findIndex / clampIndex', () => {
  const list = buildPageList(3, s());
  it('物理位置から論理位置を探す', () => {
    expect(findIndex(list, { pdfPage: 2, side: 'L' })).toBe(3);
  });
  it('設定変更で消えた位置は同じPDFページの先頭にフォールバック', () => {
    const cover = buildPageList(3, s({ firstPage: 'R' }));
    expect(findIndex(cover, { pdfPage: 1, side: 'L' })).toBe(0);
  });
  it('範囲外は端に丸める', () => {
    expect(clampIndex(list, -5)).toBe(0);
    expect(clampIndex(list, 99)).toBe(5);
  });
});

describe('formatPageLabel', () => {
  it('印刷番号の設定が無ければ通し番号のみ', () => {
    expect(formatPageLabel(0, s())).toBe('通し番号1');
  });
  it('通し番号8=印刷p.1 のとき、通し番号52 は p.45', () => {
    const settings = s({ printedNumber: { serial: 8, printed: 1 } });
    expect(formatPageLabel(51, settings)).toBe('p.45(通し番号52)');
  });
});

describe('印刷番号が1未満のページ', () => {
  it('表紙・前付けには印刷番号を付けない', () => {
    const settings = s({ printedNumber: { serial: 8, printed: 1 } });
    expect(formatPageLabel(0, settings)).toBe('通し番号1');
    expect(formatPageLabel(7, settings)).toBe('p.1(通し番号8)');
  });
});

describe('tapZone / keyAction', () => {
  it('右開き: 帯の下では、左端=次、右端=前、中央=中央', () => {
    expect(tapZone(0.1, 0.5, 'rtl')).toBe('next');
    expect(tapZone(0.9, 0.5, 'rtl')).toBe('prev');
    expect(tapZone(0.5, 0.5, 'rtl')).toBe('center');
  });
  it('左開き: 右端=次、左端=前', () => {
    expect(tapZone(0.9, 0.5, 'ltr')).toBe('next');
    expect(tapZone(0.1, 0.5, 'ltr')).toBe('prev');
  });
  it('上部の帯(上20%)は、左右の端でも、メニュー(ページ送りにならない)', () => {
    for (const x of [0.02, 0.1, 0.5, 0.9, 0.98]) expect(tapZone(x, 0.1, 'rtl')).toBe('band');
    expect(tapZone(0.05, 0.0, 'rtl')).toBe('band'); // 左上の角
    expect(tapZone(0.95, 0.0, 'ltr')).toBe('band'); // 右上の角
  });
  it('帯の境界(20%)ちょうどから下は、通常の領域', () => {
    expect(tapZone(0.1, 0.1999, 'rtl')).toBe('band');
    expect(tapZone(0.1, 0.2, 'rtl')).toBe('next');
    expect(tapZone(0.5, 0.2, 'rtl')).toBe('center');
  });
  it('左右の境界(25%)ちょうどは中央扱い', () => {
    expect(tapZone(0.25, 0.5, 'rtl')).toBe('center');
    expect(tapZone(0.75, 0.5, 'rtl')).toBe('center');
    expect(tapZone(0.2499, 0.5, 'rtl')).toBe('next');
  });
  it('キー操作は開き方向に連動し、Home/End は先頭/末尾', () => {
    expect(keyAction('ArrowLeft', 'rtl')).toBe('next');
    expect(keyAction('ArrowLeft', 'ltr')).toBe('prev');
    expect(keyAction('Home', 'rtl')).toBe('first');
    expect(keyAction('End', 'ltr')).toBe('last');
    expect(keyAction('a', 'rtl')).toBeNull();
  });
});
