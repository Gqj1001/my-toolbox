import { NextResponse, type NextRequest } from "next/server";
import { clearUserDataCachesForTest } from "@/lib/feedback-db";
import { denyUnlessDebugAuthorized } from "@/lib/debug-gate";

/**
 * 仅用于**开发/测试**的缓存清理口。
 *
 * 为什么需要它：学生档案 / 历史的缓存是**服务端进程内**的（TTL 25 秒），
 * 而测试或排查脚本有时会**绕过写接口直接改库**（例如直连 PostgREST 造一份带新列的
 * 档案）。那时没有任何代码路径去清缓存，于是会读到最长 25 秒的旧值 ——
 * 症状非常像「功能坏了」，实际只是缓存没清。
 *
 * 开关与其它 `/api/debug/*` **共用一处**：`src/lib/debug-gate.ts`
 * （`ALLOW_DEBUG_CACHE_CLEAR=1` + `DEBUG_CACHE_TOKEN`（≥24 位）+ 请求头一致，
 *  缺一即 404；默认全关，所以生产环境这个路由等于不存在）。
 * 另外它还受中间件保护 —— `/api/*` 一律要求登录会话。
 *
 * ⚠️ 部署前请确认：**生产环境（Vercel）绝对不要设** `ALLOW_DEBUG_CACHE_CLEAR`
 *    与 `DEBUG_CACHE_TOKEN`。
 * ⚠️ 它**只清进程内缓存**，不碰数据库、不碰任何用户数据、不改任何行。
 */
export async function POST(request: NextRequest) {
  const denied = denyUnlessDebugAuthorized(request);
  if (denied) return denied;

  const cleared = clearUserDataCachesForTest();
  return NextResponse.json({ ok: true, cleared, scope: "students+history" });
}
