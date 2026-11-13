/**
 * 端末内保存(G-4)用の IndexedDB。
 * - books    : 保存済みの本のメタ情報(一覧・容量表示用。軽い)
 * - blobs    : 本のPDF本体(Blob)
 * - partials : 取得の途中経過(再開用)
 * - chunks   : 取得済みの断片
 */
const DB_NAME = 'onepage-pdfreader';
const DB_VERSION = 1;

export type StoreName = 'books' | 'blobs' | 'partials' | 'chunks';

let dbPromise: Promise<IDBDatabase> | undefined;

/** テスト用: 接続のキャッシュを捨てる */
export function resetDbForTest(): void {
  dbPromise = undefined;
}

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'bookId' });
      db.createObjectStore('blobs');
      db.createObjectStore('partials', { keyPath: 'bookId' });
      db.createObjectStore('chunks');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = undefined;
      reject(req.error ?? new Error('端末内の保存領域を開けませんでした'));
    };
  });
  return dbPromise;
}

/** 1つのトランザクションで複数のストアを操作する。完了(commit)まで待って結果を返す。 */
export async function run<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (get: (name: StoreName) => IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('保存に失敗しました'));
    tx.onabort = () => reject(tx.error ?? new Error('保存が中止されました(容量不足の可能性があります)'));
    Promise.resolve(fn((name) => tx.objectStore(name))).then(
      (v) => {
        result = v;
      },
      (e) => {
        try {
          tx.abort();
        } catch {
          /* 既に終了 */
        }
        reject(e);
      },
    );
  });
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
