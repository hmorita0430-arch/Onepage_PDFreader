import { describe, expect, it } from 'vitest';
import sw from '../sw/sw.template.js?raw';

describe('サービスワーカーの作り', () => {
  it('新しい版を保存するとき、ブラウザの一時キャッシュを使わず、配信元から取り直す(直前の版の index.html が混ざらない)', () => {
    expect(sw).toContain("cache: 'reload'");
    expect(sw).toMatch(/c\.addAll\(FILES\.map\(\(f\) => new Request\(/);
  });
  it('版の名前と、保存するファイルの一覧を、ビルド時に埋め込む', () => {
    expect(sw).toContain('__VERSION__');
    expect(sw).toContain('__FILES__');
  });
});
