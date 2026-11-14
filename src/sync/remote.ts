import { createBookFile, findBookFile, getVersion, readJson, updateBookFile } from '../drive/appdata';
import { sanitizeReading } from '../model/reading';
import { SCHEMA_VERSION, type BookSyncDocument } from '../model/types';
import { mergeDocuments, stableStringify } from './merge';

/** 開発用に端末のPDFを開いた本(local:...)は、ドライブに紐づかないので同期しない */
export const isSyncable = (bookId: string): boolean => !bookId.startsWith('local:');

/** 取り込んだ相手のデータを検査し、欠けている項目を補う。新しい形式・別の本なら拒否する。 */
export function parseRemote(json: unknown, bookId: string): BookSyncDocument {
  if (!json || typeof json !== 'object') throw new Error('同期データの形式が不正です');
  const r = json as Partial<BookSyncDocument>;
  if (typeof r.schemaVersion !== 'number') throw new Error('同期データの形式が不正です');
  if (r.schemaVersion > SCHEMA_VERSION) {
    // 上書きして壊さないよう、新しい形式のデータには触れない
    throw new Error('より新しい版のアプリで作られた同期データです。アプリを更新してください');
  }
  if (r.bookId !== bookId) throw new Error('同期データが別の本のものです');
  return {
    schemaVersion: SCHEMA_VERSION,
    bookId,
    settings: r.settings as BookSyncDocument['settings'],
    settingsUpdatedAt: r.settingsUpdatedAt ?? {},
    position: r.position ?? null,
    namedPages: r.namedPages ?? [],
    annotations: r.annotations ?? [],
    // 読書の記録(第5回で追加)。無い・壊れている場合は、記録なしとして扱う
    ...(sanitizeReading(r.reading) ? { reading: sanitizeReading(r.reading) } : {}),
  };
}

export interface SyncResult {
  /** ドライブ上に保存した(または既に同じだった)統合結果 */
  merged: BookSyncDocument;
  uploaded: boolean;
  /** 同期後のドライブ上のファイルの版。次回の「変更の確認」に使う */
  version: string;
  /** ドライブ上が前回から変わっておらず、手元にも送るものが無かったため、読み込みを省いた */
  skipped: boolean;
}

export interface SyncOptions {
  /**
   * 前回の同期後に分かっているドライブ上の版。これと同じで、かつ手元に送るものが無いときは、
   * 本体を読み込まずに終える(定期的な確認の通信量を減らす)。手元に未送信の変更があるときは渡さない。
   */
  knownVersion?: string;
}

const MAX_ATTEMPTS = 3;

/**
 * 手元(local)とドライブ上のデータを統合し、差があればドライブへ書き戻す。
 * 読み込みから書き込みまでの間に別の端末が更新した場合(version が変わった場合)は、
 * 取り込み直して統合をやり直す(他端末の分を上書きして消さないため)。
 */
export async function syncBook(
  local: BookSyncDocument,
  token: string,
  f: typeof fetch = fetch,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  for (let attempt = 1; ; attempt++) {
    const file = await findBookFile(local.bookId, token, f);
    if (file && opts.knownVersion !== undefined && file.version === opts.knownVersion) {
      return { merged: local, uploaded: false, version: file.version, skipped: true };
    }
    const remote = file ? parseRemote(await readJson(file.id, token, f), local.bookId) : null;
    const merged = remote ? mergeDocuments(local, remote) : local;

    if (remote && file && stableStringify(merged) === stableStringify(remote)) {
      return { merged, uploaded: false, version: file.version, skipped: false };
    }

    if (file) {
      const current = await getVersion(file.id, token, f);
      if (current !== file.version && attempt < MAX_ATTEMPTS) continue; // 他端末が更新した。取り込み直す
      const updated = await updateBookFile(file.id, merged, token, f);
      return { merged, uploaded: true, version: updated.version, skipped: false };
    }
    const created = await createBookFile(local.bookId, merged, token, f);
    return { merged, uploaded: true, version: created.version, skipped: false };
  }
}
