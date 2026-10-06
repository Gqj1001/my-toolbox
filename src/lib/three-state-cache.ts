/**
 * 极简的「多结果形态」TTL 缓存 —— 专给**中间件**用。
 *
 * 为什么单独一个文件、而不用 `src/lib/ttl-cache.ts`：
 *   中间件默认跑在 **Edge runtime**，而 `ttl-cache.ts` 带了 `import "server-only"`，
 *   在 Edge 里引用有风险。本文件**只用 Map 与 Date.now()**，Edge / Node 都能跑，
 *   也方便被中间件的单元测试直接引用。
 *
 * 与 `ttl-cache.ts` 的关键区别：那个的 `cached()` 只能表达「一次成功加载」；
 * 而中间件要缓存的是**三态结果**（已登录 / 未登录 / 查不到），
 * 并且「未登录」是必须被缓存的（否则匿名请求反而变慢）。所以这里存的是
 * `{ value, at } | undefined`，并用 `entry !== undefined` 区分「没有缓存」与「缓存了 null」。
 */

export type ThreeStateCache<T> = {
  /** 未命中返回 undefined；命中且值为 null 也返回 null（必须能区分） */
  get(key: string): { value: T | null } | undefined;
  set(key: string, value: T | null): void;
  /** 当前 key 数量（测试/诊断用） */
  size(): number;
  clear(): void;
};

/**
 * @param ttlMs  存活毫秒数。**<= 0 表示禁用缓存**（get 永远 miss、set 不写），
 *               用于「线上出问题时不改代码就回到没有缓存的行为」。
 * @param maxKeys 最多留几个 key（防止内存无限涨）。超出时按最久未写的淘汰一个。
 */
export function createThreeStateCache<T>(ttlMs: number, maxKeys = 200): ThreeStateCache<T> {
  const entries = new Map<string, { value: T | null; at: number }>();
  const disabled = !Number.isFinite(ttlMs) || ttlMs <= 0;

  return {
    get(key) {
      if (disabled) return undefined;
      const e = entries.get(key);
      if (!e) return undefined;
      if (Date.now() - e.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return { value: e.value };
    },
    set(key, value) {
      if (disabled) return;
      if (!entries.has(key) && entries.size >= maxKeys) {
        // 简单淘汰：删掉最久没被写入的那条
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, e] of entries) {
          if (e.at < oldestAt) {
            oldestAt = e.at;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) entries.delete(oldestKey);
      }
      entries.set(key, { value, at: Date.now() });
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * 读取 TTL 配置：默认 30 秒，`0`（或负数/非法值）表示禁用。
 *
 * 环境变量名 `MIDDLEWARE_CACHE_TTL`（单位：秒）。
 */
export function readCacheTtlMs(envValue: string | undefined, defaultSeconds = 30): number {
  if (envValue === undefined || envValue.trim() === "") return defaultSeconds * 1000;
  const secs = Number(envValue);
  if (!Number.isFinite(secs) || secs <= 0) return 0; // 显式关闭
  return secs * 1000;
}
