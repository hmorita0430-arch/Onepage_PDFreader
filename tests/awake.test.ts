import { describe, expect, it } from 'vitest';
import { AWAKE_OPTIONS, awakeMs, DEFAULT_AWAKE, parseAwakeMode } from '../src/model/awake';

describe('画面を点けておく時間', () => {
  it('初期値は15分', () => {
    expect(DEFAULT_AWAKE).toBe('15');
    expect(parseAwakeMode(null)).toBe('15');
    expect(parseAwakeMode(undefined)).toBe('15');
  });
  it('保存した選択を読める。壊れた値は初期値', () => {
    for (const o of AWAKE_OPTIONS) expect(parseAwakeMode(o.value)).toBe(o.value);
    expect(parseAwakeMode('999')).toBe('15');
    expect(parseAwakeMode('')).toBe('15');
    expect(parseAwakeMode('forever')).toBe('15');
  });
  it('時間(ミリ秒): 5・15・30分、標準は0(点けておかない)、ずっとは null', () => {
    expect(awakeMs('5')).toBe(5 * 60_000);
    expect(awakeMs('15')).toBe(15 * 60_000);
    expect(awakeMs('30')).toBe(30 * 60_000);
    expect(awakeMs('standard')).toBe(0);
    expect(awakeMs('always')).toBeNull();
  });
  it('選択肢は5つ。標準・5・15・30分・ずっと', () => {
    expect(AWAKE_OPTIONS.map((o) => o.value)).toEqual(['standard', '5', '15', '30', 'always']);
  });
});
