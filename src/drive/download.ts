import { clearPartial, getChunk, getPartial, putChunk, putPartial, type Partial } from '../offline/partials';

export class AuthExpiredError extends Error {
  constructor() {
    super('ドライブへの接続が切れました。再接続してください');
  }
}

export interface FileInfo {
  name: string;
  size: number;
  md5: string | null;
}

/** 取得を断片に分ける大きさ。中断しても、取得済みの断片から再開できる。 */
export const CHUNK_SIZE = 4 * 1024 * 1024;

const API = 'https://www.googleapis.com/drive/v3/files';

export async function fetchFileInfo(
  fileId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<FileInfo> {
  const res = await fetchFn(`${API}/${encodeURIComponent(fileId)}?fields=name,size,md5Checksum`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`ファイル情報を取得できませんでした(HTTP ${res.status})`);
  const j = (await res.json()) as { name?: string; size?: string; md5Checksum?: string };
  return { name: j.name ?? '無題のPDF', size: Number(j.size) || 0, md5: j.md5Checksum ?? null };
}

/**
 * PDF を断片ごとに取得する。取得済みの断片は端末内に保存し、中断(接続切れ・閉じた等)の後は
 * 続きから再開する。ファイルが変わっていた(サイズまたは md5 が違う)場合は最初からやり直す。
 * 端末に保存できない場合(容量不足など)は、その断片をメモリに保持して続行する(再開はできない)。
 */
export async function downloadResumable(
  fileId: string,
  accessToken: string,
  info: FileInfo,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<Blob> {
  const total = info.size;
  if (total === 0) return new Blob([], { type: 'application/pdf' });
  const count = Math.ceil(total / CHUNK_SIZE);

  let partial: Partial | undefined = await getPartial(fileId).catch(() => undefined);
  if (partial && (partial.size !== total || partial.md5 !== info.md5)) {
    await clearPartial(fileId).catch(() => undefined);
    partial = undefined;
  }
  if (!partial) {
    partial = { bookId: fileId, size: total, md5: info.md5, nextIndex: 0 };
    await putPartial(partial).catch(() => undefined);
  }

  const inMemory = new Map<number, Blob>();
  let current: Partial = partial;
  let storable = true;
  onProgress(Math.min(1, (current.nextIndex * CHUNK_SIZE) / total));

  for (let i = current.nextIndex; i < count; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(total, start + CHUNK_SIZE) - 1;
    const res = await fetchFn(`${API}/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}`, Range: `bytes=${start}-${end}` },
      signal,
    });
    if (res.status === 401) throw new AuthExpiredError();

    if (res.status === 200) {
      // Range が無視され、全体が返ってきた
      const whole = await res.blob();
      await clearPartial(fileId).catch(() => undefined);
      onProgress(1);
      return new Blob([whole], { type: 'application/pdf' });
    }
    if (res.status !== 206) throw new Error(`ダウンロードに失敗しました(HTTP ${res.status})`);

    const blob = await res.blob();
    if (blob.size !== end - start + 1) throw new Error('ダウンロードが途中で途切れました。もう一度お試しください');

    if (storable) {
      try {
        await putChunk(current, i, blob);
        current = { ...current, nextIndex: i + 1 };
      } catch {
        storable = false;
        inMemory.set(i, blob);
      }
    } else {
      inMemory.set(i, blob);
    }
    onProgress((end + 1) / total);
  }

  const parts: Blob[] = [];
  for (let i = 0; i < count; i++) {
    const part = inMemory.get(i) ?? (await getChunk(fileId, i));
    if (!part) throw new Error('保存した断片が見つかりません。最初からやり直してください');
    parts.push(part);
  }
  const blob = new Blob(parts, { type: 'application/pdf' });
  await clearPartial(fileId).catch(() => undefined);
  return blob;
}
