import { describe, expect, it } from 'vitest';
import { clampState, DOUBLE_TAP_Z, fitSize, isZoomed, layout, panBy, RESET_VIEW, zoomAt } from '../src/reader/view';

const box = { w: 400, h: 800 };
const fit = { w: 400, h: 600 }; // 幅いっぱい、上下に余り

describe('fitSize', () => {
  it('箱に収まる最大サイズ(縦横比維持)', () => {
    expect(fitSize({ w: 400, h: 800 }, { w: 600, h: 900 })).toEqual({ w: 400, h: 600 });
    const f = fitSize({ w: 1000, h: 500 }, { w: 600, h: 900 });
    expect(f.w).toBeCloseTo(500 * (600 / 900), 6);
    expect(f.h).toBeCloseTo(500, 6);
  });
});

describe('layout / clampState', () => {
  it('フィット表示では中央に置く', () => {
    expect(layout(box, fit, RESET_VIEW)).toEqual({ tx: 0, ty: 100, scale: 1 });
  });
  it('拡大してもはみ出さない範囲に収まる', () => {
    const st = clampState(box, fit, { z: 3, cx: 0, cy: 0 });
    const l = layout(box, fit, st);
    expect(l.tx).toBeLessThanOrEqual(0);
    expect(l.tx).toBeGreaterThanOrEqual(box.w - fit.w * 3);
    expect(l.ty).toBeLessThanOrEqual(0);
  });
  it('倍率は 1〜6 に丸める', () => {
    expect(clampState(box, fit, { z: 0.2, cx: 0.5, cy: 0.5 }).z).toBe(1);
    expect(clampState(box, fit, { z: 99, cx: 0.5, cy: 0.5 }).z).toBe(6);
  });
  it('ページが画面より小さい軸は中央(0.5)に戻る', () => {
    const st = clampState(box, fit, { z: 1.2, cx: 0.9, cy: 0.9 });
    expect(st.cy).toBe(0.5); // 600*1.2=720 < 800
  });
});

describe('zoomAt', () => {
  it('指定した点がズーム前後で動かない', () => {
    const before = { z: 2, cx: 0.5, cy: 0.5 };
    const p = { x: 300, y: 200 };
    const l0 = layout(box, fit, before);
    const n = { x: (p.x - l0.tx) / (fit.w * 2), y: (p.y - l0.ty) / (fit.h * 2) };
    const after = zoomAt(box, fit, before, 3.5, p.x, p.y);
    const l1 = layout(box, fit, after);
    expect((p.x - l1.tx) / (fit.w * 3.5)).toBeCloseTo(n.x, 6);
    expect((p.y - l1.ty) / (fit.h * 3.5)).toBeCloseTo(n.y, 6);
  });
  it('ダブルタップの倍率でも範囲内に収まり、1に戻すと中央に戻る', () => {
    const zoomed = zoomAt(box, fit, RESET_VIEW, DOUBLE_TAP_Z, 390, 10);
    expect(isZoomed(zoomed)).toBe(true);
    const back = zoomAt(box, fit, zoomed, 1, 200, 400);
    expect(back).toEqual({ z: 1, cx: 0.5, cy: 0.5 });
  });
});

describe('panBy', () => {
  it('指の移動方向にページが動く(中心の相対位置は逆向きに動く)', () => {
    const st = { z: 3, cx: 0.5, cy: 0.5 };
    const moved = panBy(box, fit, st, 100, 0);
    expect(moved.cx).toBeLessThan(0.5);
  });
  it('端で止まる', () => {
    const st = { z: 2, cx: 0.5, cy: 0.5 };
    const moved = panBy(box, fit, st, 99999, 99999);
    const l = layout(box, fit, moved);
    expect(l.tx).toBe(0);
    expect(l.ty).toBe(0);
  });
});

describe('ズーム維持: 相対位置の引き継ぎ(D-9)', () => {
  it('縦横比が違う次のページでも、同じ倍率・同じ相対位置が表示される', () => {
    const st = { z: 2.5, cx: 0.6, cy: 0.3 };
    const fitB = { w: 300, h: 800 }; // 別の形のページ
    const kept = clampState(box, fitB, st);
    expect(kept.z).toBe(2.5);
    expect(kept.cx).toBeCloseTo(0.6, 6);
    expect(kept.cy).toBeCloseTo(0.3, 6);
  });

  it('到達できない位置(端の外)は、到達できる最も近い位置に寄る', () => {
    const kept = clampState(box, { w: 300, h: 800 }, { z: 2.5, cx: 0.8, cy: 0.5 });
    expect(kept.cx).toBeCloseTo(1 - 400 / 2 / (300 * 2.5), 6); // 中心が取れる上限
  });
});
