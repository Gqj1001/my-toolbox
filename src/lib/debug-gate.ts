import { NextResponse } from "next/server";

/**
 * `/api/debug/*` 共用的开关（**只有一处实现**，别在各自路由里另写一套）。
 *
 * 为什么要统一：调试口是「为了测试方便」才存在的，但它们一旦被误开在生产，
 * 每一个都是额外风险面。集中一处的好处是——审计时只看这个文件就够了。
 *
 * 开启条件（**默认全关**，缺一即当作「这个路由不存在」返回 404）：
 *   1. `ALLOW_DEBUG_CACHE_CLEAR === "1"` —— 生产的 Vercel 不设它，所以默认关闭；
 *   2. `DEBUG_CACHE_TOKEN` 已设且长度 ≥ 24 —— 防止设成 "1" 这种一眼猜到的值；
 *   3. 请求头 `x-debug-token` 与它完全一致。
 *
 * ⚠️ 刻意**不用** `NODE_ENV` 判断：Next 会在**构建期**把 `process.env.NODE_ENV`
 *    内联成常量，运行期设它不生效 —— 那种判断是死代码，而且失败方向是「关闭」，
 *    会让测试莫名其妙地拿不到调试口（阶段2 第1步踩过）。
 *
 * ⚠️ 任何失败都返回**同一个 404**：不告诉调用方「有这个路由但你没权限」。
 */
export const DEBUG_TOKEN_MIN_LEN = 24;
export const DEBUG_TOKEN_HEADER = "x-debug-token";

/** 调试口是否已配置（**不含**请求头校验）。测试用它决定「跳过对照测试」还是「跑」。 */
export function debugEndpointsEnabled(): boolean {
  if (process.env.ALLOW_DEBUG_CACHE_CLEAR !== "1") return false;
  const t = process.env.DEBUG_CACHE_TOKEN;
  return !!t && t.length >= DEBUG_TOKEN_MIN_LEN;
}

/** 请求不带合法 token 时返回 404 响应；合法时返回 null（调用方继续）。 */
export function denyUnlessDebugAuthorized(request: Request): NextResponse | null {
  const notFound = () => NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  if (!debugEndpointsEnabled()) return notFound();
  if (request.headers.get(DEBUG_TOKEN_HEADER) !== process.env.DEBUG_CACHE_TOKEN) return notFound();
  return null;
}
