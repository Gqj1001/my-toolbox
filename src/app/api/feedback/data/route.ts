import { NextResponse, type NextRequest } from "next/server";
import {
  assembleCategoryKeywords,
  getCategories,
  getChapters,
  getChaptersByScope,
  getChaptersByTextbookIds,
  getDataVersion,
  getHistory,
  getKeywords,
  getPhrases,
  getStudents,
  getTextbooks,
  historyByStudent,
  invalidateHistory,
  invalidateStudents,
  studentsByName,
} from "@/lib/feedback-db";
import { parseScope, subjectHasTextbook } from "@/lib/feedback-taxonomy";
import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/viewer";

/**
 * 课后反馈工作台的数据接口。
 *
 * 所有读写都走服务端 Supabase 客户端（带用户会话），
 * 因此 RLS 会对 feedback_students / feedback_history 自动按 auth.uid() 隔离，
 * 前端无法越权访问他人数据。
 *
 * GET    /api/feedback/data?stage=&subject=…    按「学段 × 科目」拉取（**必传**）
 *        可选 &textbook=<id>&chapter=<id>       进一步限定教材/章节
 *        ⚠️ 不带维度参数 → 400 scope_required。
 *           从前这里返回「全量关键词树」，但 PostgREST 默认只给 1000 行，
 *           而未归档关键词已达 8992 行 —— 那个分支一直在静默丢 89% 的数据，故移除。
 *           关键词一律按维度拉取；响应里同时带回 categories / textbooks / chapters
 *           / categoryKeywords / phrases / students / history / isAdmin / dataVersion。
 *           `dataVersion` 只服务**浏览器端**缓存（IndexedDB，见 docs/perf-notes.md
 *           「客户端缓存」一节）：版本号没变就说明静态数据没被后台改过，缓存可以继续用。
 *           ⚠️ 2026-10：工具页启动**不再**先打 /api/feedback/mode 取身份 ——
 *              `isAdmin` 就在本接口的响应里，云端模式的首屏只打这一次请求。
 *              （多那一跳会多跑一次中间件：auth 校验 + user_roles 查询。）
 * POST   /api/feedback/data  { op: 'student' | 'history', ... }   写入
 * DELETE /api/feedback/data?student=姓名        删除档案（同时删其历史）
 * DELETE /api/feedback/data?id=<historyId>      删除单条历史
 */

/**
 * 鉴权守卫。
 *
 * ⚠️ 这里从前是 `getCurrentUserWithRole()` + **又一次** `select("status")` 查询 ——
 *    而 getViewer() 已经同时拿到 user / role / membership.status。
 *    多出来的那一次是纯浪费（实测：每次请求白付 1 次 Supabase 往返，
 *    用户环境约 500ms）。现在改为直接用 getViewer()。
 */
