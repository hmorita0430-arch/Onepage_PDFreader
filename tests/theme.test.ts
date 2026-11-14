import { describe, expect, it } from 'vitest';
import { parseThemeMode, resolveTheme } from '../src/model/theme';

describe('表示テーマ', () => {
  it('未設定・壊れた値は、従来どおりダーク', () => {
    expect(parseThemeMode(null)).toBe('dark');
    expect(parseThemeMode(undefined)).toBe('dark');
    expect(parseThemeMode('')).toBe('dark');
    expect(parseThemeMode('blue')).toBe('dark');
  });
  it('保存した選択を読める', () => {
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('auto')).toBe('auto');
  });
  it('ダーク・ライトは、端末の設定に関わらずそのとおり', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });
  it('端末に合わせる: 端末がライトならライト、そうでなければダーク', () => {
    expect(resolveTheme('auto', true)).toBe('light');
    expect(resolveTheme('auto', false)).toBe('dark');
  });
});
