import Link from "next/link";
import ToolIcon from "@/components/tool-icon";
import type { ToolView } from "@/lib/tools-db";

type ToolCardProps = {
  tool: ToolView;
};

export default function ToolCard({ tool }: ToolCardProps) {
  const locked = tool.locked;

  return (
    <Link
      href={tool.href}
      aria-label={locked ? `${tool.name}（会员专属，前往开通）` : tool.name}
      className={`group relative flex h-full flex-col gap-3 rounded-xl border p-5 transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100 ${
        locked
          ? "border-amber-300 bg-amber-50/50 hover:border-amber-400 dark:border-amber-900 dark:bg-amber-950/20"
          : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`relative flex h-11 w-11 items-center justify-center rounded-lg ${
            locked
              ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          }`}
        >
          <ToolIcon name={tool.icon} />
          {locked ? (
            <span
              className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-white ring-2 ring-white dark:ring-zinc-900"
              aria-hidden="true"
            >
              <ToolIcon name="lock" className="h-3 w-3" />
            </span>
          ) : null}
        </span>

        {locked ? (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            会员专属
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">{tool.name}</h2>
        {tool.description ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{tool.description}</p>
        ) : null}
      </div>

      <span
        className={`mt-auto pt-2 text-sm font-medium transition ${
          locked
            ? "text-amber-700 group-hover:text-amber-900 dark:text-amber-400 dark:group-hover:text-amber-200"
            : "text-zinc-400 group-hover:text-zinc-900 dark:text-zinc-500 dark:group-hover:text-zinc-100"
        }`}
      >
        {locked ? "开通会员解锁 →" : "打开工具 →"}
      </span>
    </Link>
  );
}
