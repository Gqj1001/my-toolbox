"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { translateAuthError } from "@/lib/auth-errors";
import { checkNewPassword, MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

/**
 * 账号安全相关的两个动作（2026-10 第十五批）
 * ==========================================================================
 *   ① `requestPasswordReset` —— 「忘记密码」：给邮箱发一封重置链接。
 *   ② `changePassword`       —— 「修改密码」：**登录后**改，要求先验证当前密码。
 *
 * ⚠️ 复用 `@/app/auth/actions` 的 `translateAuthError`：Supabase 的英文报错
 *    已经有一份**中文翻译的唯一来源**（含"密码太弱/泄露库/邮箱格式/频率限制"等分支），
 *    这里绝不能再写第二份 —— 那个坑本项目踩过（"标签有两个来源"）。
 *
 * ⚠️ 为什么重置邮件让**服务端**去发（而不是浏览器直连 Supabase）：
 *    - `redirectTo` 要用**当前站点的真实 origin**（本地 localhost / 线上 010034.xyz 都自动对），
 *      写死域名会在另一套环境里失效（这是 resetPasswordForEmail 最常见的坑）；
 *    - 邮件模板里那条链接必须回到 `/auth/confirm`，由它 `verifyOtp` 换出会话
 *      （该路由早就支持 `type=recovery`，本轮**一行没改**）；
 *    - 前端不接触任何 key。
 */

export type PasswordFormState = {
  status: "idle" | "error" | "success";
  message?: string;
};

/** 取当前站点 origin（与注册邮件同一套做法：紧跟真实 host，不写死域名） */
async function getOrigin() {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}

/**
 * 「忘记密码」：发重置邮件。
 *
 * ⚠️ **不论邮箱是否存在，都回同一句话**（安全口径）：否则这个页面会变成一个
 *    "某个邮箱有没有注册过"的查询接口。Supabase 本身也是这个口径（不报"用户不存在"）。
 *    所以下面**唯一**会打断通用成功文案的，是"发信本身失败了"（频率限制、服务故障）——
 *    那种情况必须如实告诉用户，不然他会一直等一封永远不会到的邮件。
 */
export async function requestPasswordReset(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const generic: PasswordFormState = {
    status: "success",
    message:
      "如果这个邮箱注册过账号，重置链接已经发出（几分钟内到达）。" +
      "没收到的话：先看看垃圾邮件，隔一会儿再试一次。",
  };

  if (!email) return { status: "error", message: "请填写注册时用的邮箱。" };

  const supabase = await createClient();
  const origin = await getOrigin();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // 邮件里那条链接回到 /auth/confirm，由它 verifyOtp 换出会话，
    // 再去 /reset-password 设新密码。⚠️ 这个地址必须同时加进 Supabase 后台的
    // Redirect URLs 白名单（见 docs/password-reset-plan.md §4），否则 Supabase 会拒发。
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });

  if (error) {
    const translated = translateAuthError(error);
    // 频率限制/服务故障：不能装作"已发送"（用户会白等），如实说
    if (/频率|稍后|网络|失败/.test(translated)) {
      return { status: "error", message: translated };
    }
    // 其它错误（例如邮箱格式）也照实说 —— 与"账号是否存在"无关，不泄露任何东西
    console.warn("[password] 发送重置邮件失败:", error.code ?? "", error.message);
    return { status: "error", message: translated };
  }

  return generic;
}

/**
 * 「修改密码」：登录后改，**先验当前密码**。
 *
 * ⚠️ 为什么必须验当前密码（而不是只看"已登录"）：老师常常在**公共电脑**上登录着，
 *    只靠会话的话，任何摸到那台电脑的人都能把密码改掉、把账号锁死。
 *
 * ⚠️ 验旧密码的做法：用旧密码**再登录一次**（`signInWithPassword`）。
 *    本来还有一个更"标准"的做法 —— `updateUser({ password, current_password })`，
 *    但它依赖 `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` 这个
 *    服务端配置（默认关闭时该字段会被忽略），**我们无法从代码侧确认线上开没开**。
 *    用"再登录一次"就不依赖任何后台配置，行为确定；代价是多一次往返（改密码是低频动作）。
 *
 * ⚠️ 密码规则是**纯函数** `checkNewPassword()`（`src/lib/password-policy.ts`），
 *    页面与这里共用同一份 —— 不要在两边各写一套。
 */
export async function changePassword(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const oldPassword = String(formData.get("oldPassword") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");
  // ⚠️ 「重置流程」标记（由 `/reset-password` 页面上的隐藏字段带上来）：
  //    那条路上用户**正想不起旧密码**，要求他填旧密码就是死锁。所以：
  //      · 带了这个标记 → 只要求"有一个会话"（会话正是邮件链接换出来的），**跳过验旧密码**；
  //      · 没带（= 登录后主动改密码）→ **必须**验旧密码，见下面的说明。
  //    两条路都走同一个动作，是为了不让"改密码"这件事出现两套实现。
  const isResetFlow = String(formData.get("reset") ?? "") === "1";

  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const email = userData.user?.email;
  if (userError || !userData.user || !email) {
    return {
      status: "error",
      message: isResetFlow
        ? "重置链接已过期或无效，请重新申请一封重置邮件。"
        : "登录已过期，请重新登录后再改密码。",
    };
  }

  const check = checkNewPassword(
    isResetFlow ? { password, confirm } : { password, confirm, oldPassword },
  );
  if (!check.ok) return { status: "error", message: check.error };

  // ① 先用旧密码验一次身份（**只在"主动改密码"这条路上**）
  if (!isResetFlow) {
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: oldPassword });
    if (verifyError) {
      const translated = translateAuthError(verifyError);
      // 认证失败一律给同一句话，不区分"密码错"和别的（也没必要区分）
      if (/不正确|密码/.test(translated)) {
        return { status: "error", message: "当前密码不正确，请重新输入。" };
      }
      return { status: "error", message: translated };
    }
  }

  // ② 再改密码
  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    console.warn("[password] 修改失败:", updateError.code ?? "", updateError.message);
    return { status: "error", message: translateAuthError(updateError) };
  }

  return {
    status: "success",
    message: "密码已修改。这台设备上仍是登录状态；如果你在别的设备上登录过，请在那里重新登录。",
  };
}
