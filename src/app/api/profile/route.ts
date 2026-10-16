import { NextResponse } from "next/server";
import { getViewer } from "@/lib/viewer";
import { getUserProfile } from "@/lib/user-profile-db";
import { resolveSignature, subjectName } from "@/lib/user-profile";

/**
 * 「我的资料」——**给工具页读**（课后反馈 / 试卷分析 / 数学方案）。
 *
 * 为什么单独开一个接口，而不是塞进 `/api/students` 或 `/api/feedback/data`：
 *   资料是**按账号**的，"学生 + 历史"是**按学生**的，两者维度不同。
 *   混在一个响应里，将来任何一边改形状都会牵动另一边（本项目在"两个来源"上踩过几次）。
 *   代价只是工具页多一次很轻的请求（一个键值行）。
 *
 * ⚠️ 与所有"读资料"的地方同一口径：**读不到就返回 profile: null**，
 *    工具必须走兜底（默认落款 / 原来的写法），**绝不因为资料没填就导出空白**。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer.user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  const p = await getUserProfile(viewer.user.id);
  return NextResponse.json(
    {
      ok: true,
      // ⚠️ 顺带回传 userId：工具页用它当"落款按账号记住"的 storage key。
      //    工具页的云端数据（/api/feedback/data）到得比这里**晚**，所以不能只靠那边给；
      //    这里回一份，工具就能**立刻**按账号恢复本机记住的落款（用户要的"不用重新等加载"）。
      userId: viewer.user.id,
      profile: p
        ? {
            teacherName: p.teacherName,
            subject: p.subject,                     // code（math/chinese…）
            subjectName: subjectName(p.subject),    // 显示名（数学/语文…）
            campus: p.campus,
            // 落款：手填优先，否则"学科+姓名+老师"（例：数学郭老师）
            signature: resolveSignature(p),
          }
        : null,
    },
    // 资料随时可能在另一个标签页改掉 ⇒ 不缓存（这条请求很轻）
    { headers: { "Cache-Control": "no-store" } },
  );
}
