import Link from "next/link";
import SiteHeader from "@/components/site-header";
import BatchImportPanel from "@/components/batch-import-panel";
import { getCurrentUserWithRole } from "@/lib/auth-role";

export const dynamic = "force-dynamic";

export default async function AdminImportPage() {
  const { role } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return (
      <>
        <SiteHeader role={role ?? "user"} current="/admin" />
        <main className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-6 py-10">
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            没有访问权限：批量导入仅对 Owner/管理员开放。
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <SiteHeader role="admin" current="/admin" />
      <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-4xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <Link href="/admin" className="w-fit text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          ← 返回管理后台
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">批量导入</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-300">
            用 Excel 一次建多个学生档案；导入后归属当前账号，可在 `/admin/archives` 或 `/dashboard` 查看。
          </p>
        </header>
        <BatchImportPanel />
      </main>
    </>
  );
}
