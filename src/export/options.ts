/**
 * 書き出しの設定: ページ画像も書き出すか(アプリ全体で1つ。この端末内に保存し、端末間では同期しない)。
 * 既定は「書き出す」(これまでの動き)。
 */
const KEY = 'export-images:v1';

export function loadIncludeImages(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveIncludeImages(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* 保存できなくても、この回は反映される */
  }
}
