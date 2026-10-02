import Link from "next/link";
import ToolIcon from "@/components/tool-icon";
import type { Tool } from "@/lib/tools";

type ToolGridProps = {
  tools: Tool[];
  /** 是否在卡片上标注"仅管理员" */
  showAccessBadge?: boolean;
};

export default function ToolGrid({ tools, showAccessBadge = true }: ToolGridProps) {
  if (tools.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        当前没有可用工具。
      </p>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tools.map((tool) => (
        <li key={tool.slug}>
          <Link
            href={tool.href}
            className="group flex h-full flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:focus-visible:outline-zinc-100"
          >
            <div className="flex items-start justify-between gap-3">
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-lg ${
                  tool.access === "admin"
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                }`}
              >
                <ToolIcon name={tool.icon} />
              </span>

              {showAccessBadge && tool.access === "admin" ? (
                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  仅管理员
                </span>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {tool.name}
              </h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{tool.description}</p>
            </div>

            <span className="mt-auto pt-2 text-sm font-medium text-zinc-400 transition group-hover:text-zinc-900 dark:text-zinc-500 dark:group-hover:text-zinc-100">
              打开工具 →
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
