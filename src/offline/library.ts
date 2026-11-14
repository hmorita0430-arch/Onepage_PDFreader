import { req, run } from './db';

export interface BookMeta {
  bookId: string;
  name: string;
  size: number;
  /** ドライブ上のファイルの md5(同じ版かどうかの判定用)。取れなければ null */
  md5: string | null;
  savedAt: number;
  lastOpenedAt: number;
}

/** 本を端末に保存する(メタ情報と本体を1つのトランザクションで)。 */
export async function saveBook(meta: Omit<BookMeta, 'savedAt' | 'lastOpenedAt'>, blob: Blob): Promise<void> {
  const now = Date.now();
  const full: BookMeta = { ...meta, savedAt: now, lastOpenedAt: now };
  await run(['books', 'blobs'], 'readwrite', (get) => {
    get('books').put(full);
    get('blobs').put(blob, meta.bookId);
  });
}

export function getMeta(bookId: string): Promise<BookMeta | undefined> {
  return run(['books'], 'readonly', (get) => req(get('books').get(bookId)));
}

export function getBlob(bookId: string): Promise<Blob | undefined> {
  return run(['blobs'], 'readonly', (get) => req(get('blobs').get(bookId)));
}

/** 最近開いた順 */
export async function listBooks(): Promise<BookMeta[]> {
  const all = await run(['books'], 'readonly', (get) => req(get('books').getAll() as IDBRequest<BookMeta[]>));
  return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function touchBook(bookId: string): Promise<void> {
  await run(['books'], 'readwrite', async (get) => {
    const store = get('books');
    const meta = (await req(store.get(bookId))) as BookMeta | undefined;
    if (meta) store.put({ ...meta, lastOpenedAt: Date.now() });
  });
}

/** 端末から本を削除する。しおり・注釈などの同期データは別に残る(G-4)。 */
export async function deleteBook(bookId: string): Promise<void> {
  await run(['books', 'blobs'], 'readwrite', (get) => {
    get('books').delete(bookId);
    get('blobs').delete(bookId);
  });
}

export type LibrarySort = 'recent' | 'name';

/**
 * 保存した本の並べ替え。最近順は最後に開いた順、名前順は日本語の読みの順(数字は大きさの順: 2巻 < 10巻)。
 * 元の配列は変えない。
 */
export function sortBooks(books: readonly BookMeta[], mode: LibrarySort): BookMeta[] {
  const copy = [...books];
  if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }) || a.savedAt - b.savedAt);
  return copy.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.savedAt - a.savedAt);
}

/** 「続きから読む」の対象: 最後に開いた本。無ければ undefined */
export function latestBook(books: readonly BookMeta[]): BookMeta | undefined {
  return sortBooks(books, 'recent')[0];
}

export interface StorageInfo {
  /** このサイト全体の使用量(バイト)。取れなければ null */
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export async function storageInfo(): Promise<StorageInfo> {
  const info: StorageInfo = { usage: null, quota: null, persisted: null };
  try {
    const est = await navigator.storage?.estimate?.();
    info.usage = est?.usage ?? null;
    info.quota = est?.quota ?? null;
    info.persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    /* 取得できない環境 */
  }
  return info;
}

/** ブラウザに、保存領域を自動削除しないよう要求する(G-4)。許可されたか。 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
