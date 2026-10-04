import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import {
  assembleCategoryKeywords,
  buildKeywordTree,
  getCategories,
  getChapters,
  getHistory,
  getKeywords,
  getPhrases,
  getStudents,
  getTextbooks,
  historyByStudent,
  studentsByName,
} from "@/lib/feedback-db";
import { parseScope, subjectHasTextbook } from "@/lib/feedback-taxonomy";
import { createClient } from "@/lib/supabase/server";

/**
 * 课后反馈工作台的数据接口。
 *
 * 所有读写都走服务端 Supabase 客户端（带用户会话），
 * 因此 RLS 会对 feedback_students / feedback_history 自动按 auth.uid() 隔离，
 * 前端无法越权访问他人数据。
 *
 * GET    /api/feedback/data                    拉取全部关键词树（向后兼容）
 * GET    /api/feedback/data?stage=&subject=…    按「学段 × 科目」拉取
 *        可选 &textbook=<id>&chapter=<id>       进一步限定教材/章节
 * POST   /api/feedback/data  { op: 'student' | 'history', ... }   写入
 * DELETE /api/feedback/data?student=姓名        删除档案（同时删其历史）
 * DELETE /api/feedback/data?id=<historyId>      删除单条历史
 */

async function requireUser() {
  const { user, role } = await getCurrentUserWithRole();
  if (!user) return { ok: false as const, status: 401, message: "请先登录。" };

  const supabase = await createClient();
  const { data } = await supabase
    .from("user_roles")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (data?.status === "banned") {
    return { ok: false as const, status: 403, message: "账号已被封禁。" };
  }
  return { ok: true as const, user, role: role ?? "user" };
}

export async function GET(request: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.message }, { status: guard.status });
  }

  const sp = request.nextUrl.searchParams;
  const hasScope = ["stage", "subject", "textbook", "chapter"].some((k) => sp.get(k));
  const scope = parseScope({
    // 缺少 stage 时默认高中：数据库里历史数据都是 senior，
    // 不设默认会让「漏传 stage」的调用方拿到跨学段的混合结果
    stage: sp.get("stage") ?? (hasScope ? "senior" : null),
    subject: sp.get("subject"),
    textbook: sp.get("textbook"),
    chapter: sp.get("chapter"),
  });

  const [phrases, students, history] = await Promise.all([getPhrases(), getStudents(), getHistory()]);
  const base = {
    ok: true as const,
    // 当前登录用户（前端用于区分档案归属、调试）
    userId: guard.user.id,
    email: guard.user.email ?? null,
    phrases: phrases.map((p) => p.phrase),
    // 按 user_id 隔离（RLS）
    students: studentsByName(students),
    history: historyByStudent(history),
    // 前端据此决定是否显示「管理关键词」入口
    isAdmin: guard.role === "admin",
  };

  // ---------- 带维度参数：只取所需关键词，并附上分类/教材/章节清单 ----------
  if (hasScope) {
    const { stage, subject, textbookId, chapterId } = scope;
    const categories = stage || subject ? await getCategories(stage) : await getCategories();
    const categoryNames = categories.map((c) => c.name);

    const textbooks = subject ? await getTextbooks({ stage, subject }) : await getTextbooks({ stage });
    const chapters = textbookId ? await getChapters(textbookId) : [];

    // 每本教材附上自己的章节名（供工具页在云端模式下渲染「课本知识点」面板）
    const textbooksWithTopics = await Promise.all(
      textbooks.map(async (t) => {
        const chs = t.id === textbookId && chapters.length ? chapters : await getChapters(t.id);
        return {
          id: t.id,
          name: t.name,
          version: t.version,
          stage: t.stage,
          subject: t.subject,
          topics: chs.map((c) => c.name),
        };
      }),
    );

    // 当前维度下的关键词，分两类：
    //   ① 通用词：教材/章节都为空的词（内容类的通用词 + 6 个通用分类的词）
    //      —— 无论是否选了教材/章节，都必须只取「无归属」的词，
    //         否则会把章节词混进通用词里造成重复。
    //   ② 章节词：选了章节取该章；只选教材则取该教材全部章节的词。
    const genericScope = { ...scope, textbookId: null, chapterId: null };
    const [genericRows, chapterRows] = await Promise.all([
      getKeywords(genericScope),
      typeof chapterId === "number"
        ? getKeywords({ stage, subject, chapterId })
        : typeof textbookId === "number"
          ? getKeywords({ stage, subject, textbookId })
          : Promise.resolve([]),
    ]);

    const chapterKeywordList = chapterRows.map((r) => r.keyword);
    const chapterKeywordCount = new Set(chapterKeywordList).size;
    // 内容类分类若已选中章节/教材，用该维度的词；否则用通用内容词
    const categoryKeywords = assembleCategoryKeywords(categoryNames, genericRows);
    if (chapterRows.length) {
      for (const name of ["课堂内容", "下节课内容"]) {
        if (!(name in categoryKeywords)) continue;
        // 章节关键词在「课堂内容」和「下节课内容」下各存一行（同一知识点两处可选），
        // 渲染时按关键词去重，避免同一章出现重复项
        const seen = new Set<string>();
        const list: string[] = [];
        for (const r of chapterRows) {
          if (r.category !== name) continue;
          if (seen.has(r.keyword)) continue;
          seen.add(r.keyword);
          list.push(r.keyword);
        }
        categoryKeywords[name] = list;
      }
    }

    return NextResponse.json({
      ...base,
      stage: stage ?? null,
      subject: subject ?? null,
      hasTextbook: subject ? subjectHasTextbook(subject) : false,
      categories: categoryNames,
      categoryKeywords,
      textbooks: textbooksWithTopics,
      chapters: chapters.map((c) => ({ id: c.id, name: c.name })),
      selectedTextbookId: textbookId,
      selectedChapterId: chapterId,
      chapterKeywordCount,
    });
  }

  // ---------- 不带参数：保留原有的全量关键词树（向后兼容） ----------
  const keywords = await getKeywords();
  return NextResponse.json({
    ...base,
    keywordTree: buildKeywordTree(keywords),
  });
}

