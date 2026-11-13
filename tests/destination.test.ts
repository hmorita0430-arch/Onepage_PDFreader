import { beforeEach, describe, expect, it } from 'vitest';
import { clearDestination, describeDestination, loadDestination, saveDestination } from '../src/export/destination';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

describe('書き出し先の設定(アプリ全体で1つ・この端末内)', () => {
  it('未設定なら null(既定の保存先)', () => {
    expect(loadDestination()).toBeNull();
  });
  it('保存した保存先を読み出せ、消すと既定に戻る', () => {
    saveDestination({ id: 'abc', name: 'マイノート' });
    expect(loadDestination()).toEqual({ id: 'abc', name: 'マイノート' });
    clearDestination();
    expect(loadDestination()).toBeNull();
  });
  it('壊れた保存データ・必要な項目が無いデータは、既定として扱う', () => {
    storage.setItem('export-destination:v1', '{broken');
    expect(loadDestination()).toBeNull();
    storage.setItem('export-destination:v1', JSON.stringify({ id: '', name: 'x' }));
    expect(loadDestination()).toBeNull();
    storage.setItem('export-destination:v1', JSON.stringify({ name: 'x' }));
    expect(loadDestination()).toBeNull();
  });
  it('余計な項目は保存しない', () => {
    saveDestination({ id: 'a', name: 'n', extra: 1 } as never);
    expect(JSON.parse(storage.getItem('export-destination:v1')!)).toEqual({ id: 'a', name: 'n' });
  });
  it('画面に出す説明', () => {
    expect(describeDestination(null)).toContain('マイドライブ/読書ノート');
    expect(describeDestination({ id: 'a', name: 'マイノート' })).toContain('マイノート');
  });
});
