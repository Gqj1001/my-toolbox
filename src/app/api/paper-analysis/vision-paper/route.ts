import { NextResponse, type NextRequest } from "next/server";
import { callVisionModel, visionAuthGuard } from "@/lib/vision-call";

/**
 * 试卷分析：**图片/截图 → 文字**（视觉模型逐字抄录）
 *
 * 用途：老师手上常常只有**截图或拍照**（学科网报告的截图、扫描件），
 * 而 `parse-file` 只能处理 docx / doc / 有文字层的 PDF。这条路由补上那半边：
 * 把图里的文字**逐字**抄出来，交给现有的「导入试卷」解析流程。
 *
 * ⚠️ 与隔壁 `vision-paper-structure` 的分工（**别混**）：
 *    这条是「**抄文字**」，给学科网那种有固定结构的报告用；
 *    学校卷子（空白卷/批改卷）走 `vision-paper-structure`（直接给题目结构）。
 *
 * ⚠️ **口径：免费**（用户 2026-10 明确定）—— 鉴权与模型调用都在
 *    `@/lib/vision-call` 里，**只有一份实现**；**不要**在调用方改成 `requireVip()`。
 *
 * 出参：`{ ok:true, text, chars, empty, uncertain, retried }`
 *   · `empty`     —— 一个字都没认出来（太模糊 / 拍歪 / 根本不是文字图）
 *   · `uncertain` —— 文本里出现了「[看不清]」标记：**尽力识别 + 标出不确定的地方**（用户口径）
 */

/** 与 parse-file 同口径：Vercel 请求体上限约 4.5MB，这里按 4MB 兜住 */
const MAX_BODY = 4 * 1024 * 1024;
/** 「看不清」标记：提示词要求原样写成这个，前端据此提示"这几处要你核对" */
const UNCERTAIN_MARK = "[看不清]";

const EXTRACT_PROMPT =
  "你是一位非常细心的老师，正在把一张图片里的文字**逐字抄录**成纯文本，供程序后续解析。\n" +
  "严格要求（必须遵守）：\n" +
  "1. **只抄录图片里真实存在的文字**：不要翻译、不要总结、不要改写、不要补全、不要解释。\n" +
  "2. **保留原有的结构与层级**：小标题、条目、题号、分行都要保留。" +
  "表格请用「列1 | 列2 | 列3」这种竖线分隔的形式，**一行一条记录**。\n" +
  "3. 看不清、被遮挡、字迹潦草无法确认的地方，**原样写成 " + UNCERTAIN_MARK + "**，" +
  "绝对不要猜（宁可标出来让老师自己补）。\n" +
  "4. 手写批注**看得清就抄**，用方括号标出来（例如「[手写] 第二问不会」），与印刷文字区分开。\n" +
  "5. 页眉页脚、页码、水印可以忽略；正文与表格必须完整。\n" +
  "6. **只输出抄录结果本身**：不要加任何说明（例如「以下是识别结果」）、不要包代码块。";

export async function POST(request: NextRequest) {
  // ---------- 1. 鉴权：**登录即可（免费）**——见文件头说明 ----------
  const guard = await visionAuthGuard();
  if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });

  // ---------- 2. 入参 ----------
  const lenHeader = Number(request.headers.get("content-length") ?? 0);
  if (lenHeader > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "图片太大，请压缩后重试。" }, { status: 413 });
  }

  let body: { image?: unknown };
  try {
    body = (await request.json()) as { image?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  const img = String(body.image ?? "");
  if (!img.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "图片格式不正确。" }, { status: 400 });
  }
  if (img.length > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "图片太大，请压缩后重试。" }, { status: 413 });
  }

  // ---------- 3. 调视觉模型（公共实现，含 thinking 护栏与重试） ----------
  const r = await callVisionModel({
    label: "[paper-analysis/vision-paper]",
    system: EXTRACT_PROMPT,
    images: [img],
    userText: "请把这张图片里的文字逐字抄录出来。",
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const text = r.text;
  const uncertain = text.includes(UNCERTAIN_MARK) || text.includes("【看不清】");
  // ⚠️ 认不出字**不是错误**：返回 200 + empty:true，让前端给"重拍/换图/粘贴文字"的建议。
  //    报 5xx 会让老师以为是系统坏了，而实际是这张图不行。
  return NextResponse.json({
    ok: true,
    text,
    chars: text.length,
    empty: text.length === 0,
    uncertain,
    retried: r.retried,
  });
}