/**
 * 把前端输入的显示型日期转成 date 列可接受的 ISO 格式。
 * 前端默认填入的是「10月3日」这种给人看的文本，直接写入 date 列会被 PostgreSQL 拒绝。
 * 支持：10月3日 / 10-3 / 10/3 / 2026-10-03；无法解析时返回 null（该列可为空）。
 */
function parseDisplayDate(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // 已是 ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const year = new Date().getFullYear();
  const cn = raw.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (cn) {
    const m = Number(cn[1]);
    const d = Number(cn[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }

  const sep = raw.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (sep) {
    const m = Number(sep[1]);
    const d = Number(sep[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }

  // 其它格式（如「周三」）不写入日期列，避免整条记录写入失败
  return null;
}

export async function POST(request: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.message }, { status: guard.status });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const op = String(body.op ?? "");
  const supabase = await createClient();

  // ---------- 写入学生档案 ----------
  if (op === "student") {
    const name = String(body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ ok: false, error: "缺少学生姓名。" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("feedback_students")
      .upsert(
        {
          name,
          subject: body.subject ? String(body.subject) : null,
          salutation: body.salutation ? String(body.salutation) : null,
          teacher: body.teacher ? String(body.teacher) : null,
          type: body.type ? String(body.type) : null,
          notes: body.notes ? String(body.notes) : null,
        },
        { onConflict: "user_id,name" },
      )
      .select("id, name, updated_at")
      .single();

    if (error) {
      console.error("[feedback/data] 保存档案失败:", error.code, error.message);
      return NextResponse.json({ ok: false, error: "保存档案失败。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, student: data });
  }

  // ---------- 写入反馈历史 ----------
  if (op === "history") {
    const studentName = String(body.studentName ?? "").trim();
    const text = String(body.text ?? "").trim();
    if (!studentName || !text) {
      return NextResponse.json({ ok: false, error: "缺少学生姓名或反馈正文。" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("feedback_history")
      .insert({
        student_name: studentName,
        text,
        date: parseDisplayDate(body.date),
        type_name: body.typeName ? String(body.typeName) : null,
        subject: body.subject ? String(body.subject) : null,
      })
      .select("id, student_name, created_at")
      .single();

    if (error) {
      // 把数据库错误码/细节带出来，便于定位（不暴露给前端敏感信息）
      console.error(
        "[feedback/data] 保存历史失败:",
        error.code,
        error.message,
        error.details ?? "",
        error.hint ?? "",
        "| 入参 date =",
        JSON.stringify(body.date),
      );
      return NextResponse.json({ ok: false, error: "保存历史失败。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, history: data });
  }

  return NextResponse.json({ ok: false, error: "未知的 op。" }, { status: 400 });
}

export async function DELETE(request: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.message }, { status: guard.status });
  }

  const params = request.nextUrl.searchParams;
  const student = params.get("student");
  const id = params.get("id");
  const supabase = await createClient();

  // 删除单条历史
  if (id) {
    const { error } = await supabase.from("feedback_history").delete().eq("id", Number(id));
    if (error) {
      console.error("[feedback/data] 删除历史失败:", error.code, error.message);
      return NextResponse.json({ ok: false, error: "删除失败。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // 删除学生档案（连带其历史）
  if (student) {
    const { error: histError } = await supabase
      .from("feedback_history")
      .delete()
      .eq("student_name", student);
    const { error } = await supabase.from("feedback_students").delete().eq("name", student);

    if (histError || error) {
      console.error("[feedback/data] 删除档案失败:", histError?.code, error?.code);
      return NextResponse.json({ ok: false, error: "删除失败。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "缺少 id 或 student 参数。" }, { status: 400 });
}
