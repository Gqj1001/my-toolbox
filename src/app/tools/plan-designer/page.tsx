import Link from "next/link";
import { redirect } from "next/navigation";
import SiteHeader from "@/components/site-header";
import { getViewer } from "@/lib/viewer";
import PlanDesignerClient from "./plan-designer-client";

export const dynamic = "force-dynamic";

export default async function PlanDesignerPage() {
  const viewer = await getViewer();
  if (!viewer.user) redirect("/login?redirectTo=/tools/plan-designer");
  return (
    <>
      <SiteHeader role={viewer.role ?? "user"} current="/tools" adminScope={viewer.adminScope} />
      <div className="border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        <Link href="/tools" className="underline">← 返回工具列表</Link>
        <span className="ml-3">个性化辅导方案设计器 · 新 xlsx 模板 · 支持预科选课与模块排序</span>
      </div>
      <PlanDesignerClient isVip={!!viewer.membership.isVip} />
    </>
  );
}
