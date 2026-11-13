import { req, run } from './db';

/** 取得の途中経過。nextIndex 以降の断片がまだ無い。 */
export interface Partial {
  bookId: string;
  size: number;
  md5: string | null;
  nextIndex: number;
}

const chunkKey = (bookId: string, index: number) => `${bookId}#${index}`;

export function getPartial(bookId: string): Promise<Partial | undefined> {
  return run(['partials'], 'readonly', (get) => req(get('partials').get(bookId)));
}

export async function putPartial(p: Partial): Promise<void> {
  await run(['partials'], 'readwrite', (get) => {
    get('partials').put(p);
  });
}

/** 断片を保存し、次の位置を進める(同一トランザクション)。 */
export async function putChunk(p: Partial, index: number, blob: Blob): Promise<void> {
  await run(['partials', 'chunks'], 'readwrite', (get) => {
    get('chunks').put(blob, chunkKey(p.bookId, index));
    get('partials').put({ ...p, nextIndex: index + 1 });
  });
}

export function getChunk(bookId: string, index: number): Promise<Blob | undefined> {
  return run(['chunks'], 'readonly', (get) => req(get('chunks').get(chunkKey(bookId, index))));
}

export async function clearPartial(bookId: string): Promise<void> {
  await run(['partials', 'chunks'], 'readwrite', async (get) => {
    get('partials').delete(bookId);
    const chunks = get('chunks');
    const keys = (await req(chunks.getAllKeys())) as string[];
    for (const k of keys) if (typeof k === 'string' && k.startsWith(`${bookId}#`)) chunks.delete(k);
  });
}
