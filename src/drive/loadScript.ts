const loading = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  const existing = loading.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading.delete(src);
      reject(new Error(`スクリプトを読み込めませんでした: ${new URL(src).host}`));
    };
    document.head.append(el);
  });
  loading.set(src, p);
  return p;
}
