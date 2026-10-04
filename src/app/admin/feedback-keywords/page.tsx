import Link from "next/link";
import KeywordEditor, { type KeywordRowView } from "@/components/keyword-editor";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import {
  getCategories,
  getChapters,
  getKeywords,
  getPhrases,
  getTextbooks,
} from "@/lib/feedback-db";
import { SUBJECTS, getSubjectsForStage, isValidStage, type Stage } from "@/lib/feedback-taxonomy";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "反馈关键词管理 | My Toolbox",
};

type SearchParams = Promise<{
  stage?: string;
  subject?: string;
  textbook?: string;
  chapter?: string;
}>;

function toId(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default async function FeedbackKeywordsPage({ searchParams }: { searchParams: SearchParams }) {
  // proxy.ts 已经把非管理员拦在 /admin/* 之外，这里再校验一次（纵深防御）
  const { user, role } = await getCurrentUserWithRole();

  if (role !== "admin") {
    return (
      <>
        <SiteHeader email={user?.email ?? null} role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：该页面仅对 admin 角色开放。
          </p>
        </main>
      </>
    );
  }

  const sp = await searchParams;
  const stage: Stage = isValidStage(sp.stage) ? sp.stage : "senior";
  const subjectRaw = String(sp.subject ?? "");
  const subject = SUBJECTS.some((s) => s.code === subjectRaw) ? subjectRaw : null;
  const textbookId = toId(sp.textbook);
  const chapterId = toId(sp.chapter);

  // ---------- 按维度取数 ----------
  const [categories, phrases] = await Promise.all([getCategories(stage), getPhrases()]);
  const categoryNames = categories.map((c) => c.name);

  const textbooks = subject ? await getTextbooks({ stage, subject }) : [];
  const chapters = subject && textbookId ? await getChapters(textbookId) : [];

  // 关键词维度：
  //   未选科目        → 不取关键词（只显示概况）
  //   只选科目        → 该科目「不分教材/章节」的词（通用分类 + 通用内容词）
  //   选了教材未选章   → 该教材全部章节词 + 通用分类词
  //   选了章节        → 该章节词 + 通用分类词
  let keywordRows: KeywordRowView[] = [];
  if (subject) {
    const otherCats = categoryNames.filter((c) => c !== "课堂内容" && c !== "下节课内容");

    // 6 个通用分类的词（任何维度下都要）
    const genericOther = await getKeywords({
      stage,
      subject,
      textbookId: null,
      chapterId: null,
      // 通用分类只会出现在无归属行里
    });

    let contentRows: Awaited<ReturnType<typeof getKeywords>> = [];
    if (chapterId) {
      contentRows = await getKeywords({ stage, subject, chapterId });
    } else if (textbookId) {
      contentRows = await getKeywords({ stage, subject, textbookId });
    } else {
      contentRows = await getKeywords({ stage, subject, textbookId: null, chapterId: null });
    }

    const others = genericOther.filter((r) => otherCats.includes(r.category));
    keywordRows = [...contentRows, ...others] as KeywordRowView[];
  }

  // 按分类分组。
  // 章节关键词在「课堂内容」和「下节课内容」下各有一行（同一知识点两处可选），
  // 渲染时在同分类内按关键词去重，避免重复项。
  const byCategory: Record<string, KeywordRowView[]> = {};
  for (const name of categoryNames) byCategory[name] = [];
  {
    const seen = new Set<string>();
    for (const r of keywordRows) {
      if (r.chapter_id !== null) {
        const dedupKey = `${r.category}|${r.chapter_id}|${r.keyword}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
      }
      byCategory[r.category] ??= [];
      byCategory[r.category].push(r);
    }
  }

  // ---------- 概况统计 ----------
  const supabase = await createClient();
  const [totalRes, archivedRes, tbRes, chRes] = await Promise.all([
    supabase.from("feedback_keywords").select("*", { count: "exact", head: true }).is("archived_at", null),
    supabase.from("feedback_keywords").select("*", { count: "exact", head: true }).not("archived_at", "is", null),
    supabase.from("feedback_textbooks").select("*", { count: "exact", head: true }),
    supabase.from("feedback_chapters").select("*", { count: "exact", head: true }),
  ]);
  const summary = {
    total: totalRes.count ?? 0,
    archived: archivedRes.count ?? 0,
    textbooks: tbRes.count ?? 0,
    chapters: chRes.count ?? 0,
    categories: categories.length,
  };

  const subjects = getSubjectsForStage(stage).map((s) => ({ code: s.code, name: s.name }));

  return (
    <>
      <SiteHeader email={user?.email ?? null} role="admin" current="/admin" />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <nav className="text-xs text-zinc-500 dark:text-zinc-400">
              <Link href="/admin" className="hover:underline">
                用户与权限管理
              </Link>
              <span className="mx-1">/</span>
              <span>反馈关键词管理</span>
            </nav>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              反馈关键词管理
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              共 {summary.total} 个关键词（另有 {summary.archived} 个已归档）、{phrases.length} 条短语、
              {summary.textbooks} 本教材 / {summary.chapters} 个章节。所有登录用户共享这份词库，
              <span className="font-medium text-zinc-700 dark:text-zinc-300">仅管理员可修改</span>。
            </p>
          </div>

          <div className="flex gap-2">
            <Link
              href="/tools/feedback"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              打开工具页 ↗
            </Link>
            <Link
              href="/admin"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              ← 返回用户管理
            </Link>
          </div>
        </div>

        <KeywordEditor
          stage={stage}
          subject={subject}
          textbookId={textbookId}
          chapterId={chapterId}
          subjects={subjects}
          textbooks={textbooks.map((t) => ({ id: t.id, version: t.version, name: t.name }))}
          chapters={chapters.map((c) => ({ id: c.id, name: c.name }))}
          byCategory={byCategory}
          categoryNames={categoryNames}
          phrases={phrases.map((p) => ({ id: p.id, phrase: p.phrase, sort_order: p.sort_order }))}
          summary={summary}
        />

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          所有写操作都在 Server Action 中执行，并在服务端用 requireAdmin() 校验调用者身份；
          数据库侧的 RLS 策略（admins write feedback_keywords / feedback_textbooks / feedback_chapters /
          feedback_categories）是第二道防线。已归档的关键词不会出现在工具页，也不会参与统计。
        </p>
      </main>
    </>
  );
}
