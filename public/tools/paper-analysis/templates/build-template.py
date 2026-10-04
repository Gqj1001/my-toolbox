# 构建脚本：把 templates/模板-占位符.docx 拆成
#   1) templates/parts/<每个零件>       —— 明文零件，便于调试与直接替换
#   2) js/template-data.js              —— 把零件内嵌成 JS，浏览器可直接用（含 file:// 场景）
# 原模板不改动，每次改完模板重新跑一次本脚本即可。
import zipfile, io, os, json, re

SRC  = r"M:\学生文件\00_试卷分析工作台\templates\模板-占位符.docx"
PARTS_DIR = r"M:\学生文件\00_试卷分析工作台\templates\parts"
OUT_JS    = r"M:\学生文件\00_试卷分析工作台\js\template-data.js"

z = zipfile.ZipFile(SRC)
names = z.namelist()

os.makedirs(PARTS_DIR, exist_ok=True)

# 1) 导出所有零件（明文）
parts = {}
for n in names:
    if n.endswith("/"):
        continue
    data = z.read(n)
    dst = os.path.join(PARTS_DIR, n.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(data)
    parts[n] = data

doc = parts["word/document.xml"].decode("utf-8")
print("零件数：", len(parts))
print("document.xml 大小：", len(parts["word/document.xml"]), "字节 →",
      len(doc), "字符")
total = sum(len(v) for v in parts.values())
print("全部零件合计：", total, "字节")

# 2) 占位符清单（供运行时校验）
PH = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
ph = sorted(set(PH.findall(doc)))
print("占位符数：", len(ph))

# 3) 生成 js/template-data.js
#    零件用 base64 内嵌，避免转义问题；键名保持原 zip 路径
import base64
lines = []
lines.append("/**")
lines.append(" * 自动生成，请勿手改！")
lines.append(" * 来源：templates/模板-占位符.docx")
lines.append(" * 重新生成： node server/build-template.js")
lines.append(" *")
lines.append(" * 把 Word 模板的所有零件以 base64 内嵌，浏览器无需解压即可直接使用。")
lines.append(" * 文本类零件（.xml/.rels）同时给出明文，便于字符串替换。")
lines.append(" */")
lines.append("(function (root, factory) {")
lines.append("  if (typeof module === 'object' && module.exports) module.exports = factory();")
lines.append("  else root.TemplateData = factory();")
lines.append("}(typeof self !== 'undefined' ? self : this, function () {")
lines.append("  'use strict';")
lines.append("")
lines.append("  /** 零件顺序 = 原 zip 内顺序，重新打包时保持一致 */")
lines.append("  var ORDER = " + json.dumps(names, ensure_ascii=False) + ";")
lines.append("")
lines.append("  /** 各零件 base64 */")
lines.append("  var B64 = {")
for n in names:
    if n.endswith("/"):
        continue
    lines.append('    ' + json.dumps(n, ensure_ascii=False) + ': "' +
                 base64.b64encode(parts[n]).decode("ascii") + '",')
lines[-1] = lines[-1].rstrip(",")
lines.append("  };")
lines.append("")
lines.append("  /** 文本类零件直接给明文，省去解码 */")
lines.append("  var TEXT_PARTS = {};")
lines.append("  function isText(n) { return /\\.(xml|rels)$/i.test(n); }")
lines.append("")
lines.append("  function b64ToBytes(b64) {")
lines.append("    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));")
lines.append("    var bin = atob(b64), out = new Uint8Array(bin.length);")
lines.append("    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);")
lines.append("    return out;")
lines.append("  }")
lines.append("  function bytesToB64(u8) {")
lines.append("    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');")
lines.append("    var s = '';")
lines.append("    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);")
lines.append("    return btoa(s);")
lines.append("  }")
lines.append("  function utf8Decode(u8) {")
lines.append("    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);")
lines.append("    return Buffer.from(u8).toString('utf8');")
lines.append("  }")
lines.append("  function utf8Encode(s) {")
lines.append("    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);")
lines.append("    return new Uint8Array(Buffer.from(s, 'utf8'));")
lines.append("  }")
lines.append("")
lines.append("  /** 取某零件的明文字符串（仅文本类零件） */")
lines.append("  function getText(name) {")
lines.append("    if (TEXT_PARTS[name] != null) return TEXT_PARTS[name];")
lines.append("    if (!B64[name]) throw new Error('模板里没有零件：' + name);")
lines.append("    TEXT_PARTS[name] = utf8Decode(b64ToBytes(B64[name]));")
lines.append("    return TEXT_PARTS[name];")
lines.append("  }")
lines.append("  /** 取某零件的字节 */")
lines.append("  function getBytes(name) {")
lines.append("    if (B64[name] == null) throw new Error('模板里没有零件：' + name);")
lines.append("    return b64ToBytes(B64[name]);")
lines.append("  }")
lines.append("  /** 覆盖某零件的明文（用于替换后重新打包） */")
lines.append("  function setText(name, s) { TEXT_PARTS[name] = s; }")
lines.append("  /** 丢弃所有覆盖，回到模板原始状态 */")
lines.append("  function reset() { TEXT_PARTS = {}; }")
lines.append("  /**")
lines.append("   * 组装出最终零件表 [{name, data:Uint8Array}]")
lines.append("   * @param {object} [overrides] 本次要覆盖的零件 {零件名: 明文}")
lines.append("   *        不写回模块状态，可安全反复调用（避免多次导出互相污染）")
lines.append("   */")
lines.append("  function collect(overrides) {")
lines.append("    overrides = overrides || {};")
lines.append("    var files = [];")
lines.append("    ORDER.forEach(function (n) {")
lines.append("      if (B64[n] == null && overrides[n] == null) return;")
lines.append("      var data;")
lines.append("      if (overrides[n] != null) data = utf8Encode(overrides[n]);")
lines.append("      else if (TEXT_PARTS[n] != null) data = utf8Encode(TEXT_PARTS[n]);")
lines.append("      else data = b64ToBytes(B64[n]);")
lines.append("      files.push({ name: n, data: data });")
lines.append("    });")
lines.append("    return files;")
lines.append("  }")
lines.append("")
lines.append("  return { ORDER: ORDER, getText: getText, getBytes: getBytes, setText: setText,")
lines.append("           reset: reset, collect: collect, isText: isText, utf8Decode: utf8Decode,")
lines.append("           utf8Encode: utf8Encode, bytesToB64: bytesToB64, b64ToBytes: b64ToBytes,")
lines.append("           PLACEHOLDERS: " + json.dumps(ph, ensure_ascii=False) + " };")
lines.append("}));")

with io.open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines) + "\n")

