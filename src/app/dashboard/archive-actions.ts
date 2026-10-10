"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  deleteStudentByName,
  invalidateHistory,
  invalidateStudents,
  upsertStudent,
  type StudentPatch,
} from "@/lib/feedback-db";
import { getViewer } from "@/lib/viewer";

/**
 * 学员档案（`/dashboard`）的写入口。
 *
 * ⚠️ **不要在这里另写一套写库逻辑**：下面全部走 `src/lib/feedback-db.ts` 的
 *    `upsertStudent()` / `deleteStudentByName()` —— 与 `/api/students` 接口**同一份实现**。
 *    另写一套就是「同一件事有两个来源」，迟早有一边忘了合并语义，
 *    把别家工具存在同一行上的字段静默清空（本项目反复踩过的坑）。
 *
 * ⚠️ 合并语义：`upsertStudent()` 只覆盖**传了的**字段，没传的保持原值。
 *    所以「改档案」时**不要**把空输入框也塞进 patch —— 那会把老师没填的东西清掉。
 */

export type ArchiveActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  /** 新建成功后要跳到哪个学生的详情（由调用方决定怎么用） */
  createdName?: string;
};

/** 与 `/api/students` 一致的守卫：未登录 / 封禁 都不许写。
 *  ⚠️ 顺带把 `user.id` 带出来：`upsertStudent(uid, …)` 的 uid 只用于**缓存 key**
 *  （隐私红线：缓存必须按用户分桶），传进去能省掉一次 `auth.getUser()` 往返
 *  （用户环境约 500ms）。不传虽然也能跑，但要白付一次。 */
async function requireWriter() {
  const viewer = await getViewer();
  if (!viewer.user) return { ok: false as const, message: "登录已过期，请重新登录。" };
  if (viewer.membership.status === "banned") return { ok: false as const, message: "账号已被封禁。" };
  return { ok: true as const, userId: viewer.user.id };
}

/** **新建**表单 → 档案 patch。
 *
 *  ⚠️ 与「修改」用的解析器**故意是两个**，因为它们表达的是两件事：
 *    · 新建：这些框就是我填的全部内容，填了就该写进去（没有「原值」可保留）
 *    · 修改：只有勾了「改」的项才动 —— 否则分不清「没改」和「要清空」
 *    本轮就是在这里踩到的：新建表单没有勾选框，却被「修改」的解析器处理，
 *    结果**三位字段一个都没写进去**（页面还跳转成功了，属于静默失败）。
 *
 *  空串不进 patch（新建时留空 = 没填，不该把空值写上去）。 */
function newStudentPatch(formData: FormData): StudentPatch {
  const patch: StudentPatch = {};
  for (const key of ["grade", "campus", "teacher"] as const) {
    const v = String(formData.get(key) ?? "").trim();
    if (v) patch[key] = v;
  }
  return patch;
}

/** **修改**表单 → 档案 patch。
 *
 *  ⚠️ 「改这一项」的勾选框（`change_<字段>`）是**必须**的，不是装饰：
 *     不勾 = 这个字段根本不进 patch = 保留原值。
 *     光靠「留空＝不改」的话，「把校区清空」就永远做不到（空值被当成没改，静默不生效）。
 *     勾上但留空 = **明确清空**（写空串）—— 两种意图都能表达。
 *
 *  ⚠️ 只放**身份字段**：分数 / 课时 / 薄弱模块属于「某一次方案」，不在档案这一层。 */
function patchFromForm(formData: FormData): StudentPatch {
  const patch: StudentPatch = {};
  for (const key of ["grade", "campus", "teacher"] as const) {
    if (formData.get(`change_${key}`) == null) continue;      // 没勾 → 不动这一项
    patch[key] = String(formData.get(key) ?? "").trim();       // 勾了 → 原样写（空串=清空）
  }
  return patch;
}

/**
 * `revalidatePath()` **清不掉** `feedback-db` 的进程内缓存（两套缓存），
 * 而这张档案页读的正是那份缓存（`getStudents` / `getHistory`，TTL 25 秒）。
 *
 * ⚠️ 后果（本轮实测踩到）：在这页点了「新建学生」，跳转过去却**看不到这个学生**，
 *    因为页面渲染时命中了 25 秒前的旧缓存；刷新等一会儿才出现 ——
 *    症状就是「保存了但没生效」，最难查。
 *    `upsertStudent()` 内部自己会清学生缓存，但**历史缓存**要这里补；
 *    删除同理（`deleteStudentByName()` 两个都清，这里仍显式调用一次，避免以后改实现时漏掉）。
 *
 * ⚠️ 只清这两份**当前用户**的数据缓存；全局静态表（分类/教材/关键词）不受影响。
 */
function invalidateArchiveCaches() {
  invalidateStudents();
  invalidateHistory();
}

/** 新建一位学生（同名已存在时是**补充信息**，不会清掉别家工具存在这行上的字段） */
export async function createStudent(
  _prev: ArchiveActionState,
  formData: FormData,
): Promise<ArchiveActionState> {
  const guard = await requireWriter();
  if (!guard.ok) return { status: "error", message: guard.message };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { status: "error", message: "请填写学生姓名。" };
  if (name.length > 100) return { status: "error", message: "学生姓名过长（最多 100 字）。" };

  try {
    await upsertStudent(guard.userId, name, newStudentPatch(formData));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[archive] 新建学生失败:", msg);
    return { status: "error", message: "保存失败：" + msg.slice(0, 120) };
  }

  invalidateArchiveCaches();
  revalidatePath("/dashboard");
  redirect(`/dashboard?name=${encodeURIComponent(name)}`);
}

/** 修改一位学生的档案 */
export async function updateStudent(
  _prev: ArchiveActionState,
  formData: FormData,
): Promise<ArchiveActionState> {
  const guard = await requireWriter();
  if (!guard.ok) return { status: "error", message: guard.message };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { status: "error", message: "缺少学生姓名。" };

  const patch = patchFromForm(formData);
  if (!Object.keys(patch).length) {
    return { status: "error", message: "没有要修改的内容（三个框都是空的）。" };
  }

  try {
    await upsertStudent(guard.userId, name, patch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[archive] 修改学生失败:", msg);
    return { status: "error", message: "保存失败：" + msg.slice(0, 120) };
  }

  invalidateArchiveCaches();
  revalidatePath("/dashboard");
  return { status: "success", message: "已保存。" };
}

/** 删除一位学生（连同其全部记录） */
export async function deleteStudent(
  _prev: ArchiveActionState,
  formData: FormData,
): Promise<ArchiveActionState> {
  const guard = await requireWriter();
  if (!guard.ok) return { status: "error", message: guard.message };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { status: "error", message: "缺少学生姓名。" };

  try {
    await deleteStudentByName(name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[archive] 删除学生失败:", msg);
    return { status: "error", message: "删除失败：" + msg.slice(0, 120) };
  }

  invalidateArchiveCaches();
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
