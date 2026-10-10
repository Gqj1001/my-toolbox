import Link from "next/link";
import NewStudentForm from "@/components/archive-new-student";
import StudentEditor from "@/components/archive-student-editor";
import SiteHeader from "@/components/site-header";
import {
  getHistoryFresh,
  getStudentsFresh,
  historyByStudent,
  studentsByName,
} from "@/lib/feedback-db";
import { getViewer } from "@/lib/viewer";

/** 记录按工具分组时的显示名与顺序（顺序 = 老师看档案的习惯：方案 → 卷子 → 反馈） */
const TOOL_META: Record<string, { label: string; badge: string }> = {
  "math-plan": { label: "辅导方案", badge: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  paper: { label: "试卷分析", badge: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  feedback: { label: "课后反馈", badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
};
const TOOL_ORDER = ["math-plan", "paper", "feedback"];
/** 认不出来的归属（将来加工具时会先出现这种）也要显示出来，不能静默丢掉 */
function toolMeta(tool: string) {
  return TOOL_META[tool] ?? { label: tool || "未标归属", badge: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
}

type HistoryItem = {
  id?: number;
  text?: string;
  date?: string;
  typeName?: string;
  subject?: string;
  tool?: string;
  title?: string;
  score?: number | null;
  fullScore?: number | null;
};

const card =
  "rounded-xl border border-zinc-200 bg-white px-4 py-3.5 transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700";
const input =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const ghostBtn =
  "inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 px-3.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800";

/**
 * ⚠️ 强制动态渲染：这页整页都是**当前用户的数据**，静态预渲染没有意义。
 *
 * 不写它的后果（2026-10 实测）：`next build` 会试着预渲染 `/`，而 `/` 会
 * `redirect("/dashboard")`，于是构建期真的去查了一次库 —— 那一次没有 cookie，
 * 查询抛 "Dynamic server usage"，被 `softFail` 接住并打出一行**看着像故障**的日志
 * （构建结果其实是对的：路由表里 /dashboard 仍是 ƒ 动态）。
 * 加了这行，构建期就不再尝试，日志干净，语义也明确（用户相关页面 = 动态）。
 *
 * ⚠️ 不要删掉它再"靠 cookies 自动判定"：那正是上面那条误导日志的来源。
 */
export const dynamic = "force-dynamic";

/**
 * 百宝箱 = **学员档案**（2026-10 起）。
 *
 * 干什么：把每个学生的**辅导方案 / 试卷分析 / 课后反馈**收集到一处，按学生看。
 * 定位由用户 2026-10 拍板：「能看又能改」（名单 + 新建/修改/删除 + 看这个人的全部记录）；
 * 「按这些信息生成整体学情分析」是**以后**的事。
 *
 * ⚠️ 数据只从 `src/lib/feedback-db.ts` 取，用 `studentsByName()` / `historyByStudent()`
 *    装配 —— 与 `/api/students` **同一份形状**。
 *    不要在这里另写一套拼装（"第二个来源"是本项目反复踩过的坑）。
 * ⚠️ 用的是 `getStudentsFresh()` / `getHistoryFresh()`（**不缓存**），不是 `getStudents()`：
 *    缓存版有 25 秒进程内 TTL，而写入发生在**别的请求**里（Server Action / 另一个标签页），
 *    实测会出现「刚保存成功、页面显示正常，但读接口最长 25 秒返回空」。
 *    档案页以看为主，**正确性优先于省一次往返**。原因详见 feedback-db 里的注释。
 */
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const [viewer, studentRows, historyRows] = await Promise.all([
    getViewer(),
    getStudentsFresh(),
    getHistoryFresh(),
  ]);
  const { role } = viewer;

  const params = await searchParams;
  const selected = typeof params.name === "string" && params.name.trim() ? params.name.trim() : "";
  const q = typeof params.q === "string" ? params.q.trim() : "";

  const all = studentsByName(studentRows);
  const allHistory = historyByStudent(historyRows);

  /** 每位学生的记录条数（列表上要显示） */
  const countOf = (name: string) => (allHistory[name] ?? []).length;

  const names = Object.keys(all).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const filtered = q ? names.filter((n) => n.includes(q)) : names;

  // ---------------- 详情视图 ----------------
  if (selected) {
    const isKnown = selected in all;
    const info = (all[selected] ?? {}) as Record<string, unknown>;
    const items = ((allHistory[selected] ?? []) as HistoryItem[]).slice().reverse();   // 新的在前
    const groups = TOOL_ORDER
      .map((t) => ({ tool: t, items: items.filter((i) => (i.tool ?? "feedback") === t) }))
      .filter((g) => g.items.length);
    // 没登记在 TOOL_ORDER 里的归属也要显示（防止将来加工具时静默丢数据）
    const extraTools = [...new Set(items.map((i) => i.tool ?? "feedback"))]
      .filter((t) => !TOOL_ORDER.includes(t));
    for (const t of extraTools) {
      groups.push({ tool: t, items: items.filter((i) => (i.tool ?? "feedback") === t) });
    }

    return (
      <>
        <SiteHeader role={role ?? "user"} current="/dashboard" />
        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
          <Link href="/dashboard" className="w-fit text-sm text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            ← 返回学员名单
          </Link>

          <header className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{selected}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {[info.grade, info.campus, info.teacher].filter(Boolean).join(" · ") || "还没有填年级 / 校区 / 教师"}
              {" · 共 "}{items.length}{" 条记录"}
            </p>
          </header>

          {!isKnown ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              这位学生只有记录、还没有档案行（可能是工具直接存的记录）。用下面的「修改档案」补一下信息即可。
            </p>
          ) : null}

          <StudentEditor
            name={selected}
            grade={String(info.grade ?? "")}
            campus={String(info.campus ?? "")}
            teacher={String(info.teacher ?? "")}
          />

          {groups.length ? (
            groups.map((g) => {
              const meta = toolMeta(g.tool);
              return (
                <section key={g.tool} className="flex flex-col gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.badge}`}>{meta.label}</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">{g.items.length} 条</span>
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {g.items.map((it) => (
                      <li key={String(it.id ?? `${g.tool}-${it.date}-${it.title}`)} className={card}>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                            {it.title || it.typeName || "（未填名称）"}
                          </span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {it.date || "未填日期"}
                            {it.score != null ? ` · ${it.score}${it.fullScore != null ? ` / ${it.fullScore}` : ""} 分` : ""}
                          </span>
                        </div>
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs text-zinc-500 dark:text-zinc-400">展开全文</summary>
                          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
{it.text || "（这条记录没有正文）"}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          ) : (
            <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              这位学生还没有记录。在「辅导方案」「试卷分析」里选中他/她并保存，记录就会出现在这里。
            </p>
          )}
        </main>
      </>
    );
  }

  // ---------------- 名单视图 ----------------
  return (
    <>
      <SiteHeader role={role ?? "user"} current="/dashboard" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">学员档案</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            把每个学生的辅导方案、试卷分析、课后反馈收集到一处。
            共 {names.length} 位学生
            {q ? `，匹配「${q}」${filtered.length} 位` : ""}。
          </p>
        </header>

        <NewStudentForm />

        <form method="get" className="flex flex-wrap items-center gap-2">
          <input name="q" defaultValue={q} placeholder="按姓名搜索" className={`${input} sm:w-56`} />
          <button type="submit" className={ghostBtn}>搜索</button>
          {q ? (
            <Link href="/dashboard" className="text-xs text-zinc-500 underline dark:text-zinc-400">
              清空
            </Link>
          ) : null}
        </form>

        {filtered.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {filtered.map((n) => {
              const info = all[n] as Record<string, unknown>;
              const parts = [info.grade, info.campus, info.teacher].filter(Boolean) as string[];
              return (
                <li key={n}>
                  <Link href={`/dashboard?name=${encodeURIComponent(n)}`} className={`${card} block`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{n}</span>
                      <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{countOf(n)} 条记录</span>
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {parts.length ? parts.join(" · ") : "还没填年级 / 校区 / 教师"}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            {q ? `没有找到名字含「${q}」的学生。` : "还没有学生。用上面的「新建学生」加一位，或者去工具里保存档案。"}
          </p>
        )}
      </main>
    </>
  );
}
