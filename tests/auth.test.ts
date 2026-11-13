import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const KEY = 'drive-auth:v1';
let storage: MemStorage;

async function newAuth() {
  const { DriveAuth } = await import('../src/drive/auth');
  return new DriveAuth();
}
const put = (v: unknown) => storage.setItem(KEY, JSON.stringify(v));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
  storage = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});
afterEach(() => vi.useRealTimers());

describe('接続情報の端末内保存(アプリを開き直しても引き継ぐ)', () => {
  it('何も保存されていなければ未接続', async () => {
    const a = await newAuth();
    expect(a.state).toBe('disconnected');
    expect(a.currentToken()).toBeNull();
  });

  it('期限内のトークンがあれば、開き直しても接続中', async () => {
    put({ token: 'tok', expiresAt: Date.now() + 30 * 60_000, connected: true });
    const a = await newAuth();
    expect(a.state).toBe('connected');
    expect(a.currentToken()).toBe('tok');
  });

  it('期限が切れていたら使わず、「切れた(再接続)」扱い', async () => {
    put({ token: 'old', expiresAt: Date.now() - 1000, connected: true });
    const a = await newAuth();
    expect(a.state).toBe('expired');
    expect(a.currentToken()).toBeNull();
  });

  it('期限の1分前を切ったトークンは使わない', async () => {
    put({ token: 'soon', expiresAt: Date.now() + 30_000, connected: true });
    expect((await newAuth()).state).toBe('expired');
  });

  it('壊れた保存データは無視して未接続', async () => {
    storage.setItem(KEY, '{broken');
    expect((await newAuth()).state).toBe('disconnected');
  });

  it('期限が来ると自動で「切れた」に変わり、通知される', async () => {
    put({ token: 'tok', expiresAt: Date.now() + 120_000, connected: true });
    const a = await newAuth();
    const seen: string[] = [];
    a.onChange((s) => seen.push(s));
    vi.advanceTimersByTime(59_000);
    expect(a.state).toBe('connected');
    vi.advanceTimersByTime(2_000); // 期限の1分前(=60秒後)を過ぎた
    expect(a.state).toBe('expired');
    expect(seen).toEqual(['expired']);
  });

  it('expire() は保存したトークンを消すが、「接続したことがある」印は残す', async () => {
    put({ token: 'tok', expiresAt: Date.now() + 30 * 60_000, connected: true });
    const a = await newAuth();
    a.expire();
    expect(JSON.parse(storage.getItem(KEY)!).token).toBeNull();
    const b = await newAuth();
    expect(b.state).toBe('expired');
  });

  it('disconnect() で保存した接続情報がすべて消え、未接続に戻る', async () => {
    put({ token: 'tok', expiresAt: Date.now() + 30 * 60_000, connected: true });
    const a = await newAuth();
    const seen: string[] = [];
    a.onChange((s) => seen.push(s));
    a.disconnect();
    expect(a.state).toBe('disconnected');
    expect(storage.getItem(KEY)).toBeNull();
    expect(seen).toEqual(['disconnected']);
    expect((await newAuth()).state).toBe('disconnected');
  });

  it('すでに切れている状態での expire() は通知しない', async () => {
    const a = await newAuth();
    const seen: string[] = [];
    a.onChange((s) => seen.push(s));
    a.expire();
    expect(seen).toEqual([]);
  });
});
