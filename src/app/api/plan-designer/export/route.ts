import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

type In = {
  name?: string; grade?: string; school?: string; teacher?: string; subject?: string;
  level?: string; teacherLevel?: string; totalHours?: number; usedHours?: number; phaseLabel?: string;
  title?: string; cycleText?: string; totalGoal?: string;
  analysis?: Record<string, string>;
  rows?: Array<{ module?: string; points?: string; examScore?: string; hours?: number; goal?: string; effect?: string; adjustment?: string }>;
};

const DIM_ROWS = ["knowledge", "ability", "method", "habit", "attitude", "family", "school"];

function clean(v: unknown): string {
  return String(v ?? "").replace(/\r/g, "").trim();
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer.user) return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  let body: In;
  try { body = (await req.json()) as In; } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!clean(body.name)) return NextResponse.json({ ok: false, error: "缺少学生姓名。" }, { status: 400 });
  if (!rows.length) return NextResponse.json({ ok: false, error: "没有可导出的模块行。" }, { status: 400 });
  if (rows.length > 30) return NextResponse.json({ ok: false, error: "模块行最多 30 行。" }, { status: 413 });

  const templatePath = path.join(process.cwd(), "public", "templates", "plan-designer-template.xlsx");
  const bytes = await readFile(templatePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return NextResponse.json({ ok: false, error: "模板文件缺少工作表。" }, { status: 500 });

  const name = clean(body.name);
  const grade = clean(body.grade);
  const school = clean(body.school);
  const teacher = clean(body.teacher) || "郭老师";
  const subject = clean(body.subject) || "数学";
  const teacherLevel = clean(body.teacherLevel) || "—";
  const totalHours = Math.max(0, Math.round(Number(body.totalHours) || 0));
  const usedHours = Math.max(0, Math.round(Number(body.usedHours) || 0));

  ws.getCell("A1").value = `${name}个性化辅导计划表`;
  ws.getCell("A3").value = name;
  ws.getCell("B3").value = [school, grade].filter(Boolean).join(" ");
  ws.getCell("C3").value = teacher;
  ws.getCell("D3").value = subject;
  ws.getCell("E3").value = teacherLevel;
  ws.getCell("F3").value = `${totalHours}h`;
  ws.getCell("G3").value = usedHours;

  const analysis = body.analysis || {};
  DIM_ROWS.forEach((key, i) => {
    ws.getCell(`B${6 + i}`).value = clean(analysis[key]) || "—";
  });
  ws.getCell("B14").value = clean(body.totalGoal) || "—";
  ws.getCell("B15").value = clean(body.cycleText) || "—";

  // 取模板第 17 行（数据行）的样式，所有数据行都复用它
  const srcRow = ws.getRow(17);
  const styles: Record<number, unknown> = {};
  for (let c = 1; c <= 7; c++) styles[c] = { ...srcRow.getCell(c).style };
  const srcHeight = srcRow.height ?? 40;

  // 清掉模板第 17 行之后的全部空数据行和签字行；重新按实际行数生成
  const merges = (ws as unknown as { _merges?: Record<string, unknown> })._merges || {};
  for (const key of Object.keys(merges)) {
    const m = /^[A-Z]+(\d+):/.exec(key);
    if (m && Number(m[1]) >= 17) {
      try { ws.unMergeCells(key); } catch { /* ignore */ }
    }
  }
  // ⚠️ spliceRows 在有合并单元格的签字行上不一定一次删干净：从底部逐行削到第 16 行
  while (ws.rowCount > 16) ws.spliceRows(ws.rowCount, 1);

  // 在末尾（原签字位置）插入数据行，再插签字行
  const dataStart = 17;
  for (let i = 0; i < rows.length; i++) {
    const r = dataStart + i;
    ws.insertRow(r, 1);
    const row = ws.getRow(r);
    row.height = srcHeight;
    for (let c = 1; c <= 7; c++) row.getCell(c).style = styles[c] as never;
    const item = rows[i] || {};
    row.getCell(1).value = clean(item.module);
    row.getCell(2).value = clean(item.points);
    row.getCell(3).value = clean(item.examScore) || "—";
    row.getCell(4).value = `${Math.max(0, Math.round(Number(item.hours) || 0))}h`;
    row.getCell(5).value = clean(item.goal) || "—";
    row.getCell(6).value = clean(item.effect) || "—";
    row.getCell(7).value = clean(item.adjustment) || "—";
  }

  const sig = dataStart + rows.length;
  ws.insertRow(sig, 1);
  const sigRow = ws.getRow(sig);
  sigRow.height = 22.5;
  for (let c = 1; c <= 7; c++) sigRow.getCell(c).style = styles[c] as never;
  sigRow.getCell(1).value = "组长/主任签字";
  sigRow.getCell(4).value = "家长签字";
  sigRow.getCell(6).value = "日期";
  try { ws.mergeCells(`B${sig}:C${sig}`); } catch { /* ignore */ }

  const out = await wb.xlsx.writeBuffer();
  const phaseLabel = clean(body.phaseLabel).replace(/[\\/:*?"<>|]/g, "");
  const filename = `${name}-${phaseLabel ? phaseLabel + "-" : ""}个性化辅导计划表.xlsx`;
  return new NextResponse(out as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="plan.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
