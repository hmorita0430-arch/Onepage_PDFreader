import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** ビルド結果の一覧と版(ファイル名のハッシュ)を埋め込んだ sw.js を出力する。 */
function emitServiceWorker(): Plugin {
  return {
    name: 'emit-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      // index.html は generateBundle の後に出力されるため、一覧には明示的に加える
      const files = ['./', 'index.html', ...built.filter((f) => f !== 'index.html'), 'manifest.webmanifest', 'icon.svg'];
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 10);
      const template = readFileSync(fileURLToPath(new URL('./sw/sw.template.js', import.meta.url)), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(files)),
      });
    },
  };
}

/**
 * OCR(tesseract.js)の実行ファイルを、/ocr/ から配る(外部のCDNを使わない)。
 * リポジトリには入れず、node_modules からコピーする。言語データ(lang/)は public/ocr/lang/ にある。
 * 大きいので、サービスワーカーの事前保存の一覧には入れない(初めて使ったときに保存する)。
 */
const OCR_FILES: Array<[string, string]> = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'ocr/worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'ocr/core/tesseract-core-simd-lstm.wasm.js'],
];
function serveOcr(): Plugin {
  const abs = (p: string) => fileURLToPath(new URL(`./${p}`, import.meta.url));
  return {
    name: 'serve-ocr',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const hit = OCR_FILES.find(([, to]) => path.endsWith(`/${to}`));
        if (!hit) return next();
        res.setHeader('Content-Type', 'application/javascript');
        res.end(readFileSync(abs(hit[0])));
      });
    },
    closeBundle() {
      for (const [from, to] of OCR_FILES) {
        const dest = abs(`dist/${to}`);
        mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
        if (existsSync(abs(from))) copyFileSync(abs(from), dest);
      }
    },
  };
}

/** 画面に出す版。配信ではコミットID、手元ではgitから。取れなければ 'dev'。 */
function appVersion(): string {
  const fromCi = process.env.GITHUB_SHA?.slice(0, 7);
  if (fromCi) return fromCi;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

// GitHub Pages のサブパス配信でも動くよう、相対パスでビルドする。
export default defineConfig({
  base: './',
  plugins: [emitServiceWorker(), serveOcr()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
