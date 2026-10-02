import ToolCard from "@/components/tool-card";
import type { ToolView } from "@/lib/tools-db";

type ToolGridProps = {
  tools: ToolView[];
};

export default function ToolGrid({ tools }: ToolGridProps) {
  if (tools.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        暂时没有可用工具。请联系管理员在 tools 表中添加。
      </p>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tools.map((tool) => (
        <li key={String(tool.id)}>
          <ToolCard tool={tool} />
        </li>
      ))}
    </ul>
  );
}
