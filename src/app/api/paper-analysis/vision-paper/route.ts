import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/viewer";
import { readContent, reasoningLength, truncatedByReasoning } from "@/lib/deepseek-thinking";

/**
 * 试卷分析：**图片/截图 → 文字**（视觉模型逐字抄录）
 *
 * 用途：老师手上常常只有**截图或拍照**（学科网报告的截图、扫描件、试卷照片），
 * 而 `parse-file` 只能处理 docx / doc / 有文字层的 PDF。这条路由补上那半边：
 * 把图里的文字**逐字**抄出来，交给现有的「导入试卷」解析流程。
 *
 * ⚠️ **口径：免费**（用户 2026-10 明确定）。
 *    与另外三个 AI 功能（建议段/错因润色/答题卡识别）不同 —— 那三个是**会员专属**。
 *    所以这里只做「登录 + 未封禁」校验，**不要**改成 `requireVip()`。
 *    理由：识别只是"把图变成字"，解析与生成都还是程序做的；老师没有它就得多打一遍字。
 *
 * ⚠️ 与 `vision-scores`（答题卡识别）的区别：那条要的是**每题的得分数字**（返回 JSON），
 *    这条要的是**图里全部文字**（返回纯文本）。两条共用同一套视觉模型配置
 *    （`AI_VISION_MODEL`）与同一套护栏，但**提示词与出参完全不同**，别合并。
 *
 * 出参：`{ ok:true, text, chars, empty, uncertain, retried }`
 *   · `empty`     —— 一个字都没认出来（太模糊 / 拍歪 / 根本不是文字图）
 *   · `uncertain` —— 文本里出现了「[看不清]」标记：**尽力识别 + 标出不确定的地方**（用户口径）
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
/** 与 parse-file 同口径：Vercel 请求体上限约 4.5MB，这里按 4MB 兜住 */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TOKENS = 6000;
const TIMEOUT_MS = 90_000;
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
  // ---------- 1. 鉴权：**登录即可（免费）**——见文件头说明，别改成 requireVip ----------
  const viewer = await getViewer();
  if (!viewer.user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  if (viewer.membership.status === "banned") {
    return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
  }

  // ---------- 2. 服务端配置 ----------
  const apiKey = process.env.AI_KEY;
  const visionModel = process.env.AI_VISION_MODEL;
  if (!apiKey || !visionModel) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "云端版未启用图片识别（需要额外的多模态模型）。" +
          "请改用 .docx 上传，或把报告里的文字直接复制粘贴进来。",
      },
      { status: 503 },
    );
  }
  const baseUrl = (process.env.AI_VISION_BASE_URL ?? process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");

  // ---------- 3. 入参 ----------
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

  /**
   * ⚠️ 护栏：**只有确认是 DeepSeek 才带 `thinking` 这个专有字段**（与 vision-scores 同源）。
   * 模型名来自 `AI_VISION_MODEL`，可能是任意 OpenAI 兼容视觉模型；
   * 给不认识该字段的厂商发过去可能直接 400。另有 `AI_VISION_SUPPORTS_THINKING=0` 紧急开关。
   */
  const supportsThinking =
    /deepseek/i.test(visionModel) && process.env.AI_VISION_SUPPORTS_THINKING !== "0";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: visionModel,
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          {
            role: "user",
            // ⚠️ 图片只能放在 **user** 消息里（放 system/assistant 官方会 400）
            content: [
              { type: "text", text: "请把这张图片里的文字逐字抄录出来。" },
              { type: "image_url", image_url: { url: img } },
            ],
          },
        ],
        max_tokens: MAX_TOKENS,
        ...(supportsThinking ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();
    if (!res.ok) {
      console.error("[paper-analysis/vision-paper] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ ok: false, error: "识别服务暂时不可用，请稍后重试。" }, { status: 502 });
    }

    let data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
      usage?: Record<string, unknown>;
    };

    // 兜底重试：思考过程吃光预算（与另外几条 AI 路由同源）
    let retried = false;
    if (truncatedByReasoning(data)) {
      retried = true;
      console.warn(
        "[paper-analysis/vision-paper] 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:",
        JSON.stringify({ model: visionModel, supportsThinking, reasoningLen: reasoningLength(data), usage: data.usage ?? null }),
      );
      res = await callUpstream();
      if (res.ok) data = (await res.json()) as typeof data;
      else console.error("[paper-analysis/vision-paper] 重试仍失败，上游返回", res.status, (await res.text()).slice(0, 300));
    }

    const text = readContent(data);
    const uncertain = text.includes(UNCERTAIN_MARK) || text.includes("[看不清]") || text.includes("【看不清】");
    // ⚠️ 认不出字**不是错误**：返回 200 + empty:true，让前端给"重拍/换图/粘贴文字"的建议。
    //    报 5xx 会让老师以为是系统坏了，而实际是这张图不行。
    return NextResponse.json({
      ok: true,
      text,
      chars: text.length,
      empty: text.length === 0,
      uncertain,
      retried,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[paper-analysis/vision-paper] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "识别超时，请重试或换一张更清晰的图。" : "识别服务暂时不可用。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
