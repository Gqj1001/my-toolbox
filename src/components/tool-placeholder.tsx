import Link from "next/link";
import SiteHeader from "@/components/site-header";
import ToolIcon from "@/components/tool-icon";
import type { Tool } from "@/lib/tools";

type ToolPlaceholderProps = {
  tool: Tool;
  email: string | null;
  role: "admin" | "user";
  authorized: boolean;
};

export default function ToolPlaceholder({ tool, email, role, authorized }: ToolPlaceholderProps) {
  return (
    <>
      <SiteHeader email={email} role={role} current="/dashboard" />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
        <Link
          href="/dashboard"
          className="w-fit text-sm text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← 返回百宝箱
        </Link>

        {!authorized ? (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            没有访问权限：该工具需要更高权限。
          </p>
        ) : null}

        <header className="flex items-start gap-4">
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${
              tool.access === "admin"
                ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            }`}
          >
            <ToolIcon name={tool.icon} />
          </span>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              {tool.name}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{tool.description}</p>
          </div>
        </header>

        <section className="rounded-xl border border-dashed border-zinc-300 bg-white/60 px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">功能开发中</p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            这里是占位页面。后续会在
            <code className="mx-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              src/app/tools/{tool.slug}/page.tsx
            </code>
            中补充具体功能。
          </p>
        </section>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">工具标识</dt>
            <dd className="mt-0.5 font-mono text-zinc-800 dark:text-zinc-200">{tool.slug}</dd>
          </div>
          <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">访问要求</dt>
            <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">
              {tool.access === "admin" ? "仅管理员" : "所有登录用户"}
            </dd>
          </div>
        </dl>
      </main>
    </>
  );
}
