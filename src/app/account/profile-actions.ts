"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/viewer";
import { saveUserProfile } from "@/lib/user-profile-db";
import { checkProfileInput } from "@/lib/user-profile";

/**
 * 「我的资料」（姓名 / 学科 / 校区 / 落款）的保存。
 *
 * 用户 2026-10 的原始需求（逐字）：
 *   「我们能否在注册页面后加入填写信息模块 …… 然后未来我们首页这个部分就显示这几个主要信息，
 *     然后导出来的档案文件什么的就可以从这里提取信息了，然后别忘了再加入一个修改信息的功能即可」
 *
 * ⚠️ 为什么它重要：以前"郭庆杰"被写死在代码 13 处（4 处会印进导出的 Word）。
 *    从此以后，落款与导出抬头**都从这一份资料取**。
 *
 * ⚠️ 保存失败要分两种：**表没建**（提示去跑迁移 0021）与**其它失败**（重试）。
 *    绝不把"迁移没跑"报成"保存失败"—— 那会让人反复重试一个永远不会成功的动作。
 */

export type ProfileActionState = { status: "idle" | "ok" | "error"; message?: string };

export async function saveProfileAction(
  _prev: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const viewer = await getViewer();
  if (!viewer.user) return { status: "error", message: "登录已过期，请重新登录。" };
  if (viewer.membership.status === "banned") return { status: "error", message: "账号已被封禁。" };

  const checked = checkProfileInput({
    teacher_name: formData.get("teacher_name"),
    subject: formData.get("subject"),
    campus: formData.get("campus"),
    sig_teacher: formData.get("sig_teacher"),
  });
  if (!checked.ok) return { status: "error", message: checked.error };

  const res = await saveUserProfile(viewer.user.id, checked.value);
  if (!res.ok) return { status: "error", message: res.error };

  // 首页账号卡 / 资料页 / 工具页都可能立刻要看到新值
  revalidatePath("/tools");
  revalidatePath("/account/profile");
  revalidatePath("/welcome");

  // 从注册后的引导页来（表单里带 next=1）→ 保存完直接进个人中心
  if (String(formData.get("go_tools") ?? "") === "1") redirect("/tools");

  return { status: "ok", message: "已保存。以后落款与导出的文件都会用这份信息。" };
}
