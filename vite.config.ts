import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  plugins: [emitServiceWorker()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
