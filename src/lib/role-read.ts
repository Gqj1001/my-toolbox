/**
 * 读 `user_roles` 的那一行 —— **失败绝不能伪装成“没有角色”**。
 *
 * 背景（2026-10 线上 Bug）：
 *   管理员刷新 / 重新登录后偶尔进不去 `/admin`。根因不是角色丢了，而是
 *   `user_roles` 查询遇到一次瞬时失败（网络、Auth 刚刷新、连接复用等），
 *   旧代码只取 `data`、不看 `error`，于是拿到 `null`，又把这个 `null`
 *   当成“普通用户”写进 30 秒进程缓存 ⇒ 管理员被锁 30 秒。
 *
 * 本函数把“查询失败”与“确实没有这一行”分开：
 *   · 查询成功但没行 → 返回 `null`（合法的“没有角色”）；
 *   · 查询报错 → **抛异常**（调用方不要把异常结果写缓存）；
 *   · 默认重试 1 次（隔 120ms），瞬时抖动通常第二次就好了。
 *
 * ⚠️ 不要把本函数包在缓存里“缓存异常”——调用方应当 catch 后按最小权限处理，
 *    但**不写缓存**；下一次请求会重新查。
 */

export type RoleQueryResult<T> = {
  data: T | null;
  error: { message?: string | null; code?: string | null } | null;
};

export type RoleQuery<T> = () => PromiseLike<RoleQueryResult<T>>;

const RETRY_DELAY_MS = 120;

function describe(error: { message?: string | null; code?: string | null } | null): string {
  if (!error) return "unknown error";
  const code = error.code ? `[${error.code}] ` : "";
  return `${code}${error.message ?? "unknown error"}`;
}

/**
 * @param query 真正执行 Supabase 查询的函数（便于测试注入失败）
 * @param retries 失败后额外重试次数；默认 1
 */
export async function readRoleRow<T>(
  query: RoleQuery<T>,
  retries = 1,
): Promise<T | null> {
  const attempts = Math.max(0, retries) + 1;
  let lastError: unknown = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const { data, error } = await query();
      if (error) throw new Error(describe(error));
      return data ?? null;
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
