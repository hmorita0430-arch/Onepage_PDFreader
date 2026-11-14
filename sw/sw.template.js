/* 見開きリーダーのサービスワーカー(アプリ本体のオフライン起動用)。ビルド時に版と一覧を埋め込む。
 * 書籍の内容(PDF)はここでは扱わない。PDF は IndexedDB に保存する(src/offline)。 */
const CACHE = 'app-__VERSION__';
// 文字の読み取り(OCR)用の大きなファイル(/ocr/)。事前には保存せず、初めて使ったときに保存する。版が変わっても消さない
const OCR_CACHE = 'ocr-v1';
const FILES = __FILES__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new URL(f, self.registration.scope).href)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google 関連などの外部通信には介入しない
  if (url.pathname.includes('/ocr/')) {
    event.respondWith(
      caches.open(OCR_CACHE).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.status === 200) await cache.put(req, res.clone()).catch(() => undefined);
        return res;
      }),
    );
    return;
  }
  event.respondWith(
    // 配信側の Vary ヘッダー(Origin など)で照合に失敗しないよう、Vary は無視する(同一オリジンの自前ファイルのみ)
    caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).catch(() =>
          req.mode === 'navigate'
            ? caches.match(new URL('index.html', self.registration.scope).href, { ignoreVary: true })
            : Response.error(),
        ),
    ),
  );
});
