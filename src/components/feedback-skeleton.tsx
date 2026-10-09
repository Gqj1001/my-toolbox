import type { ReactNode } from "react";

/**
 * 课后反馈工作台的**静态骨架屏**（不依赖任何 API、不发任何请求）。
 *
 * 用途有两个，同一个组件两处复用，保证风格一致：
 *   1. `tools/feedback/loading.tsx` —— 服务端渲染出页面壳之前，先顶上这一屏；
 *   2. `tools/feedback/page.tsx` 传给 `ToolFrame` —— iframe（工具本体）加载期间顶在它上面。
 *
 * ⚠️ **刻意不渲染顶栏**（2026-10 修的一处 bug）：
 *    它原来在这里渲染了一个 `<SiteHeader>`，于是**同一个页面出现两条导航栏** ——
 *      · 一条来自 `tool-page-shell.tsx`（真实顶栏，带真邮箱与真实角色）；
 *      · 一条来自这里（`email=null` / `role="user"` 的占位顶栏）。
 *    流式渲染会把 `loading` 与页面的输出**都**放进首屏 HTML（分别包在
 *    `<div hidden id="S:N">` 里，靠 JS 水合后移除），所以只要水合被拖慢
 *    （实测用户侧 HTML 下载 10 秒），两条导航栏就会**同时可见** ——
 *    看起来像「登录了两个账号」，实际是两条渲染路径。
 *    顶栏的占位改由 `tools/feedback/loading.tsx` 用一个**灰条**负责 ——
 *    与 `dashboard/loading.tsx`、`tools/loading.tsx` 的既有做法一致
 *    （它们都是灰条，全项目只有这里用了真组件，这正是不一致的来源）。
 *
 * 布局按工具页真实结构复刻（见 public/tools/feedback.html 的
 * `.wrap{grid-template-columns:330px 1fr}`）：**左侧 330px 参数栏 + 右侧主区三块面板**，
 * 这样骨架淡出时不会出现明显的「位置跳变」。
 */
function Line({ w, className = "" }: { w: string; className?: string }) {
  return <div className={`h-3 rounded bg-zinc-200 dark:bg-zinc-800 ${w} ${className}`} />;
}

function Block({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {children}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Block className="mb-3.5">
      <p className="mb-3 text-xs font-medium text-zinc-400 dark:text-zinc-500">{title}</p>
      {children}
    </Block>
  );
}

export default function FeedbackSkeleton() {
  return (
    <main className="w-full flex-1 overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <div
        className="grid items-start gap-4 p-4"
        style={{ gridTemplateColumns: "330px minmax(0, 1fr)" }}
      >
        {/* ---------- 左：参数区 ---------- */}
        <div className="animate-pulse">
          <Panel title="学生与课次">
            <Line w="w-24" />
            <div className="mt-3 flex gap-2">
              <div className="h-9 flex-1 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-9 w-20 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <Line w="w-20" className="mt-4" />
            <div className="mt-3 flex gap-2">
              <div className="h-9 flex-1 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-9 flex-1 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-9 flex-1 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <Line w="w-16" className="mt-4" />
            <div className="mt-3 h-9 w-full rounded-lg bg-zinc-200 dark:bg-zinc-800" />
          </Panel>

          <Panel title="学段 / 科目 / 教材">
            <div className="flex gap-2">
              <div className="h-9 flex-1 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-9 flex-1 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <div className="mt-3 h-9 w-full rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            <div className="mt-3 h-9 w-full rounded-lg bg-zinc-200 dark:bg-zinc-800" />
          </Panel>

          <Block>
            <div className="h-10 w-full rounded-lg bg-zinc-200 dark:bg-zinc-800" />
          </Block>
        </div>

        {/* ---------- 右：关键词区（上） + 结果区（下） ---------- */}
        <div className="animate-pulse">
          {/* 关键词区 */}
          <Block className="mb-3.5">
            <div className="flex flex-wrap items-center gap-2">
              {["w-20", "w-24", "w-16", "w-24", "w-20"].map((w, i) => (
                <div key={i} className={`h-7 rounded-full bg-zinc-200 dark:bg-zinc-800 ${w}`} />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
              ))}
            </div>
          </Block>

          {/* 结果区 */}
          <Block>
            <div className="mb-3 flex items-center gap-2">
              <Line w="w-24" />
              <div className="ml-auto h-8 w-24 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <div className="space-y-2.5">
              {["w-full", "w-11/12", "w-full", "w-10/12", "w-full", "w-9/12"].map((w, i) => (
                <Line key={i} w={w} />
              ))}
            </div>
            <div className="mt-5 flex gap-2">
              <div className="h-9 w-28 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-9 w-28 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            </div>
          </Block>
        </div>
      </div>
    </main>
  );
}
