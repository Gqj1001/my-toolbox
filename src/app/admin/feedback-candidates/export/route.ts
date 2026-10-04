import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";

/**
 * 导出候选为 CSV（供在 Excel 里逐章过一遍）
 *
 * GET /admin/feedback-candidates/export?batch=xxx[&subject=xxx][&status=pending]
 *
 * 仅 admin 可用；加 BOM 让 Excel 正确识别 UTF-8 中文。
 */
const SUBJECT_NAME: Record<string, string> = {
  chinese: "语文", math: "数学", english: "英语", physics: "物理", chemistry: "化学",
  biology: "生物", politics: "政治", history: "历史", geography: "地理", general: "通用",
};
const STAGE_NAME: Record<string, string> = { senior: "高中", junior: "初中" };
const STATUS_NAME: Record<string, string> = { pending: "待审核", approved: "已通过", rejected: "已拒绝" };

const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export async function GET(request: NextRequest) {
  const { user, role } = await getCurrentUserWithRole();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  if (role !== "admin") {
    return NextResponse.json({ ok: false, error: "仅管理员可导出。" }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const batch = String(sp.get("batch") ?? "").trim();
  const subject = String(sp.get("subject") ?? "").trim();
  const status = String(sp.get("status") ?? "").trim();
  if (!batch) {
    return NextResponse.json({ ok: false, error: "缺少批次号。" }, { status: 400 });
  }

  const supabase = await createClient();
  let q = supabase
    .from("feedback_section_candidates")
    .select("stage, subject, version, book_name, section_name, keywords, status, note, promoted_at")
    .eq("batch_id", batch)
    .order("subject")
    .order("version")
    .order("book_name")
    .order("id")
    .limit(10000);
  if (subject) q = q.eq("subject", subject);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json(
      { ok: false, error: `读取候选失败：${error.code} ${error.message}` },
      { status: 500 },
    );
  }

  const header = [
    "学段", "科目", "教材版本", "册次", "章名", "知识点数", "知识点（用 | 分隔）",
    "审核状态", "是否已提升", "备注",
  ];
  const lines = [header.map(cell).join(",")];
  for (const r of data ?? []) {
    const kws = Array.isArray(r.keywords) ? (r.keywords as string[]) : [];
    lines.push([
      STAGE_NAME[r.stage] ?? r.stage,
      SUBJECT_NAME[r.subject] ?? r.subject,
      r.version,
      r.book_name,
      r.section_name,
      kws.length,
      kws.join(" | "),
      STATUS_NAME[r.status] ?? r.status,
      r.promoted_at ? "是" : "否",
      r.note ?? "",
    ].map(cell).join(","));
  }

  const csv = "\ufeff" + lines.join("\r\n");
  const fileName = `feedback-candidates-${batch}${subject ? `-${subject}` : ""}${status ? `-${status}` : ""}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
