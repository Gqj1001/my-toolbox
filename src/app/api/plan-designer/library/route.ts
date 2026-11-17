import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

type Course = {
  id: number; module: string; name: string; stage: string; points: string;
  hours: number; goal: string; levels: string[]; students: string[];
};
type Module = { name: string; scoreText: string; score: number | null; courses: string[]; note: string | null };

function s(v: unknown): string { return String(v ?? "").trim(); }
function n(v: unknown): number { const x = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(x) ? x : 0; }
function list(v: unknown): string[] { return s(v).split("、").map((x) => x.trim()).filter(Boolean); }

/** 「含课程」用「、」分隔，但课程名本身也可能带「、」（如“一元二次函数、方程与不等式”）。
 *  所以优先按真实课程模块名做最长匹配，匹配不到才退回按「、」切。 */
function splitCourseNames(raw: string, known: string[]): string[] {
  let rest = s(raw);
  const out: string[] = [];
  while (rest) {
    const hit = known.filter((n) => n && rest.startsWith(n)).sort((a, b) => b.length - a.length)[0];
    if (hit) {
      out.push(hit);
      rest = rest.slice(hit.length).replace(/^、/, "");
      continue;
    }
    const i = rest.indexOf("、");
    if (i < 0) { out.push(rest); break; }
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return out.filter(Boolean);
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer.user) return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });

  let form: FormData;
  try { form = await req.formData(); } catch {
    return NextResponse.json({ ok: false, error: "上传格式不正确。" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "没有收到 xlsx 文件。" }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return NextResponse.json({ ok: false, error: "文件太大（上限 8MB）。" }, { status: 413 });

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
  } catch {
    return NextResponse.json({ ok: false, error: "读不了这个 xlsx，请确认文件没有损坏。" }, { status: 400 });
  }
  const courseSheet = wb.Sheets["课程库"];
  if (!courseSheet) return NextResponse.json({ ok: false, error: "缺少「课程库」工作表。" }, { status: 400 });
  const courseRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(courseSheet, { defval: "" });
  const courses: Course[] = courseRows.map((r, i) => ({
    id: n(r["序号"]) || i + 1,
    module: s(r["知识模块"]),
    name: s(r["课程名称"]),
    stage: s(r["阶段"]),
    points: s(r["具体知识点"]),
    hours: Math.max(1, Math.round(n(r["课时"]) || 2)),
    goal: s(r["教学目标"]),
    levels: list(r["适用层次"]),
    students: list(r["出现学生"]),
  })).filter((c) => c.name && c.module);
  if (!courses.length) return NextResponse.json({ ok: false, error: "「课程库」没有有效课程行。" }, { status: 400 });

  const moduleSheet = wb.Sheets["模块与分值"];
  let modules: Module[] = [];
  const knownCourseModules = [...new Set(courses.map((c) => c.module))];
  if (moduleSheet) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(moduleSheet, { defval: "" });
    modules = rows.map((r) => {
      const scoreText = s(r["高考分值（新高考I卷估算）"] || r["高考分值"] || "");
      const m = s(scoreText).match(/(\d+)/);
      return {
        name: s(r["知识模块"]), scoreText: scoreText || "—",
        score: m ? Number(m[1]) : null, courses: splitCourseNames(s(r["含课程"]), knownCourseModules),
        note: s(r["说明"]) || null,
      };
    }).filter((m) => m.name);
  }
  if (!modules.length) {
    // 没给模块表：按课程库里的模块自动兜底（分值未知）
    const names = [...new Set(courses.map((c) => c.module))];
    modules = names.map((name) => ({ name, scoreText: "—", score: null, courses: [name], note: null }));
  }

  return NextResponse.json({ ok: true, library: { courses, modules, students: [] } });
}
