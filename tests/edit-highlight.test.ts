import { describe, expect, it } from 'vitest';
import {
  addRect,
  addStroke,
  geometryCenter,
  geometryOf,
  movedGeometry,
  resizedRect,
  setAnnotationGeometry,
  stretchedStroke,
  addMemo,
} from '../src/model/annotations';
import {
  applyOffset,
  averageOffset,
  clampOffset,
  describeOffset,
  isNoOffset,
  MAX_OFFSET_PX,
  parseOffset,
  spread,
} from '../src/model/touchoffset';
import type { HighlightRect, HighlightStroke, Memo } from '../src/model/types';

const page = { w: 2000, h: 1500 };
const R = { pdfPage: 1, side: 'R' as const };

describe('蛍光ペンを動かす', () => {
  it('四角: 指定した量だけ動く。大きさは変わらない', () => {
    const a = addRect([], { page: R, color: 'yellow', rect: { x: 0.5, y: 0.2, w: 0.2, h: 0.1 } }, 1, 'r')[0]!;
    const g = movedGeometry(a, 0.1, -0.05)!;
    expect('rect' in g && g.rect).toEqual({ x: 0.6, y: 0.15000000000000002, w: 0.2, h: 0.1 });
  });
  it('四角: ページの外へはみ出さない', () => {
    const a = addRect([], { page: R, color: 'yellow', rect: { x: 0.5, y: 0.2, w: 0.2, h: 0.1 } }, 1, 'r')[0]!;
    const g = movedGeometry(a, 0.9, 0.9)!;
    expect('rect' in g && g.rect.x + g.rect.w).toBeCloseTo(1, 9);
    expect('rect' in g && g.rect.y + g.rect.h).toBeCloseTo(1, 9);
    const g2 = movedGeometry(a, -0.9, -0.9)!;
    expect('rect' in g2 && g2.rect.x).toBe(0);
    expect('rect' in g2 && g2.rect.y).toBe(0);
  });
  it('なぞった線: すべての点が動き、形は変わらない。端がはみ出す量は、全体で止める', () => {
    const a = addStroke([], { page: R, color: 'pink', points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.52 }, { x: 0.7, y: 0.5 }] }, 1, 's')[0]!;
    const g = movedGeometry(a, 0.1, 0.1)!;
    expect('points' in g && g.points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])).toEqual([[0.6, 0.6], [0.7, 0.62], [0.8, 0.6]]);
    const g2 = movedGeometry(a, 0.9, 0)!;
    expect('points' in g2 && Math.max(...g2.points.map((p) => p.x))).toBeCloseTo(1, 9);
    expect('points' in g2 && g2.points[1]!.x - g2.points[0]!.x).toBeCloseTo(0.1, 9); // 形は保つ
  });
  it('メモ: 指定した量だけ動く。ページの外へは出ない', () => {
    const m = addMemo([], { page: R, at: { x: 0.5, y: 0.5 }, text: 'x' }, 1, 'm')[0]!;
    expect(movedGeometry(m, 0.1, -0.2)).toEqual({ at: { x: 0.6, y: 0.3 } });
    expect(movedGeometry(m, 9, 9)).toEqual({ at: { x: 1, y: 1 } });
    expect(movedGeometry(m, -9, -9)).toEqual({ at: { x: 0, y: 0 } });
    expect(geometryOf(m)).toEqual({ at: { x: 0.5, y: 0.5 } });
  });
  it('メモを動かしても、本文は変わらない。更新日時が進む。左右をまたいだら、ページ(側)も替わる', () => {
    const list = addMemo([], { page: R, at: { x: 0.8, y: 0.5 }, text: '大事な文章' }, 100, 'm');
    const out = setAnnotationGeometry(list, 'm', { at: { x: 0.2, y: 0.6 } }, 200, { pdfPage: 1, side: 'L' });
    const a = out[0] as Memo;
    expect(a.text).toBe('大事な文章');
    expect(a.at).toEqual({ x: 0.2, y: 0.6 });
    expect(a.page).toEqual({ pdfPage: 1, side: 'L' });
    expect(a.updatedAt).toBe(200);
    // ページを渡さなければ、ページは変えない
    expect((setAnnotationGeometry(list, 'm', { at: { x: 0.7, y: 0.5 }, }, 300)[0] as Memo).page.side).toBe('R');
  });
  it('蛍光ペンも、ページ(側)を置き換えられる(動かして、左右をまたいだとき)', () => {
    const list = addRect([], { page: R, color: 'yellow', rect: { x: 0.6, y: 0.2, w: 0.1, h: 0.1 } }, 1, 'r');
    const out = setAnnotationGeometry(list, 'r', { rect: { x: 0.1, y: 0.2, w: 0.1, h: 0.1 } }, 5, { pdfPage: 1, side: 'L' });
    expect(out[0]!.page.side).toBe('L');
  });
  it('形の中心: 四角・線・メモ', () => {
    expect(geometryCenter({ rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.4 } })).toEqual({ x: 0.30000000000000004, y: 0.4 });
    expect(geometryCenter({ at: { x: 0.3, y: 0.7 } })).toEqual({ x: 0.3, y: 0.7 });
    expect(geometryCenter({ points: [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.6 }] })).toEqual({ x: 0.3, y: 0.55 });
  });
});

