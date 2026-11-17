import { describe, expect, it } from 'vitest';
import {
  clampPct,
  DEFAULT_EYE,
  isEyeActive,
  MAX_PAPER_OPACITY,
  MAX_WARM_OPACITY,
  paperOpacity,
  parseEyeComfort,
  RECOMMENDED_EYE,
  toggleEye,
  warmOpacity,
  withStrength,
} from '../src/model/eyecomfort';

describe('目に優しい表示', () => {
  it('初期はオフ(強さ0)。効いていない', () => {
    expect(DEFAULT_EYE).toEqual({ on: true, warm: 0, paper: 0 });
    expect(isEyeActive(DEFAULT_EYE)).toBe(false);
    expect(warmOpacity(DEFAULT_EYE)).toBe(0);
    expect(paperOpacity(DEFAULT_EYE)).toBe(0);
  });
  it('強さは0〜100に丸める。数でない値は0', () => {
    expect(clampPct(150)).toBe(100);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(33.6)).toBe(34);
    expect(clampPct(NaN)).toBe(0);
    expect(clampPct('x')).toBe(0);
  });
  it('保存値の読み取り: 壊れた値は初期値。範囲外は丸める', () => {
    expect(parseEyeComfort(null)).toEqual(DEFAULT_EYE);
    expect(parseEyeComfort('x')).toEqual(DEFAULT_EYE);
    expect(parseEyeComfort('{"on":false,"warm":40,"paper":999}')).toEqual({ on: false, warm: 40, paper: 100 });
    expect(parseEyeComfort('{"warm":"a"}')).toEqual({ on: true, warm: 0, paper: 0 });
  });
  it('不透明度: 強さに比例し、100%でも上限を超えない(読めなくならない)', () => {
    const full = { on: true, warm: 100, paper: 100 };
    expect(warmOpacity(full)).toBe(MAX_WARM_OPACITY);
    expect(paperOpacity(full)).toBe(MAX_PAPER_OPACITY);
    expect(warmOpacity({ on: true, warm: 50, paper: 0 })).toBe(MAX_WARM_OPACITY / 2);
    expect(MAX_WARM_OPACITY).toBeLessThan(1);
  });
  it('切っているとき(on=false)は、強さが残っていても、効かない', () => {
    const off = { on: false, warm: 60, paper: 60 };
    expect(isEyeActive(off)).toBe(false);
    expect(warmOpacity(off)).toBe(0);
    expect(paperOpacity(off)).toBe(0);
  });
  it('ボタン: 効いていれば切る(強さは残す)。切っていれば、前回の強さでオンにする', () => {
    const on = { on: true, warm: 20, paper: 10 };
    const off = toggleEye(on);
    expect(off).toEqual({ on: false, warm: 20, paper: 10 });
    expect(toggleEye(off)).toEqual(on);
  });
  it('ボタン: 強さが両方0のまま入れると、おすすめの強さになる', () => {
    expect(toggleEye(DEFAULT_EYE)).toEqual({ on: true, ...RECOMMENDED_EYE });
    expect(toggleEye({ on: false, warm: 0, paper: 0 })).toEqual({ on: true, ...RECOMMENDED_EYE });
  });
  it('スライダーを動かすと、切っていてもオンになる。もう一方の強さは変わらない', () => {
    expect(withStrength({ on: false, warm: 0, paper: 30 }, 'warm', 45)).toEqual({ on: true, warm: 45, paper: 30 });
    expect(withStrength(DEFAULT_EYE, 'paper', 120)).toEqual({ on: true, warm: 0, paper: 100 });
  });
  it('両方を0に戻すと、効かなくなる', () => {
    const e = withStrength(withStrength(DEFAULT_EYE, 'warm', 30), 'warm', 0);
    expect(isEyeActive(e)).toBe(false);
  });
});
