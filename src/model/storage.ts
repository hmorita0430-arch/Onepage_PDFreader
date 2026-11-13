import { newBookSyncDocument, SCHEMA_VERSION, type BookSyncDocument } from './types';

/**
 * 第1段階は端末内(localStorage)に4章の形式で保存する。第3段階で同じ形式をドライブへ同期する。
 * 保存できない環境(プライベートモード等)でも読書は止めない。
 */
const key = (bookId: string) => `bookdoc:v${SCHEMA_VERSION}:${bookId}`;

export function loadBookDocument(bookId: string): BookSyncDocument {
  try {
    const raw = localStorage.getItem(key(bookId));
    if (raw) {
      const parsed = JSON.parse(raw) as BookSyncDocument;
      const base = newBookSyncDocument(bookId);
      return { ...base, ...parsed, settings: { ...base.settings, ...parsed.settings } };
    }
  } catch {
    /* 壊れた保存データは無視して既定値で始める */
  }
  return newBookSyncDocument(bookId);
}

export function saveBookDocument(doc: BookSyncDocument): void {
  try {
    localStorage.setItem(key(doc.bookId), JSON.stringify(doc));
  } catch {
    /* 保存不可でも続行 */
  }
}

/**
 * 前回の同期で確定した内容(基準)。「未同期の件数」を、手元との差から求めるために持つ。
 */
const baseKey = (bookId: string) => `bookbase:v${SCHEMA_VERSION}:${bookId}`;

export function loadBase(bookId: string): BookSyncDocument | null {
  try {
    const raw = localStorage.getItem(baseKey(bookId));
    if (raw) return JSON.parse(raw) as BookSyncDocument;
  } catch {
    /* 壊れていれば基準なし(全項目が未同期扱いになり、次の同期で解消する) */
  }
  return null;
}

export function saveBase(doc: BookSyncDocument): void {
  try {
    localStorage.setItem(baseKey(doc.bookId), JSON.stringify(doc));
  } catch {
    /* 保存不可でも続行 */
  }
}