describe('四角の角を動かす', () => {
  const r = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
  it('右下の角: 左上は動かない', () => {
    expect(resizedRect(r, 'se', { x: 0.8, y: 0.6 })).toEqual({ x: 0.4, y: 0.4, w: 0.4, h: 0.19999999999999996 });
  });
  it('左上の角: 右下は動かない', () => {
    const out = resizedRect(r, 'nw', { x: 0.3, y: 0.3 });
    expect(out.x).toBeCloseTo(0.3, 9);
    expect(out.y).toBeCloseTo(0.3, 9);
    expect(out.x + out.w).toBeCloseTo(0.6, 9);
    expect(out.y + out.h).toBeCloseTo(0.5, 9);
  });
  it('反対側を越えて動かすと、裏返った四角になる(常に正の大きさ)', () => {
    const out = resizedRect(r, 'se', { x: 0.2, y: 0.2 });
    expect(out.x).toBeCloseTo(0.2, 9);
    expect(out.w).toBeCloseTo(0.2, 9);
    expect(out.h).toBeGreaterThan(0);
  });
  it('ページの外へは出ない。大きさが0にならない', () => {
    const out = resizedRect(r, 'se', { x: 5, y: -3 });
    expect(out.x + out.w).toBeLessThanOrEqual(1);
    expect(out.y).toBeGreaterThanOrEqual(0);
    const tiny = resizedRect(r, 'se', { x: 0.4, y: 0.4 });
    expect(tiny.w).toBeGreaterThan(0);
    expect(tiny.h).toBeGreaterThan(0);
  });
});

describe('線の端を伸ばす・縮める', () => {
  const line = [{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0.5 }]; // 横にまっすぐ
  it('終点を右へ伸ばすと、始点は動かず、終点が指の位置に来る。途中の点は比例して広がる', () => {
    const out = stretchedStroke(line, 'end', { x: 0.6, y: 0.5 }, page);
    expect(out[0]!.x).toBeCloseTo(0.2, 9);
    expect(out[2]!.x).toBeCloseTo(0.6, 9);
    expect(out[1]!.x).toBeCloseTo(0.4, 9);
    expect(out.every((p) => Math.abs(p.y - 0.5) < 1e-9)).toBe(true);
  });
  it('終点を左へ縮めると、短くなる', () => {
    const out = stretchedStroke(line, 'end', { x: 0.3, y: 0.5 }, page);
    expect(out[2]!.x).toBeCloseTo(0.3, 9);
    expect(out[1]!.x).toBeCloseTo(0.25, 9);
  });
  it('始点をつかむと、終点は動かない', () => {
    const out = stretchedStroke(line, 'start', { x: 0.1, y: 0.5 }, page);
    expect(out[2]!.x).toBeCloseTo(0.4, 9);
    expect(out[0]!.x).toBeCloseTo(0.1, 9);
  });
  it('指を斜めに動かすと、線全体が、その向きに回る(長さは指の位置まで)', () => {
    const out = stretchedStroke(line, 'end', { x: 0.4, y: 0.6 }, page);
    expect(out[0]!.x).toBeCloseTo(0.2, 9);
    expect(out[0]!.y).toBeCloseTo(0.5, 9);
    expect(out[2]!.x).toBeCloseTo(0.4, 6);
    expect(out[2]!.y).toBeCloseTo(0.6, 6);
  });
  it('点が1つ以下なら、変えない。結果はページの中に収まる', () => {
    expect(stretchedStroke([{ x: 0.5, y: 0.5 }], 'end', { x: 0.9, y: 0.9 }, page)).toEqual([{ x: 0.5, y: 0.5 }]);
    const out = stretchedStroke(line, 'end', { x: 9, y: 9 }, page);
    expect(out.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
  });
  it('元の配列は書き換えない', () => {
    const copy = JSON.stringify(line);
    stretchedStroke(line, 'end', { x: 0.6, y: 0.5 }, page);
    expect(JSON.stringify(line)).toBe(copy);
  });
});

describe('形の置き換え(元に戻す)', () => {
  it('形を置き換えると、更新日時が進む。色・文字・IDは変わらない', () => {
    let list = addRect([], { page: R, color: 'blue', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }, 100, 'r');
    (list[0] as HighlightRect).ocrText = '文字';
    const before = geometryOf(list[0]!)!;
    list = setAnnotationGeometry(list, 'r', { rect: { x: 0.3, y: 0.3, w: 0.2, h: 0.1 } }, 200);
    const a = list[0] as HighlightRect;
    expect(a.rect.x).toBe(0.3);
    expect(a.updatedAt).toBe(200);
    expect(a.color).toBe('blue');
    expect(a.ocrText).toBe('文字');
    list = setAnnotationGeometry(list, 'r', before, 150); // 元に戻す。時刻が古くても、更新日時は進む
    expect((list[0] as HighlightRect).rect.x).toBe(0.1);
    expect(list[0]!.updatedAt).toBe(201);
  });
  it('種類が違う形は、受け付けない(線に四角の形を入れない)', () => {
    const list = addStroke([], { page: R, color: 'pink', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] }, 1, 's');
    const out = setAnnotationGeometry(list, 's', { rect: { x: 0, y: 0, w: 1, h: 1 } }, 5);
    expect((out[0] as HighlightStroke).points).toHaveLength(2);
    expect(out[0]!.updatedAt).toBe(1);
  });
});

