import Link from "next/link";
import ProfileForm from "@/components/profile-form";
import SiteHeader from "@/components/site-header";
import { getViewer } from "@/lib/viewer";
import { getUserProfile } from "@/lib/user-profile-db";

/**
 * 「完善资料」（注册后的一次性引导页）。
 *
 * 用户 2026-10：「我们能否在**注册页面后**加入填写信息模块，信息填写就需要填写姓名、科目、校区……」
 * 用户已拍板：**可以跳过**（注册是转化关键节点，挡着不让进不好）。
 *
 * 所以这一页：不挡任何功能、右上角一个「以后再说」；个人中心会一直提示补录。
 * ⚠️ 未登录访问 → 直接送回登录页（与 /account/* 同一口径，但这里不 redirect 到 /login
 *    而是给个明确提示，避免"注册完就被踢出去"的困惑）。
 */
export default async function WelcomePage() {
  const viewer = await getViewer();

  if (!viewer.user) {
    return (
      <>
        <SiteHeader role="user" current="" />
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            完善资料
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            请先<Link href="/login" className="font-medium text-zinc-900 underline dark:text-zinc-100">登录</Link>
            ，再来填写资料。
          </p>
        </main>
      </>
    );
  }

  const profile = await getUserProfile(viewer.user.id);

  return (
    <>
      <SiteHeader role={viewer.role ?? "user"} current="" />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            完善一下你的资料
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            填一次，以后课后反馈的**落款**、导出的**档案文件抬头**都会自动用它 —— 不用每次手写。
            <br />
            <b className="text-zinc-700 dark:text-zinc-300">也可以以后再说</b>：不挡你用任何功能，
            随时能在个人中心点「修改信息」补上。
          </p>
        </div>

        <section className="rounded-xl border border-zinc-200 bg-white px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <ProfileForm
            teacherName={profile?.teacherName ?? ""}
            subject={profile?.subject ?? ""}
            campus={profile?.campus ?? ""}
            sigTeacher={profile?.sigTeacher ?? ""}
            goTools
            submitText="保存并进入个人中心"
          />
        </section>

        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/tools" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            以后再说，先去用工具 →
          </Link>
        </p>
      </main>
    </>
  );
}
