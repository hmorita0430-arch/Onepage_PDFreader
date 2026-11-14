/** 表示テーマ(アプリ全体で1つ。端末内に保存する)。 */
export type ThemeMode = 'dark' | 'light' | 'auto';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_KEY = 'theme:v1';
/** theme-color(ブラウザのバーの色)。style.css の --bg と合わせる */
export const THEME_COLOR: Record<ResolvedTheme, string> = { dark: '#1b1b1f', light: '#f5f4f0' };

/** 保存値から、テーマの選択を読む。未設定・壊れた値は、従来どおりのダーク */
export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return raw === 'light' || raw === 'auto' ? raw : 'dark';
}

/** 選択(ダーク/ライト/端末に合わせる)と、端末の設定から、実際に使うテーマを決める */
export function resolveTheme(mode: ThemeMode, systemPrefersLight: boolean): ResolvedTheme {
  if (mode === 'auto') return systemPrefersLight ? 'light' : 'dark';
  return mode;
}
