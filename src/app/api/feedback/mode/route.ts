import { NextResponse } from "next/server";
import { getViewer } from "@/lib/viewer";

/**
 * 课后反馈工具页的「模式探测」接口（轻量）。
 *
 * 为什么单独做这个：工具页启动时原本用 `GET /api/feedback/data`（不带参数）
 * 只为拿一个 `isAdmin` 布尔值，却顺带把整棵关键词树拉了回来 ——
 * 既慢（那是全表查询），又因为 PostgREST 的 1000 行上限拿到的是残缺数据。
 * 这里只返回身份信息，一次 getViewer()（已合并、请求内去重）即可。
 *
 * 对应前端：public/tools/feedback.html 的 detectServer()。
 */
export async function GET() {
  const viewer = await getViewer();

  if (!viewer.user) {
    return NextResponse.json(
      { ok: false, error: "请先登录。", code: "unauthenticated" },
      { status: 401 },
    );
  }
  if (viewer.membership.status === "banned") {
    return NextResponse.json(
      { ok: false, error: "账号已被封禁。", code: "banned" },
      { status: 403 },
    );
  }

  return NextResponse.json({
    ok: true,
    isAdmin: viewer.role === "admin",
    email: viewer.user.email,
  });
}