async function requireUser() {
  const viewer = await getViewer();
  if (!viewer.user) return { ok: false as const, status: 401, message: "请先登录。" };

  if (viewer.membership.status === "banned") {
    return { ok: false as const, status: 403, message: "账号已被封禁。" };
  }
  return { ok: true as const, user: viewer.user, role: viewer.role ?? "user" };
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

  // ---------- 带维度参数：只取所需关键词，并附上分类/教材/章节清单 ----------
  if (hasScope) {
    const { stage, subject, textbookId, chapterId } = scope;

    // 基础数据（短语 / 档案 / 历史）与关键词无关，但前端每次打开都要。
    // 从前它们在函数最开头无条件查，导致**每次请求都白付约 780ms**（实测 308+148+324）；
    // 现在收进本分支并与下面的查询并发，取消选课时不再触发。
    // ⚠️ students / history 是**按用户**的数据，必须把 user.id 传进去当缓存 key ——
    //    不然会把别人的档案/历史缓存到共享桶里发出去（RLS 只保证「查出来的是本人的」，
    //    保证不了「缓存 key 不串号」）。
    const [phrases, students, history] = await Promise.all([
      getPhrases(),
      getStudents(guard.user.id),
      getHistory(guard.user.id),
    ]);

    const categories = stage || subject ? await getCategories(stage) : await getCategories();
    const categoryNames = categories.map((c) => c.name);

    // ⚠️ 必须同时按 subject 过滤：只按 stage 会把该学段**所有科目**的教材都捞回来
    //    （senior 有 129 本），下面的章节查询会跟着放大成 129 次。
    const textbooks = subject
      ? await getTextbooks({ stage, subject })
      : await getTextbooks({ stage });

    // 只查「当前选中教材」的章节。
    // 从前这里对每本教材各查一次章节（N+1）：senior+math 会发 29 次、每次约 124ms。
    // 而前端只有「已选中那本」会用到 topics（selectedBookTopics()），
    // 教材下拉只用 version / name / id —— 所以其余教材的章节名是白拿的。
    // 例外：没指定册次时，册次下拉仍需要各册的章节数，见下面 fallback。
    // ⚠️ 现在按「学段|科目」取整片章节再挑出这一本（见 feedback-db 的注释）：
    //    这样同一科目内换教材不再各自 miss 一次。
    const selectedBookChapters = textbookId ? await getChapters(textbookId) : [];

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

    let fallbackTopics: Map<number, string[]> | null = null;
    if (!textbookId && textbooks.length) {
      // 只走一次查询：把该科目全部教材的章节一次取回，在内存里按教材分组。
      // 这样「不指定册次」时下拉仍有册次信息，且总请求数固定为 1（不是 N）。
      // ⚠️ 直接传「学段+科目」给 getChaptersByScope：它跟上面 getChapters(选中那本)
      //    共用同一份缓存，所以这里通常**一次查询都不用发**。
      const all =
        stage && subject
          ? await getChaptersByScope(stage, subject)
          : await getChaptersByTextbookIds(textbooks.map((t) => t.id));
      fallbackTopics = new Map();
      for (const ch of all) {
        const list = fallbackTopics.get(ch.textbook_id) ?? [];
        list.push(ch.name);
        fallbackTopics.set(ch.textbook_id, list);
      }
    }

    const isSelectedBook = (id: number) => String(id) === String(textbookId);
    const topicsFor = (t: (typeof textbooks)[number]): string[] => {
      if (isSelectedBook(t.id)) return selectedBookChapters.map((c) => c.name);
      return fallbackTopics?.get(t.id) ?? [];
    };

    const textbooksWithTopics = textbooks.map((t) => ({
      id: t.id,
      name: t.name,
      version: t.version,
      stage: t.stage,
      subject: t.subject,
      topics: topicsFor(t),
    }));

    const chapters = textbookId ? selectedBookChapters : [];

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
      // 数据版本号：浏览器端缓存（IndexedDB）拿它判断本地那份是否还有效。
      // 只有「会改静态表的代码路径」（两个 admin actions 的 revalidate()）会让它 +1，
      // 所以正常情况下同一维度反复访问版本号不变 ⇒ 客户端缓存可以一直用、不重渲染。
      // ⚠️ 它是**提示**，不是鉴权依据；也不参与服务端缓存判定。
      dataVersion: getDataVersion(),
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

  // ---------- 不带参数：不再返回全量关键词树 ----------
  // 从前这里返回「全量关键词树」（向后兼容）。但 PostgREST 默认只返回 1000 行，
  // 而 feedback_keywords 未归档已达 8992 行 —— 也就是说这个分支**一直在静默丢 89% 的数据**，
  // 前端拿到的是一棵残缺的树。既慢又错，故改为明确拒绝：
  //   · 工具页云端模式下直接调本接口（带维度参数）拿全部数据（含 isAdmin）
  //   · 关键词一律由 loadCloudScoped 按维度取
  return NextResponse.json(
    {
      ok: false,
      error: "该接口需要指定维度参数。请使用 ?stage=&subject=（可选 &textbook=&chapter=）。",
      code: "scope_required",
    },
    { status: 400 },
  );
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
    // ⚠️ 写完必须立刻清缓存，否则「刚存的档案」在 25 秒内看不到。
    //    （缓存只是少查库，不能改变「存完就能看到」这个用户能感知的行为。）
    //    注意这里清的是**整个按用户缓存**（进程级，分不清是哪个请求写的），
    //    所以别的用户会跟着多查一次库 —— 方向是安全的，只是略微浪费。
    invalidateStudents();
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
    // 同上：清掉历史缓存，保证「刚存的记录马上能看到」
    invalidateHistory();
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
    // 清掉历史缓存，保证「删掉的记录马上消失」（不然它会从缓存里再回来 25 秒）
    invalidateHistory();
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
    // 档案和它的历史都动了，两份缓存一起清
    invalidateStudents();
    invalidateHistory();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "缺少 id 或 student 参数。" }, { status: 400 });
}
