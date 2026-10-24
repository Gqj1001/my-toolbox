"use client";

import { useActionState } from "react";
import { deleteStudent, updateStudent, type ArchiveActionState } from "@/app/dashboard/archive-actions";

const initialState: ArchiveActionState = { status: "idle" };

const field =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100";

type Props = {
  name: string;
  grade: string;
  /** 学生的**学校**（数据库列名仍叫 campus —— 见下面说明，不改列名、不动历史数据） */
  campus: string;
  /** 学管师（该学生的对接人）。⚠️ 列名是 `manager`，与"任课教师"不是一回事。 */
  manager: string;
  /** 目标分数（存在 `extra.targetScore`，不新增列） */
  targetScore: string;
  /** 总课时数（存在 `extra.totalHours`，不新增列） */
  totalHours: string;
};

/**
 * 一位学生的「改档案」与「删除」。
 *
 * ⚠️ **每个字段配一个「改」勾选框**，勾了才提交这个字段。为什么不用「留空＝不改」：
 *    那样的话「把学校清空」这个合法操作就**没法表达**（留空被当成没改，静默不生效）。
 *    勾选框把「改」和「改成空」分开，两种意图都能表达，也不会有静默失败。
 *    ——服务端 `patchFromForm()` 只把**存在且非空**的字段写进 patch（合并语义）。
 *
 * ★ 2026-10 第十九批（用户口径）：三格 = **年级 / 学校 / 学管师**。
 *   · 第二格：原来叫「校区」，但老师填的其实就是**学生就读的学校**（截图里是「三河一中」）
 *     ⇒ 只改**显示名**，数据库列 `campus` 一个字不动（改列名要迁移 + 会碰到数学方案的写入）。
 *   · 第三格：由「教师」改为「**学管师**」——老师一般只教一门课，任课教师不必每格都填；
 *     而每个学生有独立的学管师，老师要**一眼看到对接人是谁**。
 *     ⚠️ `teacher`（任课教师）**没有被删除**：它仍在库里、仍进学情报告与试卷分析 Word
 *     （"分析人/教师"栏），只是**不再占用档案编辑区的一格**。旧数据一个字不动。
 *
 * ⚠️ 删除是**不可逆**的，而且会连带删掉这个学生在**别家工具**里的记录 —— 必须二次确认，
 *    并且把这一点明说（服务端 `deleteStudentByName` 就是连历史一起删的）。
 */
export default function StudentEditor({ name, grade, campus, manager, targetScore, totalHours }: Props) {
  const [updateState, updateAction, updating] = useActionState(updateStudent, initialState);
  const [delState, delAction, deleting] = useActionState(deleteStudent, initialState);

  const rows: { key: string; label: string; value: string; placeholder?: string }[] = [
    { key: "grade", label: "年级", value: grade, placeholder: "如 高三" },
    { key: "campus", label: "学校", value: campus, placeholder: "如 三河一中" },
    { key: "manager", label: "学管师", value: manager, placeholder: "如 李老师" },
    // ★ 2026-10-23：目标分数 / 总课时数存 `extra`，不新增数据库列。
    //   学情分析会拿它们做「分数目标对比」与「课时消耗」基准。
    { key: "targetScore", label: "目标分数", value: targetScore, placeholder: "如 100" },
    { key: "totalHours", label: "总课时数", value: totalHours, placeholder: "如 40" },
  ];

  return (
    <section className="rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <p className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-200">修改档案</p>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        点「改」才会提交这一项；可以把它改成空（清空）。没点「改」的项保持原样。
        目标分数 / 总课时用于学情分析的目标对比和课时进度。
      </p>

      <form action={updateAction}>
        <input type="hidden" name="name" value={name} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div key={r.key} className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <input type="checkbox" name={`change_${r.key}`} value="1" className="accent-zinc-900 dark:accent-zinc-100" />
                改「{r.label}」
              </label>
              <input name={r.key} defaultValue={r.value} placeholder={r.placeholder ?? (r.value || "未填")} className={field} />
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={updating}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 px-3.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {updating ? "保存中…" : "保存修改"}
          </button>
          {updateState.status === "error" && updateState.message ? (
            <span role="alert" className="text-xs text-red-600 dark:text-red-400">
              {updateState.message}
            </span>
          ) : updateState.status === "success" ? (
            <span role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
              {updateState.message}
            </span>
          ) : null}
        </div>
      </form>

      <hr className="my-4 border-zinc-200 dark:border-zinc-800" />

      <form
        action={delAction}
        onSubmit={(e) => {
          if (
            !window.confirm(
              `确定删除「${name}」的档案吗？\n\n这会**连同他/她在试卷分析、课后反馈、辅导方案里的全部记录一起删掉**，无法撤销。`,
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="name" value={name} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={deleting}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-red-200 px-3.5 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            {deleting ? "删除中…" : "删除这位学生"}
          </button>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            会连同三个工具里这个学生的记录一起删除
          </span>
          {delState.status === "error" && delState.message ? (
            <span role="alert" className="text-xs text-red-600 dark:text-red-400">
              {delState.message}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
