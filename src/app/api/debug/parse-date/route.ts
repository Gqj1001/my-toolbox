import { NextResponse, type NextRequest } from "next/server";
import { parseDisplayDate } from "@/lib/date-input";
import { denyUnlessDebugAuthorized, debugEndpointsEnabled } from "@/lib/debug-gate";

/**
 * 只读调试口：把 `x` 交给 `parseDisplayDate()` 求值并原样返回。
 *
 * 存在的唯一理由：阶段2 第2步把 `parseDisplayDate` 从 route.ts 搬到了
 * `src/lib/date-input.ts`，必须证明「行为零改动」。做法是测试文件里留一份
 * **老实现的逐字副本**，让它和**生产代码里的新实现**对同一批输入求值、逐条比对。
 * 而新实现在服务端（TS），测试从外面够不着 —— 所以开了这个只读口。
 *
 * ⚠️ **只读**：不改任何数据、不碰数据库。
 * ⚠️ 默认关闭：走 `/api/debug/*` 共用开关（`src/lib/debug-gate.ts`）。
 *
 * 用法：`GET /api/debug/parse-date?input=10月3日`
 *   → `{ ok:true, enabled:true, input:"10月3日", result:"2026-10-03" }`
 *
 * 入参一律当**字符串**处理（`parseDisplayDate` 内部就是 `String(input ?? "")`），
 * 所以 `input` 缺省时等同于空串 —— 与前端「没填日期」的行为一致。
 */
export async function GET(request: NextRequest) {
  const denied = denyUnlessDebugAuthorized(request);
  if (denied) return denied;

  const raw = request.nextUrl.searchParams.get("input");
  return NextResponse.json({
    ok: true,
    enabled: debugEndpointsEnabled(),
    input: raw,
    result: parseDisplayDate(raw),
  });
}
