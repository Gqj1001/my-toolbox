import "server-only";

/**
 * 通用的**进程内** TTL 缓存（带并发去重）。
 *
 * `tools` 表（`src/lib/tools-db.ts`）、`feedback` 的静态表与按用户表
 * （`src/lib/feedback-db.ts`）、`user_roles` 的会员状态（`src/lib/viewer.ts`）
 * 用的是同一套语义，所以抽到这里，避免三份各写一遍、各踩一遍坑。
 *
 * ⚠️ **不要用 `unstable_cache`**（2026-10 实测踩过，tools 表那次）：
 *    在 Next 16.3.8 下它会**每次都返回空数组、也从不查库**，页面不报错、
 *    只是**静默地什么都没有**，肉眼看不出来。所以这里一律用显式 Map。
 *
 * 语义：命中且未过期 → 直接返回、不查库；过期 → 重查并刷新；
 *      `invalidate*()` → 立即清掉（**本进程**立即生效）。
 *
 * 局限：**每个服务端实例各一份**。生产是多实例时，其它实例最多滞后一个 TTL。
 *      所以「改完必须立刻全站生效」的东西不能只靠它 —— 必须配主动失效函数，
 *      而且那个变更只能从**会调用失效函数的代码路径**进去（比如 Supabase SQL Editor
 *      直接改库就绕不过去，只能等 TTL）。
 */
export type TtlCache = {
  entries: Map<string, { rows: unknown; at: number }>;
  /** 并发去重：同一瞬间多个请求共用同一个 in-flight promise，只查一次库 */
  inflight: Map<string, Promise<unknown>>;
  ttlMs: number;
  /** 缓存 key 数量上限（0 = 不限）。只有「按用户」的缓存需要限量，防止内存无限涨。 */
  maxKeys: number;
};

export function createTtlCache(ttlMs: number, maxKeys = 0): TtlCache {
  return { entries: new Map(), inflight: new Map(), ttlMs, maxKeys };
}

/** 超出上限时按「最久没被写入」淘汰一条；在飞的条目不动，避免丢掉正在等的 promise */
function evictIfNeeded(cache: TtlCache) {
  if (!cache.maxKeys || cache.entries.size < cache.maxKeys) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, entry] of cache.entries) {
    if (cache.inflight.has(key)) continue;
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) cache.entries.delete(oldestKey);
}

/** 清掉一个缓存（entries + inflight 都要清，否则在飞的那条会把旧的写回来） */
export function clearCache(cache: TtlCache) {
  cache.entries.clear();
  cache.inflight.clear();
}

/** 这条 key 有没有**未过期**的结果 */
export function hasFresh(cache: TtlCache, key: string): boolean {
  const hit = cache.entries.get(key);
  return !!hit && Date.now() - hit.at < cache.ttlMs;
}

/**
 * 带 TTL 与并发去重的读取。
 *
 * `key` 必须只包含**真正影响结果的过滤条件**（否则不同维度会互相污染）；
 * 按用户的表必须把 `user_id` 拼进 key（RLS 只返回本人的行，共用 key 会串号）。
 *
 * **空结果（`[]`）照常缓存**，只要 `load` 没抛异常 —— 「确实没有数据」跟「查到了数据」
 * 一样是合法结果，不缓存它会让**没有数据的人每次请求都白查一遍**
 * （实测踩过：新用户没有学生档案，于是每次切科目都多打 2 次 Supabase）。
 *
 * 区分「空」和「查失败」的责任在 `load`：
 *   · 查失败必须**抛异常**（或把失败标记带出来）—— 抛异常时不会写缓存，
 *     并且会清掉自己设的那条 in-flight promise（只清「还是自己这条」的，
 *     避免把别人新发起的加载顶掉）；
 *   · 查成功但没数据 → 正常返回 `[]`，会被缓存。
 *
 * 为什么这条界限必须守住：`unstable_cache` 那个坑（tools 表）就是**把失败缓存成了空**，
 * 于是页面静默地什么都没有、还查不出原因。
 */
export async function cached<T>(cache: TtlCache, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.entries.get(key);
  if (hit && Date.now() - hit.at < cache.ttlMs) return hit.rows as T;

  const flying = cache.inflight.get(key);
  if (flying) return flying as Promise<T>;

  evictIfNeeded(cache);
  const run: Promise<T> = load().then((rows) => {
    cache.entries.set(key, { rows, at: Date.now() });
    return rows;
  });
  cache.inflight.set(key, run as Promise<unknown>);
  const clearInflight = () => {
    if (cache.inflight.get(key) === (run as Promise<unknown>)) cache.inflight.delete(key);
  };
  void run.then(clearInflight, clearInflight);
  return run;
}

/**
 * 不阻塞地预热：立刻把该查的查了，但不 await。
 *
 * ⚠️ **它不是「用户来的时候一定热」的保证**：
 *    Vercel 的实例是按需起的，闲置就被回收。「启动预热」跑在**实例启动**时，
 *    而那一刻往往**就是因为有用户请求**。所以预热会跟第一个真实请求**并发竞争**
 *    （抢连接/db 时间），最坏情况比不预热**更慢**。
 *    只对「又小、又每次请求都要」的表做预热才是净收益（比如分类 8 行、短语 10 行）。
 *
 * 失败只记日志，绝不抛出 —— 预热出问题不能影响真实请求。
 */
export function warmInBackground(label: string, loads: Array<() => Promise<unknown>>) {
  void Promise.allSettled(loads.map((load) => load())).then((results) => {
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) {
      console.warn(`[warmup] ${label} 预热有 ${failed.length} 项失败（不影响请求）`);
    }
  });
}
