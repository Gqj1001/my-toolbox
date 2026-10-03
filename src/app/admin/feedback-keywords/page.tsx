import Link from "next/link";
import KeywordEditor from "@/components/keyword-editor";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { getKeywords, getPhrases } from "@/lib/feedback-db";

export const metadata = {
  title: "反馈关键词管理 | My Toolbox",
};

/** 科目编码 → 显示名（与工具页的 SUBJECTS 常量保持一致） */
const SUBJECTS: { code: string; name: string }[] = [
  { code: "math", name: "数学" },
  { code: "english", name: "英语" },
  { code: "chinese", name: "语文" },
  { code: "physics", name: "物理" },
  { code: "history", name: "历史" },
  { code: "politics", name: "政治" },
  { code: "chemistry", name: "化学" },
  { code: "general", name: "通用" },
];

export default async function FeedbackKeywordsPage() {
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

  const [keywords, phrases] = await Promise.all([getKeywords(), getPhrases()]);

  // 组装成 subject -> category -> rows
  const byCategory: Record<string, Record<string, typeof keywords>> = {};
  for (const k of keywords) {
    byCategory[k.subject] ??= {};
    byCategory[k.subject][k.category] ??= [];
    byCategory[k.subject][k.category].push(k);
  }

  // 只展示有数据的科目 + 固定科目列表（确保空科目也能新增）
  const subjectCodes = new Set([...SUBJECTS.map((s) => s.code), ...Object.keys(byCategory)]);
  const subjects = SUBJECTS.filter((s) => subjectCodes.has(s.code));

  const totalKeywords = keywords.length;

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
              共 {totalKeywords} 个关键词、{phrases.length} 条短语。所有登录用户共享这份词库，
              <span className="font-medium text-zinc-700 dark:text-zinc-300">仅管理员可修改</span>。
            </p>
          </div>

          <Link
            href="/admin"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            ← 返回用户管理
          </Link>
        </div>

        {totalKeywords === 0 ? (
          <div
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
          >
            <p className="font-medium">关键词库为空</p>
            <p className="mt-1">
              请先执行 <code className="font-mono">supabase/seed_feedback_only.sql</code>{" "}
              导入初始词库（470 个关键词 + 10 条短语），或直接在下方添加。
            </p>
          </div>
        ) : null}

        <KeywordEditor subjects={subjects} byCategory={byCategory} phrases={phrases} />

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          所有写操作都在 Server Action 中执行，并在服务端用 requireAdmin() 校验调用者身份；
          数据库侧的 RLS 策略（admins write feedback_keywords / feedback_phrases）是第二道防线。
        </p>
      </main>
    </>
  );
}
