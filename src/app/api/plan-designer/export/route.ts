import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

type RowIn = {
  module?: string; points?: string; examScore?: string; hours?: number;
  goal?: string; effect?: string; adjustment?: string;
};
type PhaseIn = {
  label?: string; totalHours?: number; cycleText?: string; totalGoal?: string;
  rows?: RowIn[];
};
type In = {
  name?: string; grade?: string; school?: string; teacher?: string; subject?: string;
  level?: string; teacherLevel?: string; totalHours?: number; usedHours?: number;
  phaseLabel?: string; title?: string; cycleText?: string; totalGoal?: string;
  analysis?: Record<string, string>;
  rows?: RowIn[];
  phases?: PhaseIn[];
};

const DIM_ROWS = ["knowledge", "ability", "method", "habit", "attitude", "family", "school"];

function clean(v: unknown): string {
  return String(v ?? "").replace(/\r/g, "").trim();
}

function copyTemplateSheet(src: ExcelJS.Worksheet, dst: ExcelJS.Worksheet): void {
  const maxRow = src.rowCount;
  const maxCol = src.columnCount;
  for (let c = 1; c <= maxCol; c++) {
    const width = src.getColumn(c).width;
    if (width) dst.getColumn(c).width = width;
  }
  for (let r = 1; r <= maxRow; r++) {
    const sr = src.getRow(r);
    const dr = dst.getRow(r);
    if (sr.height) dr.height = sr.height;
    for (let c = 1; c <= maxCol; c++) {
      const sc = sr.getCell(c);
      const dc = dr.getCell(c);
      dc.value = sc.value;
      if (sc.style) dc.style = JSON.parse(JSON.stringify(sc.style)) as ExcelJS.Style;
      if (sc.numFmt) dc.numFmt = sc.numFmt;
    }
  }
  for (const range of src.model.merges ?? []) {
    try { dst.mergeCells(range); } catch { /* ignore */ }
  }
  try { dst.pageSetup = { ...src.pageSetup }; } catch { /* ignore */ }
}

function fillSheet(ws: ExcelJS.Worksheet, data: In, phase: PhaseIn): void {
  const name = clean(data.name);
  const grade = clean(data.grade);
  const school = clean(data.school);
  const teacher = clean(data.teacher) || "郭老师";
  const subject = clean(data.subject) || "数学";
  const teacherLevel = clean(data.teacherLevel) || "—";
  const totalHours = Math.max(0, Math.round(Number(phase.totalHours ?? data.totalHours) || 0));
  const usedHours = Math.max(0, Math.round(Number(data.usedHours) || 0));

  ws.getCell("A1").value = `${name}个性化辅导计划表`;
  ws.getCell("A3").value = name;
  ws.getCell("B3").value = [school, grade].filter(Boolean).join(" ");
  ws.getCell("C3").value = teacher;
  ws.getCell("D3").value = subject;
  ws.getCell("E3").value = teacherLevel;
  ws.getCell("F3").value = `${totalHours}h`;
  ws.getCell("G3").value = usedHours;

  const analysis = data.analysis || {};
  DIM_ROWS.forEach((key, i) => {
    ws.getCell(`B${6 + i}`).value = clean(analysis[key]) || "—";
  });
  ws.getCell("B14").value = clean(phase.totalGoal ?? data.totalGoal) || "—";
  ws.getCell("B15").value = clean(phase.cycleText ?? data.cycleText) || "—";

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

  const rows = Array.isArray(phase.rows) ? phase.rows : [];
  for (let i = 0; i < rows.length; i++) {
    const r = 17 + i;
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

  const sig = 17 + rows.length;
  ws.insertRow(sig, 1);
  const sigRow = ws.getRow(sig);
  sigRow.height = 22.5;
  for (let c = 1; c <= 7; c++) sigRow.getCell(c).style = styles[c] as never;
  sigRow.getCell(1).value = "组长/主任签字";
  sigRow.getCell(4).value = "家长签字";
  sigRow.getCell(6).value = "日期";
  try { ws.mergeCells(`B${sig}:C${sig}`); } catch { /* ignore */ }
}

function sheetName(label: string, index: number): string {
  const base = clean(label).replace(/[\\/*?:[\]]/g, "").replace(/[（）()]/g, "").trim();
  return (base || `阶段${index + 1}`).slice(0, 31);
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer.user) return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });

  let body: In;
  try { body = (await req.json()) as In; } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  if (!clean(body.name)) return NextResponse.json({ ok: false, error: "缺少学生姓名。" }, { status: 400 });

  const phases: PhaseIn[] = Array.isArray(body.phases) && body.phases.length
    ? body.phases
    : [{ rows: body.rows, totalHours: body.totalHours, cycleText: body.cycleText, totalGoal: body.totalGoal, label: body.phaseLabel }];
  if (phases.length > 4) return NextResponse.json({ ok: false, error: "最多导出 4 个阶段。" }, { status: 413 });
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    const rows = Array.isArray(p.rows) ? p.rows : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: `阶段 ${i + 1} 没有可导出的模块行。` }, { status: 400 });
    if (rows.length > 30) return NextResponse.json({ ok: false, error: `阶段 ${i + 1} 模块行最多 30 行。` }, { status: 413 });
  }

  const templatePath = path.join(process.cwd(), "public", "templates", "plan-designer-template.xlsx");
  const bytes = await readFile(templatePath);
  const templateWb = new ExcelJS.Workbook();
  await templateWb.xlsx.load(bytes as unknown as ArrayBuffer);
  const templateSheet = templateWb.worksheets[0];
  if (!templateSheet) return NextResponse.json({ ok: false, error: "模板文件缺少工作表。" }, { status: 500 });

  const wb = new ExcelJS.Workbook();
  const names = new Set<string>();
  phases.forEach((phase, i) => {
    let label = sheetName(phase.label || `阶段${i + 1}`, i);
    let n = 2;
    while (names.has(label)) label = `${sheetName(phase.label || `阶段${i + 1}`, i).slice(0, 29)}${n++}`;
    names.add(label);
    const ws = wb.addWorksheet(label);
    copyTemplateSheet(templateSheet, ws);
    fillSheet(ws, body, phase);
  });

  const out = await wb.xlsx.writeBuffer();
  const filename = `${clean(body.name)}-个性化辅导方案${phases.length > 1 ? `（${phases.length}阶段）` : ""}.xlsx`;
  return new NextResponse(out as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="plan.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
