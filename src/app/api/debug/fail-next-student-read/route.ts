import { NextResponse, type NextRequest } from "next/server";
import { failNextStudentReadsForTest } from "@/lib/feedback-db";
import { denyUnlessDebugAuthorized } from "@/lib/debug-gate";

/**
 * **仅用于测试**的"故障注入"口：让接下来 N 次「读学生档案」失败。
 *
 * 为什么需要它（2026-10 第四批，待办 A）：
 *   这一批修的语义是「**写档案**时读旧行失败 → **中止写入**，绝不降级成"没有旧行"」。
 *   而"数据库读失败"在测试里没法自然造出来 —— `NEXT_PUBLIC_SUPABASE_URL` 在**构建期**
 *   就被内联进产物，所以「build 完再改 `.env.local` 假装连不上库」**是无效的**
 *   （`docs/perf-notes.md` 六之二实测踩过）。没有这个口，这条修复就只能靠肉眼 review。
 *
 * ⚠️ 开关与其它 `/api/debug/*` **共用一处**：`src/lib/debug-gate.ts`
 *    （`ALLOW_DEBUG_CACHE_CLEAR=1` + `DEBUG_CACHE_TOKEN`（≥24 位）+ 请求头一致，
 *     缺一即 404；默认全关 ⇒ **生产环境这个路由等于不存在**）。
 *    另外它还受中间件保护 —— `/api/*` 一律要求登录会话。
 *
 * ⚠️ 它**不改任何数据、不碰缓存**，只是把"接下来几次读会失败"这个计数设上；
 *    计数是**消费型**的，用完自动归零，所以不会影响后续请求。
 *
 * ⚠️ **部署前请确认：生产（Vercel）绝对不要设** `ALLOW_DEBUG_CACHE_CLEAR` 与 `DEBUG_CACHE_TOKEN`。
 *
 * 用法（测试里）：
 *   POST /api/debug/fail-next-student-read   { "count": 2 }   → { ok:true, willFail:2 }
 */
export async function POST(request: NextRequest) {
  const denied = denyUnlessDebugAuthorized(request);
  if (denied) return denied;

  let count = 1;
  try {
    const body = (await request.json()) as { count?: unknown };
    if (typeof body?.count === "number") count = body.count;
  } catch {
    // 没带 body 就当 1 次（最常用的场景）
  }

  const willFail = failNextStudentReadsForTest(count);
  return NextResponse.json({ ok: true, willFail, scope: "students-read" });
}