print("已写出：", OUT_JS, os.path.getsize(OUT_JS), "字节")

# ---------------------------------------------------------------
# 自检：重新读回并逐个零件比对，确保 base64 往返无损
# （内嵌方案经不起"文本规范化"，所以每次构建都必须验一遍）
# ---------------------------------------------------------------
import base64 as _b64
import re as _re
_src = io.open(OUT_JS, encoding="utf-8").read()
_bad = []
for _n in names:
    if _n.endswith("/"):
        continue
    # 从生成文件里抠出该零件的 base64
    _m = _re.search(r'^\s*' + _re.escape(json.dumps(_n, ensure_ascii=False)) + r': "([A-Za-z0-9+/=]*)"',
                    _src, _re.M)
    if not _m:
        _bad.append((_n, "生成文件里找不到该零件"))
        continue
    if _b64.b64decode(_m.group(1)) != parts[_n]:
        _bad.append((_n, "base64 往返后不一致"))

print()
if _bad:
    print("[FAIL] 自检失败：")
    for _n, _why in _bad:
        print("   ", _n, "->", _why)
    raise SystemExit(1)
# 注意：不要用 ✓/✗ 这类字符，Windows 控制台默认 GBK 会 UnicodeEncodeError
print("[OK] 自检通过：", len([n for n in names if not n.endswith('/')]), "个零件 base64 往返全部一致")

print("零件列表：")
for n in names:
    if not n.endswith("/"):
        print("   ", n, len(parts[n]))
