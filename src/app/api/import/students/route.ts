import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { upsertStudent } from "@/lib/feedback-db";
import { PROFILE_SUBJECTS } from "@/lib/user-profile";

const MAX_ROWS = 500;
const aliases: Record<string, string[]> = {
  name: ["学生姓名", "姓名", "name", "student_name"],
  grade: ["年级", "grade"],
  school: ["学校", "校区", "school", "campus"],
  manager: ["学管师", "manager"],
  subject: ["科目", "学科", "subject"],
  teacher: ["老师", "任课老师", "teacher"],
};

function norm(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function pick(row: Record<string, unknown>, key: string): string {
  for (const name of aliases[key]) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return norm(row[name]);
  }
  return "";
}

function subjectCode(raw: string): string {
  const s = norm(raw);
  if (!s) return "general";
  const byName = PROFILE_SUBJECTS.find((x) => x.name === s);
  if (byName) return byName.code;
  return PROFILE_SUBJECTS.some((x) => x.code === s) ? s : "general";
}

export async function POST(request: Request) {
  const { role } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return NextResponse.json({ ok: false, error: "只有 Owner/管理员能批量导入。" }, { status: 403 });
  }
  if (!(await isFeatureEnabled("batch_import"))) {
    return NextResponse.json({ ok: false, error: "批量导入已被管理员暂时关闭。" }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "上传内容不是合法表单。" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "请选择 .xlsx 或 .csv 文件。" }, { status: 400 });
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ ok: false, error: "文件超过 5MB，请拆分后导入。" }, { status: 413 });
  }

  let rows: Record<string, unknown>[];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const wb = file.name.toLowerCase().endsWith(".csv")
      ? XLSX.read(buffer.toString("utf8").replace(/^\uFEFF/, ""), { type: "string" })
      : XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  } catch (e) {
    console.error("[batch-import] 解析失败:", String(e));
    return NextResponse.json({ ok: false, error: "文件解析失败，请确认是 .xlsx 或 .csv，且第一行是表头。" }, { status: 400 });
  }

  if (!rows.length) {
    return NextResponse.json({ ok: false, error: "表格里没有数据行。" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ ok: false, error: `一次最多导入 ${MAX_ROWS} 行，请拆分文件。` }, { status: 413 });
  }

  let success = 0;
  const errors: { row: number; name: string; reason: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = pick(row, "name");
    if (!name) {
      errors.push({ row: i + 2, name: "", reason: "缺少学生姓名" });
      continue;
    }
    try {
      await upsertStudent(name, {
        grade: pick(row, "grade"),
        campus: pick(row, "school"),
        manager: pick(row, "manager"),
        subject: subjectCode(pick(row, "subject")),
        teacher: pick(row, "teacher"),
      });
      success++;
    } catch (e) {
      errors.push({ row: i + 2, name, reason: e instanceof Error ? e.message : "写入失败" });
    }
  }

  return NextResponse.json({
    ok: true,
    total: rows.length,
    success,
    failed: errors.length,
    errors: errors.slice(0, 50),
  });
}
