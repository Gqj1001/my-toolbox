import Link from "next/link";
import ProfileForm from "@/components/profile-form";
import SiteHeader from "@/components/site-header";
import { getViewer } from "@/lib/viewer";
import { getUserProfile } from "@/lib/user-profile-db";
import { resolveSignature, subjectName } from "@/lib/user-profile";

/**
 * 「我的资料」（登录后可见）：姓名 / 学科 / 校区 / 落款。
 *
 * 用户 2026-10：「……别忘了再加入一个修改信息的功能即可」。
 * 入口：个人中心会员卡上的「修改信息」按钮（与「修改密码」并排）。
 *
 * ⚠️ 与「修改密码」同样的取舍：单独一页、只干一件事，出错面最小。
 * ⚠️ 这里**直连读资料**（不复用 `/api/feedback/data`，那是给工具页用的）；
 *    读不到（表没建 / 没填）时页面照常可用，只是各框为空 + 顶部一句提示。
 */
export default async function AccountProfilePage() {
  const viewer = await getViewer();
  const profile = viewer.user ? await getUserProfile(viewer.user.id) : null;
  const filled = !!profile && (!!profile.teacherName || !!profile.campus);
  const preview = resolveSignature(profile);

  return (
    <>
      <SiteHeader role={viewer.role ?? "user"} current="" />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            我的资料
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            账号：{viewer.user?.email ?? "（未取到邮箱）"}
            <br />
            填一次就好 —— 以后课后反馈的**落款**、导出的**档案文件抬头**都会自动用这里的姓名与学科。
          </p>
        </div>

        {!filled ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            还没有填过。填好下面这几项，落款与导出就不用手写了
            （不填也能用：导出会退回默认写法）。
          </p>
        ) : null}

        <section className="rounded-xl border border-zinc-200 bg-white px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <ProfileForm
            teacherName={profile?.teacherName ?? ""}
            subject={profile?.subject ?? ""}
            campus={profile?.campus ?? ""}
            sigTeacher={profile?.sigTeacher ?? ""}
          />
        </section>

        {preview ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            现在的落款是：<b className="text-zinc-800 dark:text-zinc-200">{preview}</b>
            {profile?.subject ? `（学科：${subjectName(profile.subject)}）` : ""}
          </p>
        ) : null}

        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/tools" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            ← 返回个人中心
          </Link>
        </p>
      </main>
    </>
  );
}
