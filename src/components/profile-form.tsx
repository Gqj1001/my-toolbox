"use client";

import { useActionState } from "react";
import { saveProfileAction, type ProfileActionState } from "@/app/account/profile-actions";
import { PROFILE_SUBJECTS } from "@/lib/user-profile";

const initialState: ProfileActionState = { status: "idle" };

const field =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";
const label = "text-xs text-zinc-500 dark:text-zinc-400";

type Props = {
  teacherName: string;
  subject: string;
  campus: string;
  sigTeacher: string;
  /** 从"注册后的引导页"来时给 true：保存后直接进个人中心 */
  goTools?: boolean;
  /** 保存按钮文案 */
  submitText?: string;
};

/**
 * 「我的资料」表单（姓名 / 学科 / 校区 / 落款）。
 *
 * 用户口径：
 *   · 姓名与学科**必填**（落款默认就是"学科+姓名+老师"，例：数学郭老师）；
 *   · 校区是**机构校区**（老师所在校区）—— 与学生的"学校"不是一回事，文案里写清楚；
 *   · 落款可以留空（留空就自动拼），也能手填覆盖。
 *
 * ⚠️ 保存成功要**留在本页**（不跳走），并把"以后导出都用这份信息"说清楚 ——
 *    不然老师不知道填了有什么用。
 */
export default function ProfileForm({
  teacherName, subject, campus, sigTeacher, goTools = false, submitText = "保存信息",
}: Props) {
  const [state, action, pending] = useActionState(saveProfileAction, initialState);

  return (
    <form action={action} className="flex flex-col gap-4">
      {goTools ? <input type="hidden" name="go_tools" value="1" /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={`${label} flex flex-col gap-1`}>
          <span>姓名 *（会用在落款和导出的文件上）</span>
          <input name="teacher_name" required maxLength={40} defaultValue={teacherName}
            placeholder="如 郭庆杰" className={field} />
        </label>

        <label className={`${label} flex flex-col gap-1`}>
          <span>学科 *</span>
          <select name="subject" required defaultValue={subject} className={field}>
            <option value="">请选择</option>
            {PROFILE_SUBJECTS.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className={`${label} flex flex-col gap-1`}>
          <span>校区（你所在的机构校区）</span>
          <input name="campus" maxLength={40} defaultValue={campus}
            placeholder="如 燕郊校区" className={field} />
        </label>

        <label className={`${label} flex flex-col gap-1`}>
          <span>落款（留空 = 自动用「学科+姓名+老师」）</span>
          <input name="sig_teacher" maxLength={40} defaultValue={sigTeacher}
            placeholder="如 数学郭老师" className={field} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? "保存中…" : submitText}
        </button>
        {state.status === "error" && state.message ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">{state.message}</span>
        ) : null}
        {state.status === "ok" && state.message ? (
          <span role="status" className="text-xs text-emerald-600 dark:text-emerald-400">{state.message}</span>
        ) : null}
      </div>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        说明：这些信息只属于你自己的账号，别的老师看不到。学生档案里的「学校」是**学生就读的学校**，
        与这里的「校区」不是一回事。
      </p>
    </form>
  );
}