describe('描画位置の補正', () => {
  it('狙いと触れた位置の差の平均を、補正にする(左下にずれるなら、右上へ)', () => {
    const samples = [
      { aim: { x: 100, y: 100 }, hit: { x: 94, y: 109 } },
      { aim: { x: 200, y: 300 }, hit: { x: 194, y: 309 } },
      { aim: { x: 300, y: 500 }, hit: { x: 294, y: 509 } },
    ];
    const o = averageOffset(samples);
    expect(o).toEqual({ x: 6, y: -9 });
    expect(describeOffset(o)).toBe('右へ6px・上へ9px');
    expect(applyOffset({ x: 94, y: 109 }, o)).toEqual({ x: 100, y: 100 });
  });
  it('ばらつきが小さいと小さく、大きいと大きい', () => {
    const tight = [
      { aim: { x: 0, y: 0 }, hit: { x: -5, y: 8 } },
      { aim: { x: 0, y: 0 }, hit: { x: -6, y: 9 } },
    ];
    const loose = [
      { aim: { x: 0, y: 0 }, hit: { x: -5, y: 8 } },
      { aim: { x: 0, y: 0 }, hit: { x: 20, y: -15 } },
    ];
    expect(spread(tight)).toBeLessThan(2);
    expect(spread(loose)).toBeGreaterThan(15);
    expect(spread([])).toBe(0);
  });
  it('補正の上限。極端な値は丸める', () => {
    expect(clampOffset({ x: 500, y: -500 })).toEqual({ x: MAX_OFFSET_PX, y: -MAX_OFFSET_PX });
    expect(clampOffset({ x: NaN, y: Infinity })).toEqual({ x: 0, y: 0 }); // 数でない値は0
  });
  it('保存値の読み取り: 壊れた値・形が違う値は、補正なし', () => {
    expect(parseOffset(null)).toEqual({ x: 0, y: 0 });
    expect(parseOffset('x')).toEqual({ x: 0, y: 0 });
    expect(parseOffset('{"x":"a","y":1}')).toEqual({ x: 0, y: 0 });
    expect(parseOffset('{"x":6,"y":-9.04}')).toEqual({ x: 6, y: -9 });
    expect(isNoOffset(parseOffset('{"x":0,"y":0}'))).toBe(true);
  });
  it('補正なしの説明', () => {
    expect(describeOffset({ x: 0, y: 0 })).toBe('補正なし');
    expect(describeOffset({ x: -4, y: 0 })).toBe('左へ4px');
  });
});

describe('動かせる範囲(いま表示している範囲)', () => {
  const region = { x: 0.5, y: 0, w: 0.5, h: 1 }; // 見開きの右ページだけを表示
  it('四角: 表示している範囲の外へは、動かせない(左ページへ消えない)', () => {
    const a = addRect([], { page: R, color: 'yellow', rect: { x: 0.6, y: 0.2, w: 0.1, h: 0.1 } }, 1, 'r')[0]!;
    const g = movedGeometry(a, -0.5, 0, region)!;
    expect('rect' in g && g.rect.x).toBeCloseTo(0.5, 9);
    const g2 = movedGeometry(a, 0.9, 0, region)!;
    expect('rect' in g2 && g2.rect.x + g2.rect.w).toBeCloseTo(1, 9);
  });
  it('メモ・線も、表示している範囲の中に収まる', () => {
    const m = addMemo([], { page: R, at: { x: 0.6, y: 0.5 }, text: 'x' }, 1, 'm')[0]!;
    expect(movedGeometry(m, -0.4, 0, region)).toEqual({ at: { x: 0.5, y: 0.5 } });
    const s = addStroke([], { page: R, color: 'pink', points: [{ x: 0.6, y: 0.5 }, { x: 0.8, y: 0.5 }] }, 1, 's')[0]!;
    const g = movedGeometry(s, -0.4, 0, region)!;
    expect('points' in g && Math.min(...g.points.map((p) => p.x))).toBeCloseTo(0.5, 9);
  });
  it('角・端を引いても、表示している範囲の外には出ない', () => {
    const out = resizedRect({ x: 0.6, y: 0.2, w: 0.2, h: 0.1 }, 'nw', { x: 0.1, y: 0.1 }, region);
    expect(out.x).toBeGreaterThanOrEqual(0.5 - 1e-9);
    const st = stretchedStroke([{ x: 0.6, y: 0.5 }, { x: 0.7, y: 0.5 }], 'start', { x: 0.1, y: 0.5 }, page, region);
    expect(Math.min(...st.map((p) => p.x))).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });
});
