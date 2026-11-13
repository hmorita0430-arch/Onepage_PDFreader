import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type BookSettingsKey,
  type BookSyncDocument,
} from '../model/types';

/**
 * 同期の統合規則(要件定義書 4章)。DOM・通信に依存しない純粋関数。
 * - 注釈・名前つきページ: 1件ごとの ID と更新日時で統合。両端末の分は両方残し、
 *   同じ1件を両方で編集した場合は新しい方。削除は deleted の印(墓標)を残して伝える。
 * - 最後に読んだ位置: 日時が新しい方。
 * - 本ごとの設定: 項目ごとに新しい方。
 * どの順序で統合しても同じ結果になる(可換・冪等・結合的)ように、同時刻は内容の比較で決める。
 */

export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

function pickNewer<T extends { updatedAt: number }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b; // 同時刻は内容で決め、順序に依存させない
}

interface Item {
  id: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export function mergeItems<T extends Item>(a: readonly T[], b: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const cur = map.get(item.id);
    map.set(item.id, cur ? pickNewer(cur, item) : item);
  }
  return [...map.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function mergeDocuments(a: BookSyncDocument, b: BookSyncDocument): BookSyncDocument {
  if (a.bookId !== b.bookId) throw new Error('別の本のデータは統合できません');

  const keys = new Set<BookSettingsKey>([
    ...(Object.keys(DEFAULT_SETTINGS) as BookSettingsKey[]),
    ...(Object.keys(a.settings) as BookSettingsKey[]),
    ...(Object.keys(b.settings) as BookSettingsKey[]),
  ]);
  const settings: Record<string, unknown> = {};
  const settingsUpdatedAt: Partial<Record<BookSettingsKey, number>> = {};
  for (const key of keys) {
    const ta = a.settingsUpdatedAt[key] ?? 0;
    const tb = b.settingsUpdatedAt[key] ?? 0;
    const useA =
      ta !== tb ? ta > tb : stableStringify(a.settings[key]) >= stableStringify(b.settings[key]);
    const src = useA ? a : b;
    settings[key] = src.settings[key] ?? DEFAULT_SETTINGS[key];
    const t = Math.max(ta, tb);
    if (t > 0) settingsUpdatedAt[key] = t;
  }

  const position = !a.position ? b.position : !b.position ? a.position : pickNewer(a.position, b.position);

  return {
    schemaVersion: SCHEMA_VERSION,
    bookId: a.bookId,
    settings: settings as unknown as BookSyncDocument['settings'],
    settingsUpdatedAt,
    position,
    namedPages: mergeItems(a.namedPages, b.namedPages),
    annotations: mergeItems(a.annotations, b.annotations),
  };
}

function diffItems(local: readonly Item[], base: readonly Item[]): number {
  const byId = new Map(base.map((x) => [x.id, x]));
  let n = 0;
  for (const x of local) {
    const y = byId.get(x.id);
    if (!y || y.updatedAt !== x.updatedAt || Boolean(y.deleted) !== Boolean(x.deleted)) n++;
  }
  return n;
}

/**
 * 「未同期の件数」(G-3)。前回の同期で確定した内容(base)から、手元で増えた/変わった項目の数。
 * 数えるもの: 名前つきページ・注釈(1件ずつ)、変更した設定項目(1項目ずつ)、最後に読んだ位置(変わっていれば1件)。
 */
export function countUnsynced(local: BookSyncDocument, base: BookSyncDocument | null): number {
  let n = diffItems(local.namedPages, base?.namedPages ?? []) + diffItems(local.annotations, base?.annotations ?? []);
  for (const [k, t] of Object.entries(local.settingsUpdatedAt)) {
    if (base?.settingsUpdatedAt[k as BookSettingsKey] !== t) n++;
  }
  if (local.position && base?.position?.updatedAt !== local.position.updatedAt) n++;
  return n;
}
