import type { ExportDestination } from '../drive/output';

/**
 * 読書ノートの書き出し先(利用者がドライブ上で選んだフォルダ)。
 * アプリ全体で1つ。この端末の中に保存する(端末間では同期しない)。
 * 未設定なら、既定のマイドライブ/読書ノート。
 */
const KEY = 'export-destination:v1';

export function loadDestination(): ExportDestination | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ExportDestination>;
    return typeof d.id === 'string' && d.id !== '' && typeof d.name === 'string' ? { id: d.id, name: d.name } : null;
  } catch {
    return null; // 壊れていれば既定として扱う
  }
}

export function saveDestination(d: ExportDestination): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ id: d.id, name: d.name }));
  } catch {
    /* 保存できなくても、この回は反映される */
  }
}

export function clearDestination(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 何もしない */
  }
}

/** 画面に出す保存先の説明 */
export function describeDestination(d: ExportDestination | null): string {
  return d ? `${d.name}(選んだフォルダ)/本の名前/` : 'マイドライブ/読書ノート/本の名前/(既定)';
}
