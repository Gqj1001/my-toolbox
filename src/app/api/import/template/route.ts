import * as XLSX from "xlsx";
import { getCurrentUserWithRole } from "@/lib/auth-role";

export async function GET() {
  const { role } = await getCurrentUserWithRole();
  if (role !== "admin") {
    return new Response("只有 Owner/管理员能下载模板。", { status: 403 });
  }

  const headers = ["学生姓名", "年级", "学校", "学管师", "科目", "老师"];
  const example = ["示例学生", "高三", "三河一中", "李学管", "数学", "郭老师"];
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  ws["!cols"] = headers.map(() => ({ wch: 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "学生档案");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename=\"student-import-template.xlsx\"",
      "Cache-Control": "no-store",
    },
  });
}
