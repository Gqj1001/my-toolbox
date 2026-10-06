import { NextResponse, type NextRequest } from "next/server";
import {
  extractDocxText,
  extractLegacyDocText,
  extractPdfText,
} from "@/lib/paper-extract";
import { getViewer } from "@/lib/viewer";

/**
 * 试卷文件解析：接收 base64 dataURL，抽取纯文本
 *
 * 请求：{ name: "xxx.docx", data: "data:...;base64,AAAA" }
 * 响应：{ ok, kind: 'docx'|'doc'|'pdf'|'image'|'unknown', text, note }
 *
 * 说明：
 *  · docx / doc / pdf 由本地零依赖解析（zlib），不消耗 AI
 *  · 图片需要视觉模型；本版未启用 → 返回空 text + 提示（前端会引导粘贴文字）
 *  · 解析失败也返回 200 + 提示，而不是 5xx —— 用户需要看到"改用粘贴"这类可操作建议
 */

/** 老版是 20MB；Vercel 请求体上限约 4.5MB，这里按 4MB 兜住并给明确提示 */
const MAX_BODY = 4 * 1024 * 1024;

export async function POST(request: NextRequest) {
  // ---------- 鉴权 ----------
  // 用 getViewer()：一次拿到 user + membership.status，
  // 不必再单独 select("status")（那会多付一次 Supabase 往返）。
  const viewer = await getViewer();
  if (!viewer.user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  if (viewer.membership.status === "banned") {
    return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
  }

  // ---------- 读 body ----------
  const lenHeader = Number(request.headers.get("content-length") ?? 0);
  if (lenHeader > MAX_BODY) {
    return NextResponse.json(
      { ok: false, error: `文件太大（超过 ${Math.round(MAX_BODY / 1024 / 1024)}MB）。请改用粘贴文字，或把文件压缩/另存后重试。` },
      { status: 413 },
    );
  }

  let body: { name?: unknown; data?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; data?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const name = String(body.name ?? "file");
  const dataUrl = String(body.data ?? "");
  const mm = dataUrl.match(/^data:([^;]+);base64,([\s\S]*)$/);
  if (!mm) {
    return NextResponse.json(
      { ok: false, error: "文件格式不正确（需要 base64 dataURL）" },
      { status: 400 },
    );
  }

  const mime = mm[1];
  let buf: Buffer;
  try {
    buf = Buffer.from(mm[2], "base64");
  } catch {
    return NextResponse.json({ ok: false, error: "base64 解码失败。" }, { status: 400 });
  }
  if (buf.length > MAX_BODY) {
    return NextResponse.json(
      { ok: false, error: `文件太大（超过 ${Math.round(MAX_BODY / 1024 / 1024)}MB）。请改用粘贴文字。` },
      { status: 413 },
    );
  }

  const ext = (name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "").toLowerCase();

  // ---------- ① .docx ----------
  if (ext === "docx" || mime.includes("officedocument.wordprocessingml")) {
    try {
      const text = extractDocxText(buf);
      return NextResponse.json({
        ok: true,
        kind: "docx",
        text,
        note: text.trim() ? "" : "这个 docx 里没抽到文字（可能是扫描图片版），建议改用图片上传或直接粘贴文字",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({
        ok: true,
        kind: "docx",
        text: "",
        note: "解析 docx 失败：" + msg + "。可以直接把内容复制粘贴进来。",
      });
    }
  }

  // ---------- ② .doc（老二进制格式）----------
  if (ext === "doc" || mime === "application/msword") {
    const text = extractLegacyDocText(buf);
    return NextResponse.json({
      ok: true,
      kind: "doc",
      text,
      note: text ? "已从 .doc 中提取文本，请核对后再解析" : "这个 .doc 抽不出文字，建议用 Word 另存为 .docx 后上传",
    });
  }

  // ---------- ③ 图片 ----------
  if (mime.startsWith("image/")) {
    // 本版未启用视觉模型：明确告知，并指向可行的替代方案
    return NextResponse.json({
      ok: true,
      kind: "image",
      text: "",
      note:
        "图片需要视觉模型才能识别，当前云端版未启用该功能。" +
        "请改用 .docx 上传，或把试卷分析报告里的文字直接复制粘贴进来。",
    });
  }

  // ---------- ④ PDF ----------
  if (ext === "pdf" || mime === "application/pdf") {
    const text = extractPdfText(buf);
    return NextResponse.json({
      ok: true,
      kind: "pdf",
      text,
      note: text
        ? text.length < 300
          ? "只抽到少量文本（可能是扫描版），请核对或改用截图识别"
          : "已从 PDF 抽取文本，请核对后再解析"
        : "这个 PDF 抽不出文字（多半是扫描版）。请把 PDF 页截图后按图片上传，或直接复制文字粘贴。",
    });
  }

  // ---------- ⑤ 其它 ----------
  return NextResponse.json({
    ok: true,
    kind: "unknown",
    text: "",
    note: "暂不支持这种格式（" + (ext || mime) + "）。支持：docx / doc / pdf / 图片（png、jpg）。",
  });
}
