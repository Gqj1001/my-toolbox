# -*- coding: utf-8 -*-
"""
构建脚本：把 docs/math-plan-template/模板-占位符.docx 拆成
  1) public/tools/math-plan/template-parts/<每个零件>   —— 明文零件，便于调试（gitignore）
  2) public/tools/math-plan/template-data.js            —— 零件以 base64 内嵌，浏览器直接可用

原模板**不改动**。每次在 Word 里改完模板，重新跑一次本脚本即可。

用法：
  python public/tools/math-plan/build-template.py
"""
import zipfile, io, os, json, re, base64

HERE = os.path.dirname(os.path.abspath(__file__))                 # public/tools/math-plan
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))      # 仓库根
SRC = os.path.join(ROOT, "docs", "math-plan-template", "模板-占位符.docx")
PARTS_DIR = os.path.join(HERE, "template-parts")
OUT_JS = os.path.join(HERE, "template-data.js")

if not os.path.exists(SRC):
    raise SystemExit("找不到模板：" + SRC)

z = zipfile.ZipFile(SRC)
# 只保留文件条目（zip 里可能有目录条目），顺序 = 原 zip 顺序
names = [n for n in z.namelist() if not n.endswith("/")]

os.makedirs(PARTS_DIR, exist_ok=True)

# ---------- 1) 导出所有零件（明文） ----------
parts = {}
for n in names:
    data = z.read(n)
    dst = os.path.join(PARTS_DIR, n.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(data)
    parts[n] = data

doc = parts["word/document.xml"].decode("utf-8")
print("零件数：", len(parts))
print("document.xml：", len(parts["word/document.xml"]), "字节 ->", len(doc), "字符")
print("全部零件合计：", sum(len(v) for v in parts.values()), "字节")

# ---------- 2) 占位符清单（供运行时校验） ----------
PH = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
ph = sorted(set(PH.findall(doc)))
print("占位符种类：", len(ph))

# 逐次课表样板行统计（s1..sN）
row_nums = sorted({int(m) for m in re.findall(r"\{\{\s*s(\d+)_[a-z]{2}\s*\}\}", doc)})
print("逐次课表样板行：", (row_nums[0], "...", row_nums[-1]) if row_nums else "无", "共", len(row_nums), "行")

# ---------- 3) 生成 template-data.js ----------
L = []
L.append("/**")
L.append(" * 自动生成，请勿手改！")
L.append(" * 来源：docs/math-plan-template/模板-占位符.docx")
L.append(" * 重新生成： python public/tools/math-plan/build-template.py")
L.append(" *")
L.append(" * 把《辅导方案》Word 模板的所有零件以 base64 内嵌，浏览器无需解压即可直接使用。")
L.append(" * 文本类零件（.xml/.rels）另给明文缓存，便于字符串替换。")
L.append(" */")
L.append("(function (root, factory) {")
L.append("  if (typeof module === 'object' && module.exports) module.exports = factory();")
L.append("  else root.MathPlanTemplateData = factory();")
L.append("}(typeof self !== 'undefined' ? self : this, function () {")
L.append("  'use strict';")
L.append("")
L.append("  /** 零件顺序 = 原 zip 内顺序，重新打包时保持一致 */")
L.append("  var ORDER = " + json.dumps(names, ensure_ascii=False) + ";")
L.append("")
L.append("  /** 各零件 base64 */")
L.append("  var B64 = {")
for n in names:
    L.append('    ' + json.dumps(n, ensure_ascii=False) + ': "'
             + base64.b64encode(parts[n]).decode("ascii") + '",')
L[-1] = L[-1].rstrip(",")
L.append("  };")
L.append("")
L.append("  var TEXT_PARTS = {};")
L.append("  function isText(n) { return /\\.(xml|rels)$/i.test(n); }")
L.append("")
L.append("  function b64ToBytes(b64) {")
L.append("    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));")
L.append("    var bin = atob(b64), out = new Uint8Array(bin.length);")
L.append("    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);")
L.append("    return out;")
L.append("  }")
L.append("  function utf8Decode(u8) {")
L.append("    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);")
L.append("    return Buffer.from(u8).toString('utf8');")
L.append("  }")
L.append("  function utf8Encode(s) {")
L.append("    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);")
L.append("    return new Uint8Array(Buffer.from(s, 'utf8'));")
L.append("  }")
L.append("")
L.append("  /** 取某零件的明文（仅文本类零件） */")
L.append("  function getText(name) {")
L.append("    if (TEXT_PARTS[name] != null) return TEXT_PARTS[name];")
L.append("    if (!B64[name]) throw new Error('模板里没有零件：' + name);")
L.append("    TEXT_PARTS[name] = utf8Decode(b64ToBytes(B64[name]));")
L.append("    return TEXT_PARTS[name];")
L.append("  }")
L.append("  function getBytes(name) {")
L.append("    if (B64[name] == null) throw new Error('模板里没有零件：' + name);")
L.append("    return b64ToBytes(B64[name]);")
L.append("  }")
L.append("  function setText(name, s) { TEXT_PARTS[name] = s; }")
L.append("  function reset() { TEXT_PARTS = {}; }")
L.append("  /**")
L.append("   * 组装最终零件表 [{name, data}]")
L.append("   * @param {object} [overrides] 本次覆盖的零件 {零件名: 明文}；不写回模块状态，可反复调用")
L.append("   */")
L.append("  function collect(overrides) {")
L.append("    overrides = overrides || {};")
L.append("    var files = [];")
L.append("    ORDER.forEach(function (n) {")
L.append("      if (B64[n] == null && overrides[n] == null) return;")
L.append("      var data;")
L.append("      if (overrides[n] != null) data = utf8Encode(overrides[n]);")
L.append("      else if (TEXT_PARTS[n] != null) data = utf8Encode(TEXT_PARTS[n]);")
L.append("      else data = b64ToBytes(B64[n]);")
L.append("      files.push({ name: n, data: data });")
L.append("    });")
L.append("    return files;")
L.append("  }")
L.append("")
L.append("  return { ORDER: ORDER, getText: getText, getBytes: getBytes, setText: setText,")
L.append("           reset: reset, collect: collect, isText: isText,")
L.append("           utf8Decode: utf8Decode, utf8Encode: utf8Encode, b64ToBytes: b64ToBytes,")
L.append("           PLACEHOLDERS: " + json.dumps(ph, ensure_ascii=False) + ",")
L.append("           LESSON_ROWS: " + json.dumps(len(row_nums)) + " };")
L.append("}));")

with io.open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(L) + "\n")

print("已写出：", OUT_JS, os.path.getsize(OUT_JS), "字节")

# ---------- 4) 自检：base64 往返无损 ----------
_src = io.open(OUT_JS, encoding="utf-8").read()
bad = []
for n in names:
    m = re.search(r'^\s*' + re.escape(json.dumps(n, ensure_ascii=False)) + r': "([A-Za-z0-9+/=]*)"',
                  _src, re.M)
    if not m:
        bad.append((n, "生成文件里找不到该零件"))
        continue
    if base64.b64decode(m.group(1)) != parts[n]:
        bad.append((n, "base64 往返后不一致"))

print()
if bad:
    print("[FAIL] 自检失败：")
    for n, why in bad:
        print("   ", n, "->", why)
    raise SystemExit(1)
print("[OK] 自检通过：", len(names), "个零件 base64 往返全部一致")
print("[OK] 占位符", len(ph), "种；逐次课表样板行", len(row_nums), "行")
