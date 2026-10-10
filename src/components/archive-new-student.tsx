"use client";

import { useActionState } from "react";
import { createStudent, type ArchiveActionState } from "@/app/dashboard/archive-actions";

const initialState: ArchiveActionState = { status: "idle" };

const field =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";

/**
 * 「新建学生」表单。
 *
 * ⚠️ 只收**身份字段**（姓名/年级/校区/教师）—— 分数、课时、薄弱模块属于「某一次方案」，
 *    不在档案这一层。这与两个工具里「保存档案」的口径一致。
 */
export default function NewStudentForm() {
  const [state, formAction, isPending] = useActionState(createStudent, initialState);

  return (
    <form
      action={formAction}
      className="rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <p className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">新建学生</p>

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">姓名 *</span>
          <input name="name" required maxLength={100} placeholder="如 张三" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">年级</span>
          <input name="grade" placeholder="如 高三" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">校区</span>
          <input name="campus" placeholder="如 燕郊中学校区" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">教师</span>
          <input name="teacher" placeholder="如 郭庆杰" className={field} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {isPending ? "保存中…" : "新建"}
        </button>
        {state.status === "error" && state.message ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {state.message}
          </span>
        ) : null}
        {/* 姓名为空时不会有成功态（服务端会先返回错误） */}
      </div>
    </form>
  );
}
