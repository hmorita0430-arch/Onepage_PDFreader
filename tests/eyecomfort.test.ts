import { describe, expect, it } from 'vitest';
import {
  clampPct,
  DEFAULT_EYE,
  isEyeActive,
  MAX_PAPER_OPACITY,
  MAX_WARM_OPACITY,
  paperOpacity,
  parseEyeComfort,
  warmOpacity,
  withStrength,
} from '../src/model/eyecomfort';

describe('目に優しい表示', () => {
  it('初期はオフ(強さ0)。効いていない', () => {
    expect(DEFAULT_EYE).toEqual({ warm: 0, paper: 0 });
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
    expect(parseEyeComfort('{"warm":40,"paper":999}')).toEqual({ warm: 40, paper: 100 });
    expect(parseEyeComfort('{"warm":"a"}')).toEqual({ warm: 0, paper: 0 });
  });
  it('以前の版で「切っている」状態(on=false)で保存された値は、オフとして読む', () => {
    expect(parseEyeComfort('{"on":false,"warm":60,"paper":60}')).toEqual({ warm: 0, paper: 0 });
    expect(parseEyeComfort('{"on":true,"warm":60,"paper":20}')).toEqual({ warm: 60, paper: 20 });
  });
  it('不透明度: 強さに比例し、100%でも上限を超えない(読めなくならない)', () => {
    const full = { warm: 100, paper: 100 };
    expect(warmOpacity(full)).toBe(MAX_WARM_OPACITY);
    expect(paperOpacity(full)).toBe(MAX_PAPER_OPACITY);
    expect(warmOpacity({ warm: 50, paper: 0 })).toBe(MAX_WARM_OPACITY / 2);
    expect(MAX_WARM_OPACITY).toBeLessThan(1);
  });
  it('スライダーを動かすと、その強さだけが変わる', () => {
    expect(withStrength({ warm: 0, paper: 30 }, 'warm', 45)).toEqual({ warm: 45, paper: 30 });
    expect(withStrength(DEFAULT_EYE, 'paper', 120)).toEqual({ warm: 0, paper: 100 });
  });
  it('両方を0に戻すと、効かなくなる', () => {
    const e = withStrength(withStrength(DEFAULT_EYE, 'warm', 30), 'warm', 0);
    expect(isEyeActive(e)).toBe(false);
  });
});
