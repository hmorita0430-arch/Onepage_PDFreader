export class AuthExpiredError extends Error {
  constructor() {
    super('ドライブへの接続が切れました。再接続してください');
  }
}

/** Drive からPDFを取得する。進捗(0〜1、不明なら null)を通知する。 */
export async function downloadPdf(
  fileId: string,
  accessToken: string,
  onProgress: (fraction: number | null) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  if (res.status === 401) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`ダウンロードに失敗しました(HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total ? received / total : null);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
