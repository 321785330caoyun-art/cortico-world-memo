/**
 * memo 记忆图引擎（第一期）
 *
 * 纯逻辑，不碰网络、不碰 Coopanion。
 *   · 输入：partner/**\/*.md 的文本 + 文件信息
 *   · 输出：blocks（记忆片段）+ graph（共现边）
 *   · 存储：JSON 文件（第一期块量小，零依赖；第二期量大再换 sqlite）
 *
 * 铁律：
 *   1. 每个 block 必须能反查回原文那一行（file + startLine + endLine + text 逐字）
 *   2. 只读本子，绝不写本子
 *   3. 图里有、本子里找不到的 → 构建时反查失败即丢弃
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---- 中文分词（极简：按字符 n-gram + 标点切）----
// 不做真分词，用「连续汉字 2~4 字滑窗 + 英文/数字整词」抽 key，够建共现边。
const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '和', '与', '就',
  '都', '也', '还', '又', '很', '这', '那', '有', '没', '不', '个', '上', '下', '中',
  '啊', '吧', '呢', '吗', '嗯', '哦', '着', '过', '把', '被', '给', '对', '到', '而',
  'the', 'a', 'of', 'to', 'and', 'is', 'in', 'it', 'that', 'this']);

// 最长匹配：一段连续汉字里，从左往右贪心取最长可接受 key（4→3→2），
// 命中一个就整段跳过它的长度，不再记它的子串。
// 目的：杜绝「张三/三丰/张三丰」这类同一名字被 2~4gram 重复计数（六合一），
//       让一条边不会因为同一个名字被放大 6 倍。
// 停用字：单字停用。若以停用字开头，则从一个非停用起点找最长 gram。
function extractKeys(text) {
  const keys = new Map(); // key -> 次数
  const bump = (k) => keys.set(k, (keys.get(k) || 0) + 1);
  // 英文/数字整词
  const ascii = text.match(/[A-Za-z0-9_]{2,}/g) || [];
  for (const w of ascii) {
    const k = w.toLowerCase();
    if (!STOP.has(k)) bump(k);
  }
  // 中文：按非汉字切成片段，每个片段内最长贪心
  const cjkRuns = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of cjkRuns) {
    let i = 0;
    while (i < run.length) {
      // 找从 i 起的最长可接受 gram（4→3→2），要求不含停用整词、且长度≥2
      let matched = 0;
      const maxN = Math.min(4, run.length - i);
      for (let n = maxN; n >= 2; n--) {
        const k = run.slice(i, i + n);
        if (STOP.has(k)) continue;
        matched = n;
        break;
      }
      if (matched > 0) {
        const gram = run.slice(i, i + matched);
        bump(gram);
        // ★ 补记 2 字子串：贪心最长匹配会把「反刍」这类短词整段吞掉
        //   （"反刍和反思的区别" → 只出 "反刍和反" / "思的区别"，反刍 丢了），
        //   该词在本块就完全没有 key、建不出边。IDF 会把补出来的高频子串压下去。
        for (let s = 0; s + 2 <= gram.length; s++) {
          const sub = gram.slice(s, s + 2);
          if (!STOP.has(sub)) bump(sub);
        }
        i += matched;
      } else {
        // 当前起点凑不出 ≥2 的可用 gram（可能是停用字或到末尾剩 1 字）：跳过 1 字
        i += 1;
      }
    }
  }
  return keys;
}

// ---- 切块：按【结构边界】，不按字数，不认路径 ----
// 四种天然边界先切，切完是什么就是什么：
//   ① `#` 标题行        → 新小节（改 anchor）
//   ② 列表项 `- ` / `1. ` → 每项一块
//   ③ 表格行 `| ... |`   → 每行一块（一行一条消息，对话记录天然对得上）
//   ④ 空行              → 结束当前非结构段落
// 字数只做【兜底】：只有当一块切完仍超长、且内部没有任何结构边界时，才按句号切。
// 每块带：anchor(小节标题) + startLine/endLine（反查原文）；writtenAt 由 buildIndex 补。
const HARD_CAP = 800;            // 仅兜底用：单块超过它、且无法再按句切，才硬留
const LIST_RE = /^\s*([-*+]|\d+\.)\s+/;
const TABLE_RE = /^\s*\|/;

function chunkMarkdown(content) {
  const MAX = 450;
  const lines = content.split(/\r?\n/);
  const blocks = [];

  const emit = (text, startLine, endLine, anchor) => {
    const t = text.trim();
    if (t.length >= 4) blocks.push({ anchor: anchor || '(正文)', startLine, endLine, text: t });
  };

  // 只认 `##` / `###` 作为小节边界；`#` 标题留在正文里。
  const sections = [];
  let cur = { anchor: '(正文)', sectionStart: 0, lines: [] };
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{2,3})\s+(.*)$/.exec(lines[i]);
    if (h) {
      sections.push(cur);
      cur = { anchor: h[2].trim(), sectionStart: i + 1, lines: [] };
    } else {
      cur.lines.push({ lineNo: i + 1, raw: lines[i] });
    }
  }
  sections.push(cur);

  const normalize = (line, inFence) => {
    if (inFence) return line.replace(/\s+$/, '');
    return line.trim();
  };

  const sectionUnits = (srcLines) => {
    const units = [];
    let i = 0;
    let inFence = false;
    while (i < srcLines.length) {
      const raw = srcLines[i].raw;
      if (raw.trim() === '') { i++; continue; }

      // 代码块整体作为一个单元，保留缩进；不要在代码块内部按空行切。
      if (/^\s*(```|~~~)/.test(raw)) {
        const arr = [srcLines[i]];
        inFence = true;
        i++;
        while (i < srcLines.length) {
          arr.push(srcLines[i]);
          if (/^\s*(```|~~~)/.test(srcLines[i].raw)) { i++; inFence = false; break; }
          i++;
        }
        units.push({ kind: 'code', lines: arr });
        continue;
      }

      // 表格：表头 + 分隔行是一个单元，每条数据行各自是单元；打包时再按 450 字上限合并。
      if (/^\s*\|/.test(raw)) {
        const arr = [];
        while (i < srcLines.length && srcLines[i].raw.trim() !== '' && /^\s*\|/.test(srcLines[i].raw)) {
          arr.push(srcLines[i]); i++;
        }
        if (arr.length > 2) {
          units.push({ kind: 'tableheader', lines: arr.slice(0, 2) });
          for (let k = 2; k < arr.length; k++) units.push({ kind: 'tablerow', lines: [arr[k]] });
        } else {
          units.push({ kind: 'table', lines: arr });
        }
        continue;
      }

      // 列表项：每个列表行（含缩进子条目）各自是一个单元；普通缩进续行归入上一项。
      if (/^\s*([-*+]|\d+\.)\s+/.test(raw)) {
        const arr = [srcLines[i]]; i++;
        while (i < srcLines.length) {
          const s = srcLines[i].raw;
          if (s.trim() === '') break;
          if (/^\s*([-*+]|\d+\.)\s+/.test(s)) break;       // 下一个列表项，另起一块
          if (/^\s*\|/.test(s)) break;                    // 表格另起
          if (/^\s+\S/.test(s)) { arr.push(srcLines[i]); i++; continue; } // 普通缩进续行
          break;
        }
        units.push({ kind: 'list', lines: arr });
        continue;
      }

      // 普通段落：到空行/表格/顶格列表/代码块为止。
      const arr = [];
      while (i < srcLines.length) {
        const s = srcLines[i].raw;
        if (s.trim() === '') break;
        if (arr.length && (/^\s*\|/.test(s) || /^([-*+]|\d+\.)\s+/.test(s) || /^\s*(```|~~~)/.test(s))) break;
        arr.push(srcLines[i]); i++;
      }
      if (arr.length) units.push({ kind: 'para', lines: arr });
    }
    return units;
  };

  const splitLongUnit = (unit) => {
    const norm = unit.lines.map(x => normalize(x.raw, unit.kind === 'code'));
    const text = norm.join('\n').trim();
    if (text.length <= MAX) return [unit.lines];

    // 单行/表格行超长：只能硬切；其余优先按句号/分号边界切，不按句内切。
    if (unit.kind === 'tableheader' || unit.kind === 'tablerow' || unit.kind === 'code') {
      const out = [];
      let acc = '';
      for (const ln of norm) {
        const p = acc ? acc + '\n' + ln : ln;
        if (acc && p.length > MAX) { out.push(acc); acc = ln; } else acc = p;
      }
      if (acc) out.push(acc);
      const pieces = [];
      for (const p of out) {
        if (p.length <= MAX) pieces.push(p);
        else for (let k = 0; k < p.length; k += MAX) pieces.push(p.slice(k, k + MAX));
      }
      return pieces.map(p => [{ lineNo: unit.lines[0].lineNo, raw: p }]);
    }

    const sentences = text.split(/(?<=[。！？；!?;])/).filter(s => s.length);
    const packed = [];
    let acc = '';
    for (const s of sentences) {
      if (acc && (acc + s).length > MAX) { packed.push(acc); acc = s; }
      else acc += s;
    }
    if (acc) packed.push(acc);
    const pieces = [];
    for (const p of packed) {
      if (p.length <= MAX) pieces.push(p);
      else for (let k = 0; k < p.length; k += MAX) pieces.push(p.slice(k, k + MAX));
    }
    return pieces.map(p => [{ lineNo: unit.lines[0].lineNo, raw: p }]);
  };

  for (const sec of sections) {
    const nonEmpty = sec.lines.filter(l => l.raw.trim() !== '');
    if (!nonEmpty.length) continue;
    const rawText = sec.lines.map(l => l.raw).join('\n').trim();
    // 短小节原样保留（包括原有空行），与 shadow-450 的口径一致。
    if (rawText.length <= MAX) {
      emit(rawText, nonEmpty[0].lineNo, nonEmpty[nonEmpty.length - 1].lineNo, sec.anchor);
      continue;
    }

    const units = sectionUnits(sec.lines);
    let curTexts = [], curStart = 0, curEnd = 0;
    const flush = () => {
      if (!curTexts.length) return;
      emit(curTexts.join('\n').trim(), curStart, curEnd, sec.anchor);
      curTexts = []; curStart = 0; curEnd = 0;
    };

    for (const unit of units) {
      for (const piece of splitLongUnit(unit)) {
        const txt = piece.map(x => normalize(x.raw, unit.kind === 'code')).join('\n').trim();
        if (!txt) continue;
        const candidate = curTexts.length ? curTexts.concat([txt]).join('\n') : txt;
        if (curTexts.length && candidate.length > MAX) flush();
        if (!curTexts.length) curStart = piece[0].lineNo;
        curTexts.push(txt);
        curEnd = piece[piece.length - 1].lineNo;
      }
    }
    flush();
  }
  return blocks;
}

// ---- 时间标注（只认「完整日期」与「MM-DD + 文件路径年份」，不拿 mtime 凑）----
function _pad2(n) { return String(n).padStart(2, '0'); }
function _isoDate(y, m, d) {
  if (!(y >= 1900 && y <= 3000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${_pad2(m)}-${_pad2(d)}`;
}
/** 标题里的完整日期：2026-10-21 / 2026年10月21日 */
function _fullDateIn(text) {
  if (!text) return null;
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return _isoDate(+m[1], +m[2], +m[3]);
  m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (m) return _isoDate(+m[1], +m[2], +m[3]);
  return null;
}
/** 标题里的 MM-DD（前后不能粘着数字，避免从完整日期里再切一次） */
function _monthDayIn(text) {
  if (!text) return null;
  const m = /(?:^|[^\d])(\d{1,2})-(\d{1,2})(?![\d-])/.exec(text);
  if (!m) return null;
  const mm = +m[1], dd = +m[2];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { m: mm, d: dd };
}
/** 文件路径里的完整日期（用于给 MM-DD 补年份，也用于 ±7 天校验） */
function _dateInPath(rel) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(rel || '');
  return m ? _isoDate(+m[1], +m[2], +m[3]) : null;
}
function _dayDiff(a, b) {
  return Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
}
/** 标题里的「不完整日期」原文：MM-DD 或 HH:MM（可带 x 占位），只照抄、不补全。 */
function _partialIn(anchor) {
  if (!anchor) return null;
  let m = /(?:^|[^\d])(\d{1,2}-\d{1,2}[xX]?)(?![0-9-])/.exec(anchor);
  if (m) return m[1];
  m = /(?:^|[^\d])(\d{1,2}:\d{1,2}[xX]?)(?![0-9])/.exec(anchor);
  if (m) return m[1];
  return null;
}
/**
 * 一块的「大概是什么时候的事」。
 * 优先级：① 标题完整日期 → heading；② 文件路径完整日期 → filename（整份文件都是那一天）；
 *        ③ 标题只有 MM-DD / HH:MM → tRaw 原文照抄、t=null、tFrom=partial；④ 其余 none。
 * **绝不使用文件 mtime，也不使用建索引时间。**
 */
function resolveBlockTime(anchor, rel) {
  const full = _fullDateIn(anchor);
  if (full) return { t: full, tFrom: 'heading', tRaw: null };
  const pathDate = _dateInPath(rel);
  if (pathDate) return { t: pathDate, tFrom: 'filename', tRaw: null };
  const raw = _partialIn(anchor);
  if (raw) return { t: null, tFrom: 'partial', tRaw: raw };
  return { t: null, tFrom: 'none', tRaw: null };
}

// ---- 切块收块：给定一组绝对文件路径，扫出来变成 blocks ----
// 每个块带 id（全局递增，调用方重编号）、file(相对 partnerDir)、行号、原文。
function collectBlocks(partnerDir, absFiles) {
  const blocks = [];
  // ★ 清单（manifest）：被索引的文件 → mtime + 字节数。
  //   用途：判断「索引还准不准」。比时间戳强，因为删除/改名不会产生新时间戳，
  //   但在清单上是「少了一条 / 换了名字」，直接可见。随 stats 返回，不落盘。
  const manifest = [];
  let scannedFiles = 0;
  let dropped = 0;
  // ★ 跨重建稳定的键：file + 正文 sha1 前 16 位 +（同文件同哈希的第几份）
  //   不用 id（顺序编号，重建会平移）、不用 startLine（上面插一行就变）。
  const seenHash = new Map();
  for (const file of absFiles) {
    scannedFiles++;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(partnerDir, file).replace(/\\/g, '/');
    const stat = fs.statSync(file);
    const writtenAt = new Date(stat.mtimeMs).toISOString();
    manifest.push({ file: rel, mtime: writtenAt, bytes: stat.size });
    const chunks = chunkMarkdown(content);
    const fileLines = content.split(/\r?\n/);
    for (const c of chunks) {
      // 反查校验：startLine/endLine 落在文件实际行数内，且 text 能在原文中按行还原
      if (c.startLine < 1 || c.endLine > fileLines.length || c.endLine < c.startLine) {
        dropped++; continue;
      }
      const backCheck = fileLines.slice(c.startLine - 1, c.endLine).join('\n').trim();
      if (!backCheck.includes(c.text.split('\n')[0].trim())) {
        // 对不上原文 → 这条不入图（铁律 1）
        dropped++; continue;
      }
      const _hash = crypto.createHash('sha1').update(rel + '\u0000' + c.text).digest('hex').slice(0, 16);
      const _hkey = rel + '\u0000' + _hash;
      const _ord = (seenHash.get(_hkey) || 0) + 1;
      seenHash.set(_hkey, _ord);
      const _id = _hash + '#' + _ord;
      const _preview = String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const _time = resolveBlockTime(c.anchor, rel);
      blocks.push({
        id: _id,
        key: _id,
        preview: _preview,
        file: rel,
        anchor: c.anchor,
        t: _time.t,
        tFrom: _time.tFrom,
        tRaw: _time.tRaw,
        startLine: c.startLine,
        endLine: c.endLine,
        writtenAt,
        text: c.text,
      });
    }
  }
  return { blocks, manifest, scannedFiles, dropped };
}

// ---- 建图：给定 blocks 列表（id 已就位），建共现边 ----
function buildGraph(blocks) {
  // ---- 建共现边（IDF 加权，无窗口、无 df 上限）----
  // ① key -> Set(blockId)，同时得到每个 key 的 df
  const keyToBlocks = new Map(); // key -> Set(blockId)
  for (const b of blocks) {
    const keys = extractKeys(b.text);
    for (const k of keys.keys()) {
      if (!keyToBlocks.has(k)) keyToBlocks.set(k, new Set());
      keyToBlocks.get(k).add(b.id);
    }
  }

  // ② IDF 权重：w(k) = 1 / log(1 + df(k))，df 越大权重越趋近 0（降权，不删）
  const idf = (df) => 1 / Math.log(1 + df);

  // ③ 建边：per-block top-K（自然的选择单位 = 「这一块跟谁最像」）
  //    对每个 key，把它覆盖的块两两配对，把 idf(key) 累加到【两块各自】的候选表。
  //    全部 key 累加完后，每块按候选分数取 top-K，其余不建边。
  //    —— 没有任何按 id/顺序的中间截断；df 大的 key 只贡献趋 0 的 idf，
  //      沾一两个高频词的假邻居分数极低，会在每块 top-K 时自然出局。
  //    代价 = Σ per-key(df²)，约三四千万次累加，一次性跑完，不采样。
  const K_NEIGHBORS = 60;     // 每块保留的最相似邻居数
  const cand = new Map();     // blockId -> Map(neighborId -> 累计 idf 分)
  const candOf = (id) => {
    let m = cand.get(id);
    if (!m) { m = new Map(); cand.set(id, m); }
    return m;
  };

  const keyEntries = [...keyToBlocks.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([k, set]) => ({ k, df: set.size, ids: [...set] }));   // 不排序：顺序对累加无影响

  for (const { df, ids } of keyEntries) {
    const w = idf(df);
    const n = ids.length;
    // 两两配对，双向累加（a 的候选表记 b，b 的候选表记 a）
    for (let i = 0; i < n; i++) {
      const a = ids[i];
      const ma = candOf(a);
      for (let j = i + 1; j < n; j++) {
        const b = ids[j];
        ma.set(b, (ma.get(b) || 0) + w);
        const mb = candOf(b);
        mb.set(a, (mb.get(a) || 0) + w);
      }
    }
  }

  // ④ 每块取 top-K → 生成无向边（按块顺序归一，去重；id 本身是内容字符串）
  const byId = new Map(blocks.map(b => [b.id, b]));
  const orderOf = new Map(blocks.map((b, i) => [b.id, i + 1]));
  const edgeW = new Map(); // pairKey -> {a,b,w}；pairKey 用块顺序，不使用 id 字典序
  for (const [a, m] of cand) {
    // 该块候选按分数取 top-K
    const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, K_NEIGHBORS);
    for (const [b, w] of top) {
      const ai = orderOf.get(a) ?? 0, bi = orderOf.get(b) ?? 0;
      const lo = ai < bi ? a : b, hi = ai < bi ? b : a;
      const pairKey = Math.min(ai, bi) + '|' + Math.max(ai, bi);
      // 两端可能都给同一 pair 分，理论上相等（同一 idf 累加），取较大更稳
      const prev = edgeW.get(pairKey);
      if (!prev || w > prev.w) edgeW.set(pairKey, { a: lo, b: hi, w });
    }
  }

  let edges = [];
  for (const { a, b, w: wsum } of edgeW.values()) {
    const ba = byId.get(a), bb = byId.get(b);
    if (!ba || !bb) continue;
    const ta = Date.parse(ba.writtenAt), tb = Date.parse(bb.writtenAt);
    const from = ta <= tb ? a : b;
    const to = ta <= tb ? b : a;
    edges.push({ from, to, weight: +wsum.toFixed(6) });
  }
  // 取消额外的度裁剪：top-K 本身已把每块度数限在 K 以内（两端各自主观，边最多 2K，但每端只留 K）。
  // 保序输出即可。
  return edges;
}

// ---- 全量构建：扫 partnerDir 下的文件（后缀/排除目录/上限可配）----
// opts:
//   extensions   : 收哪些后缀，默认 ['.md']
//   excludeDirs  : 跳过的目录名（任意层级，精确匹配），默认 ['handoffs','archive','blobs','tools']
//   includeSubdirs: 是否递归子目录，默认 true
//   maxFiles     : 文件数上限，超过只警告不中断，默认 5000
//   maxChars     : 总字数上限，超过只警告不中断，默认 5,000,000
function buildIndex(partnerDir, opts = {}) {
  const t0 = Date.now();
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : ['.md'])
    .map(e => String(e).toLowerCase().replace(/^\*?\.?/, '.'));
  const excludeDirs = new Set(
    (opts.excludeDirs && opts.excludeDirs.length ? opts.excludeDirs : ['handoffs', 'archive', 'blobs', 'tools', 'dialogs', 'raw-log'])
      .map(d => String(d).toLowerCase()));
  const recurse = opts.includeSubdirs !== false;
  const maxFiles = typeof opts.maxFiles === 'number' ? opts.maxFiles : 5000;
  const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : 5_000_000;

  const files = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!recurse) continue;
        if (excludeDirs.has(ent.name.toLowerCase())) continue;
        walk(p);
      } else if (ent.isFile()) {
        const low = ent.name.toLowerCase();
        if (exts.some(e => low.endsWith(e))) files.push(p);
      }
    }
  })(partnerDir);

  const warnings = [];
  if (files.length > maxFiles) {
    warnings.push(`本子里有 ${files.length} 个文件，超过上限 ${maxFiles}（只警告、照常构建）；文件特别多时索引会很慢、很占内存，建议先用 excludeDirs 缩范围`);
  }

  const { blocks, manifest, scannedFiles, dropped } = collectBlocks(partnerDir, files);
  const totalChars = blocks.reduce((s, b) => s + b.text.length, 0);
  if (totalChars > maxChars) {
    warnings.push(`本子总字数约 ${totalChars}，超过上限 ${maxChars}（只警告、照常构建）；别人的本子可能是这里的十倍大，建图耗时和内存会显著上升`);
  }

  const edges = buildGraph(blocks);
  return {
    blocks,
    edges,
    warnings,
    stats: {
      scannedFiles,
      addedBlocks: blocks.length,
      droppedBlocks: dropped,
      indexedEdges: edges.length,
      durationMs: Date.now() - t0,
      builtAt: new Date().toISOString(),
      // ★ 清单：被索引的文件 → { file, mtime, bytes }。
      //   判断「索引还准不准」用它对 diff，别只比时间戳——删除/改名不产生新时间戳。
      manifest,
    },
  };
}

// ---- 单文件重算：只重切一个文件，替换它的块，重建图，落盘 ----
// 路径安全：relFile 必须落在 partnerDir 内。
// 正确性：该文件旧块全部删掉、新块追加并重编号 → 全图重算（保证边与新块一致）。
//
// ★★ 别拿它当增量更新 —— 本机实测 37.7s vs 全量 40.5s，只快约 3 秒。
//    省掉的只有「重切其余文件」；建图（buildGraph）仍是全量重算，那才是大头。
//    两个诱人的优化都试算过、都不做：
//      · 把内存里的索引传进来省掉 loadIndex → 只省 0.3s（占 0.8%），不值得多一条路径；
//      · 真做增量建图 → 改一个文件会让相关 key 的 df 变、idf 变、全图权重变，
//        近似实现算漏一处不会报错，只会答得不准 —— 静默变坏比慢 37 秒更糟。
//    要更新索引，直接 buildIndex 全量。
function rebuildFile(indexDir, partnerDir, relFile, opts = {}) {
  const t0 = Date.now();
  const abs = path.resolve(partnerDir, relFile);
  const root = path.resolve(partnerDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, error: '文件路径越出本子目录，拒绝：' + relFile };
  }
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : ['.md'])
    .map(e => String(e).toLowerCase().replace(/^\*?\.?/, '.'));
  const low = abs.toLowerCase();
  if (!exts.some(e => low.endsWith(e)) || !fs.existsSync(abs)) {
    return { ok: false, error: '本子里没有这个文件：' + relFile };
  }
  const rel = path.relative(partnerDir, abs).replace(/\\/g, '/');

  // 载入旧索引（没有就当空；indexDir 为空=纯内存重算，不带旧索引）
  const prev = indexDir ? loadIndex(indexDir) : null;
  const oldBlocks = prev ? prev.blocks : [];
  // 保留其他文件的块
  const kept = oldBlocks.filter(b => b.file !== rel);
  // 重切这个文件
  const { blocks: fresh } = collectBlocks(partnerDir, [abs]);
  // 合并 + 全局重编号
  const merged = kept.concat(fresh);
  merged.forEach((b) => { if (b.key) b.id = b.key; });

  const edges = buildGraph(merged);
  const index = {
    blocks: merged,
    edges,
    stats: {
      scannedFiles: prev?.stats?.scannedFiles ?? 0,
      addedBlocks: merged.length,
      droppedBlocks: prev?.stats?.droppedBlocks ?? 0,
      indexedEdges: edges.length,
      durationMs: Date.now() - t0,
      builtAt: new Date().toISOString(),
    },
  };
  if (!opts.noSave) saveIndex(indexDir, index);
  return { ok: true, index, file: rel, fileBlocks: fresh.length, saved: !opts.noSave };
}

/**
 * 星形模式下的单文件重算：只改 star/index.json，绝不碰 blocks.json / graph.json。
 * 优先用调用方传入的星形索引；没有就从 star/index.json 读（不校验 manifest，便于单文件修复）。
 */
function rebuildStarFile(indexDir, partnerDir, relFile, opts = {}) {
  const t0 = Date.now();
  const abs = path.resolve(partnerDir, relFile);
  const root = path.resolve(partnerDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, error: '文件路径越出本子目录，拒绝：' + relFile };
  }
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : ['.md'])
    .map(e => String(e).toLowerCase().replace(/^\*?\.?/, '.'));
  const low = abs.toLowerCase();
  if (!exts.some(e => low.endsWith(e)) || !fs.existsSync(abs)) {
    return { ok: false, error: '本子里没有这个文件：' + relFile };
  }
  const rel = path.relative(partnerDir, abs).replace(/\\/g, '/');
  let base = opts.index;
  if (!base || !Array.isArray(base.edges) || !Array.isArray(base.blocks)) {
    const loaded = loadStarIndex(indexDir, { useStarIndex: true });
    if (!loaded.ok) return { ok: false, error: '星形索引不可用，先 memo_index 全量重建' };
    base = loaded.index;
  }
  const kept = base.blocks.filter(b => b.file !== rel);
  const { blocks: fresh } = collectBlocks(partnerDir, [abs]);
  const merged = kept.concat(fresh);
  merged.forEach((b) => { if (b.key) b.id = b.key; });
  const idx = buildStar(merged, opts);
  idx.edges = buildEdgesFast(merged);
  idx.vocab = buildTierVocab(merged);
  idx.stats = {
    ...idx.stats,
    scannedFiles: base.stats?.scannedFiles ?? 0,
    addedBlocks: merged.length,
    droppedBlocks: 0,
    indexedEdges: idx.edges.length,
    durationMs: Date.now() - t0,
    builtAt: new Date().toISOString(),
  };
  if (!opts.noSave) saveStarIndex(indexDir, idx, { partnerDir, ...opts });
  return { ok: true, index: idx, file: rel, fileBlocks: fresh.length, saved: !opts.noSave };
}

// ---- 邻接表缓存（★ 提速②）----
// 为什么：原来每次 recall 都重扫 69 万条边建 out/in（约 150 ms/次），而同一份索引在进程里是稳定的。
// 失效条件：edges 条数或 lastIndexedAt 变了就重建（重建索引 / 单文件重算后自动失效）。
const ADJ_CACHE = new WeakMap();
function adjacencyOf(index) {
  const stamp = `${index.edges.length}|${index.stats && (index.stats.builtAt ?? index.stats.lastIndexedAt)}`;
  const hit = ADJ_CACHE.get(index);
  if (hit && hit.stamp === stamp) return hit;
  const out = new Map(), inMap = new Map();
  for (const e of index.edges) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
    (inMap.get(e.to) || inMap.set(e.to, []).get(e.to)).push(e);
  }
  const made = { stamp, out, inMap };
  ADJ_CACHE.set(index, made);
  return made;
}

// ---- 召回计数（独立文件，放索引文件旁边；只写不读，不参与打分）----
// 键是 block.key（file + 正文 sha1），跨重建稳定；改字 = 新键 = 旧计数自然失效。
function bumpRecallCounts(file, keys) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  const now = new Date().toISOString();
  for (const k of keys) {
    if (!k) continue;
    const cur = (data[k] && typeof data[k] === 'object') ? data[k] : { count: 0, lastAt: null };
    cur.count = (Number(cur.count) || 0) + 1;
    cur.lastAt = now;
    data[k] = cur;
  }
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- 召回：带衰减的方向性传播 ----
function legacyRecall(index, query, opts = {}) {
  const k = opts.k || 5;
  const LAMBDA = opts.lambda ?? 0.6;   // 每跳衰减
  const HOPS = opts.hops ?? 3;         // 最多传播 3 跳
  const REVERSE_FLOOR = opts.reverseFloor ?? 0.4; // 逆流阻力
  const HIGH = 0.75, MID = 0.4;

  const qKeys = extractKeys(query);
  if (qKeys.size === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };

  // 建邻接（★ 提速②：同一份索引只建一次，按 edges 数 + lastIndexedAt 失效）
  const { out, inMap } = adjacencyOf(index);

  // ── 起点识别（通用判据，不做单字特判）──
  // 思路：把 query 切成「实质 token」（去掉停用后，长词整词 + 中文按 2~4gram 覆盖），
  //       一个 block 要成为起点，必须有足够"query 覆盖率"：
  //         coverage = 该 block 覆盖到的 query 字符数 / query 有效字符总数
  //       且覆盖的 token 里至少有一个长度≥2 的"实质段"，不是单字沾边。
  //       置信度按 coverage 算，不按传播分归一化 —— 覆盖低就是 low。
  const byId = new Map(index.blocks.map(b => [b.id, b]));
  const score = new Map();
  const why = new Map();
  const coverageOf = new Map();   // blockId -> 覆盖率 0~1

  // query 有效字符（去掉空白、标点）
  const qClean = query.replace(/[\s\p{P}]/gu, '').toLowerCase();
  if (qClean.length === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };
  const qLen = qClean.length;
  const qLow = [...qKeys.keys()];

  // 找出"实质 token"：长度≥2 的 key（中文2gram/长词、ascii≥2 整词）
  const qTokens = qLow.filter(k => k.length >= 2);

  for (const b of index.blocks) {
    const lower = _searchFace(b);   // ★ 检索面：文件名 + 小节标题 + 正文（标题层要能被搜到）
    // 覆盖率：用 query 里所有 2~4gram 中，能在本块找到的最长匹配来累计"被覆盖的字符"
    // 简化可靠算法：把 query 与 block 做「最长公共子串覆盖」——对 query 每个位置标记被覆盖
    const covered = new Array(qLen).fill(false);
    let matchedToken = '';
    // 用 query 的所有长 key(≥2) 去 block 里找，命中则标记其覆盖的字符区间
    for (const k of qTokens) {
      let from = 0;
      while (true) {
        const idx = qClean.indexOf(k, from);
        if (idx < 0) break;
        // 该 key 的字符是否在 block 里出现（考虑原 query 与 block 都含此 token）
        if (lower.includes(k)) {
          for (let x = idx; x < idx + k.length; x++) covered[x] = true;
          if (k.length > matchedToken.length) matchedToken = k;
        }
        from = idx + 1;
      }
    }
    const cov = covered.filter(Boolean).length / qLen;
    if (cov <= 0) continue;
    // ★ 起点门槛（通用）：必须有一个"实质 token（≥2字）"命中，
    //    且覆盖率够（单个 2 字 token 沾边也最多算低覆盖）。
    if (matchedToken.length < 2) continue;
    // 若 query 是纯 ascii，要求原词整段出现，否则不算（防 asdf/xyz 误配）
    if (/^[a-z0-9]+$/i.test(qClean) && !lower.includes(qClean)) continue;
    score.set(b.id, cov);
    why.set(b.id, matchedToken);
    coverageOf.set(b.id, cov);
  }
  if (score.size === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };

  // 传播
  // via: 记录每块是怎么来的（起点直接命中 / 经哪个节点传播来）
  const via = new Map(); // blockId -> { fromId, hop }
  for (const id of score.keys()) via.set(id, { fromId: null, hop: 0 });

  let frontier = new Map(score);
  for (let hop = 1; hop <= HOPS; hop++) {
    const next = new Map();
    const nextFrom = new Map();   // ★ 提速①：随 next 带来源，不再回扫 frontier
    for (const [node, s] of frontier) {
      for (const e of (out.get(node) || [])) {
        const val = s * e.weight * LAMBDA;
        if (val > (next.get(e.to) || 0)) next.set(e.to, val);
        if (!nextFrom.has(e.to)) nextFrom.set(e.to, node);
      }
      for (const e of (inMap.get(node) || [])) {
        const val = s * e.weight * LAMBDA * REVERSE_FLOOR;
        if (val > (next.get(e.from) || 0)) next.set(e.from, val);
        if (!nextFrom.has(e.from)) nextFrom.set(e.from, node);
      }
    }
    for (const [n, s] of next) {
      if (!score.has(n) || score.get(n) < s) {
        if (!score.has(n)) score.set(n, 0);
        score.set(n, score.get(n) + s * (hop === 1 ? 1 : 0.5));
        if (!via.has(n) || via.get(n).hop === 0) {
          if (!(via.has(n) && via.get(n).hop === 0)) via.set(n, { fromId: nextFrom.get(n) ?? null, hop });
        }
      }
    }
    frontier = next;
  }

  // 排序取前 k
  // ★ 起点(cov>0)永远排在传播前面，组内再按分数。
  //   旧写法只按 s 排：传播分 = 权重×λ 可达 3~6，而起点分 = cov ≤ 1，
  //   于是真起点会被传播块挤出前 k —— 那不是"权重压不过门限"，是两种量纲混排。
  const ranked = [...score.entries()]
    .map(([id, s]) => ({ b: byId.get(id), s, cov: coverageOf.get(id) || 0 }))
    .filter(x => x.b)
    .sort((x, y) => (y.cov > 0 ? 1 : 0) - (x.cov > 0 ? 1 : 0) || y.cov - x.cov || y.s - x.s);

  // ★ snippet 围绕"命中词"截取，保证展示的原文里能看见"为什么命中"
  const snippetAround = _snippetAround;   // ★ 统一用模块级 helper，三条路同一套截法

  // ★ 只保留"有实体依据"的条目：
  //   起点命中(cov>0) → 有依据（why=命中词）
  //   传播来的(cov=0) → 必须能追到起点，且给出"经由哪段"的说明；追不到→剔除（噪音）
  const items = [];
  const sectionMap = new Map();
  const hitKeys = [];   // ★ 真正进入 top-k 的块（用于召回计数，仅写不读）
  const missedSnippets = new Set();   // ★ 片段校验不过的文件（按文件去重，出声用）
  for (const { b, s, cov } of ranked) {
    if (sectionMap.size >= k) break;
    const v = via.get(b.id);
    if (cov > 0) {
      // 起点直接命中
      const word = why.get(b.id);
      // ★ 片段必须和检索面同一个面：命中词可能只在标题/文件名里，用 b.text 截就会截不到它
      const snip = snippetAround(_searchFace(b), word);
      if (!_snippetHas(snip, word)) { missedSnippets.add(b.file); continue; }   // ★ 校验不过就丢，不静默
      const item = {
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: snip, why: word,
        score: +Math.min(1, cov).toFixed(3),
        ...(isStaleText(b.text) ? { stale: true } : {}),
      };
      addSectionItem(sectionMap, items, item, b);
      hitKeys.push(b.key);
    } else if (v && v.fromId != null && byId.get(v.fromId)) {
      // 传播来的：说清"经由哪段相关"——共享词是什么
      const src = byId.get(v.fromId);
      const share = (why.get(v.fromId) || '').replace(/^\(.*\)$/, '');
      const snip = snippetAround(_searchFace(b), share);
      if (!_snippetHas(snip, share)) { missedSnippets.add(b.file); continue; }   // ★ 传播项也要含共享词
      const item = {
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: snip,
        why: `经「${src.anchor}」关联（共享「${share}」）`,
        score: +(Math.min(1, cov) * 0.5).toFixed(3),  // 传播的分打对折
        ...(isStaleText(b.text) ? { stale: true } : {}),
      };
      addSectionItem(sectionMap, items, item, b);
      hitKeys.push(b.key);
    }
    // cov=0 且无来源 → 不加入（噪音剔除）
  }
  // 若起点(有依据)为空但有低分传播，全丢弃 → low

  // ★ 置信度按「起点对 query 的覆盖率」定：覆盖高=真命中；覆盖低=沾边→low
  // ★ 用【全部起点】取最大，不用前 k 名：前 k 可能被传播占满，那样会把真实覆盖率
  //   算成 0，把明明命中的词误报成「想不起」。
  let bestCov = 0;
  for (const c of coverageOf.values()) if (c > bestCov) bestCov = c;
  if (missedSnippets.size) {
    for (const f of missedSnippets) console.error('[memo] snippet-miss: ' + f);   // ★ 出声：片段校验不过，已丢弃
  }
  let confidence;
  if (bestCov >= 0.8) confidence = 'high';
  else if (bestCov >= 0.45) confidence = 'mid';
  else confidence = 'low';
  if (items.length === 0 || bestCov < 0.45) confidence = 'low';

  const text = confidence === 'low' ? '想不起，翻下本子'
    : (confidence === 'high' ? '这里可能相关：' : '可能相关，要细看我可以翻：');
  // ★ 召回计数：只记「真的进了 top-k 且不是 low」的块；一次 recall 最多写一次盘。
  //   计数只写不读，本轮不参与任何打分/排序。
  if (opts.countsFile && confidence !== 'low' && hitKeys.length) {
    try { bumpRecallCounts(opts.countsFile, hitKeys); } catch { /* 计数失败不能影响召回 */ }
  }
  return { confidence, text, items: confidence === 'low' ? [] : items };
}

// ---- grep：字面精确 ----
function grep(index, query, limit = 10) {
  const q = String(query || '');
  if (!q) return { hits: [] };
  const hits = [];
  const low = q.toLowerCase();
  for (const b of index.blocks) {
    // ★ 检索面加标题层：文件名 + 小节标题(anchor) + 正文，纯标题词也要能被 grep 到
    const hay = _searchFace(b);
    const at = hay.indexOf(low);
    if (at >= 0) {
      // snippet 围绕命中位置截取，保证「命中词看得见」
      const span = 120, half = Math.floor(span / 2);
      let start = Math.max(0, at - half);
      let s = hay.slice(start, start + span).replace(/\n/g, ' ');
      if (start > 0) s = '…' + s;
      if (start + span < hay.length) s = s + '…';
      hits.push({
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: s, matched: hay.substr(at, q.length),
      });
      if (hits.length >= limit) break;
    }
  }
  return { hits };
}

// ---- locate：点回本子原文那一行 ----
// 输入：partnerDir 根 + file(相对路径) + anchor(小节标题) 或 lines(起始行)
// 输出：file + lines "12-19" + 原文逐字 text
// 铁律：只读本子，绝不写；文件不存在 / 行号越界 → 返回 { ok:false } 让调用方明说
function locate(partnerDir, file, opts = {}) {
  if (!partnerDir || !file) return { ok: false, error: '缺 file 或 partnerDir' };
  // 防目录穿越：解析后必须仍在 partnerDir 之内
  const abs = path.resolve(partnerDir, file);
  const root = path.resolve(partnerDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, error: '文件路径越出本子目录，拒绝：' + file };
  }
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, error: '本子里没有这个文件：' + file };
  }
  const lines = content.split(/\r?\n/);

  let start, end;
  if (typeof opts.anchor === 'number' && opts.anchor >= 1) {
    // 直接给了起始行：默认回该行起 8 行上下文
    start = opts.anchor;
    end = Math.min(lines.length, start + (opts.span || 8) - 1);
  } else if (typeof opts.anchor === 'string' && opts.anchor.trim()) {
    // 给的是小节标题：找该标题行（或首次包含它的正文），回标题段落直到下个标题/文末
    const title = opts.anchor.trim();
    let idx = lines.findIndex(l => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim() === title);
    if (idx < 0) idx = lines.findIndex(l => l.includes(title) && /^#{1,6}\s+/.test(l));
    if (idx < 0) idx = lines.findIndex(l => l.includes(title));
    if (idx < 0) return { ok: false, error: '文件里找不到小节：' + title };
    start = idx + 1;
    // 到下一个标题为止
    let j = idx + 1;
    while (j < lines.length && !/^#{1,6}\s+/.test(lines[j])) j++;
    end = Math.max(start, j);
  } else {
    return { ok: false, error: 'locate 需要 anchor(标题) 或 anchor 行号' };
  }

  if (start < 1) start = 1;
  if (end > lines.length) end = lines.length;
  if (start > end) return { ok: false, error: '行号越界：start>end' };
  const text = lines.slice(start - 1, end).join('\n');
  return { ok: true, file, lines: `${start}-${end}`, text };
}

// ---- 索引持久化：写到 indexDir(workspace 之外)，可整份删了重建 ----
function saveIndex(indexDir, index) {
  fs.mkdirSync(indexDir, { recursive: true });
  const blocksFile = path.join(indexDir, 'blocks.json');
  const graphFile = path.join(indexDir, 'graph.json');
  // blocks 与 edges 分开存：blocks 是真相切片，edges 是派生物
  fs.writeFileSync(blocksFile, JSON.stringify({ blocks: index.blocks, stats: index.stats }, null, 0), 'utf8');
  fs.writeFileSync(graphFile, JSON.stringify({ edges: index.edges }, null, 0), 'utf8');
  return { blocksFile, graphFile };
}

function loadIndex(indexDir) {
  const blocksFile = path.join(indexDir, 'blocks.json');
  const graphFile = path.join(indexDir, 'graph.json');
  if (!fs.existsSync(blocksFile) || !fs.existsSync(graphFile)) return null;
  try {
    const b = JSON.parse(fs.readFileSync(blocksFile, 'utf8'));
    const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    return { blocks: b.blocks, stats: b.stats, edges: g.edges };
  } catch {
    return null;
  }
}

// ---- 星形索引（bipartite）----
function buildStar(blocks, opts = {}) {
  const K1 = typeof opts.maxWordsPerBlock === 'number' ? opts.maxWordsPerBlock : 60;
  const D = typeof opts.maxDf === 'number' ? opts.maxDf : 1000;
  const t0 = Date.now();

  // 1) 词 → 块（倒排），同时得到 df
  const rawPost = new Map();
  for (const b of blocks) {
    for (const k of extractKeys(b.text).keys()) {
      if (!rawPost.has(k)) rawPost.set(k, []);
      rawPost.get(k).push(b.id);
    }
  }

  // 2) 按 df 上限筛连接词 + 算 idf
  const postings = new Map();
  const idfOf = new Map();
  let droppedWords = 0;
  for (const [k, ids] of rawPost) {
    const df = ids.length;
    if (df < 2) continue;              // 只出现一次的词连不出任何边
    if (df > D) { droppedWords++; continue; }
    postings.set(k, ids);
    idfOf.set(k, 1 / Math.log(1 + df));
  }

  // 3) 块 → 词（只保留还能当连接器的词，按 idf 降序取前 K1）
  const blockWords = new Map();
  for (const b of blocks) {
    const ws = [];
    for (const k of extractKeys(b.text).keys()) {
      if (postings.has(k)) ws.push(k);
    }
    ws.sort((a, b2) => idfOf.get(b2) - idfOf.get(a));
    blockWords.set(b.id, ws.slice(0, K1));
  }

  // 4) 块的辅助信息（判方向用）
  const meta = new Map();
  for (const b of blocks) meta.set(b.id, {
    writtenAt: Date.parse(b.writtenAt),
    file: b.file,
    anchor: b.anchor,
    startLine: b.startLine,
    endLine: b.endLine,
    preview: b.preview || String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  });

  return {
    indexVersion: INDEX_VERSION,
    blocks,
    postings,
    idfOf,
    blockWords,
    meta,
    stats: {
      scannedFiles: 0,
      addedBlocks: blocks.length,
      droppedBlocks: 0,
      indexedEdges: [...postings.values()].reduce((a, v) => a + v.length, 0),
      durationMs: Date.now() - t0,
      builtAt: new Date().toISOString(),
      star: { K1, maxDf: Number.isFinite(D) ? D : null, words: postings.size, droppedWords },
    },
  };
}

/** 快速建边：按块累加候选，每块取 top-60；边集用于旧召回算法（保证召回逐条一致）。 */
function buildEdgesFast(blocks) {
  const idf = df => 1 / Math.log(1 + df);
  const keyTo = new Map();
  const keysById = new Map();
  for (const b of blocks) {
    const ks = [...extractKeys(b.text).keys()];
    keysById.set(b.id, ks);
    for (const k of ks) {
      if (!keyTo.has(k)) keyTo.set(k, new Set());
      keyTo.get(k).add(b.id);
    }
  }
  const edgeW = new Map(); // pairKey -> {a,b,w}；pairKey 用块顺序，不使用 id 字典序
  const orderOf = new Map(blocks.map((b, i) => [b.id, i + 1]));
  for (const b of blocks) {
    const cand = new Map();
    for (const k of keysById.get(b.id)) {
      const ids = keyTo.get(k);
      if (!ids || ids.size < 2) continue;
      const w = idf(ids.size);
      for (const id of ids) if (id !== b.id) cand.set(id, (cand.get(id) || 0) + w);
    }
    const top = [...cand.entries()].sort((x, y) => y[1] - x[1]).slice(0, 60);
    for (const [nb, w] of top) {
      const bi = orderOf.get(b.id) ?? 0, ni = orderOf.get(nb) ?? 0;
      const lo = bi < ni ? b.id : nb, hi = bi < ni ? nb : b.id;
      const pairKey = Math.min(bi, ni) + '|' + Math.max(bi, ni);
      const prev = edgeW.get(pairKey);
      if (!prev || w > prev.w) edgeW.set(pairKey, { a: lo, b: hi, w });
    }
  }
  const byId = new Map(blocks.map(b => [b.id, b]));
  const edges = [];
  for (const { a, b, w } of edgeW.values()) {
    const ba = byId.get(a), bb = byId.get(b);
    if (!ba || !bb) continue;
    const ta = Date.parse(ba.writtenAt), tb = Date.parse(bb.writtenAt);
    edges.push({ from: ta <= tb ? a : b, to: ta <= tb ? b : a, weight: +w.toFixed(6) });
  }
  return edges;
}

function buildStarIndex(partnerDir, opts = {}) {
  const t0 = Date.now();
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : ['.md'])
    .map(e => String(e).toLowerCase().replace(/^\*?\.?/, '.'));
  const excludeDirs = new Set((opts.excludeDirs && opts.excludeDirs.length ? opts.excludeDirs : ['handoffs', 'blobs', 'tools', 'dialogs', 'raw-log']).map(d => String(d).toLowerCase()));
  const recurse = opts.includeSubdirs !== false;

  const files = [];
  (function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!recurse) continue; if (excludeDirs.has(ent.name.toLowerCase())) continue; walk(p); }
      else if (ent.isFile()) { const low = ent.name.toLowerCase(); if (exts.some(e => low.endsWith(e))) files.push(p); }
    }
  })(partnerDir);

  const { blocks, manifest, scannedFiles, dropped } = collectBlocks(partnerDir, files);
  const idx = buildStar(blocks, opts);
  idx.edges = buildEdgesFast(blocks);              // ★ 精确召回用：与旧 buildGraph 同语义的 top-60 边集
  idx.vocab = buildTierVocab(blocks);              // ★ 三档判定用词表：构建时落盘，读回直接用
  idx.stats.indexedEdges = idx.edges.length;
  idx.manifest = manifest;
  idx.stats.scannedFiles = scannedFiles;
  idx.stats.droppedBlocks = dropped;
  idx.stats.durationMs = Date.now() - t0;
  return idx;
}

function starRecall(index, query, opts = {}) {
  const k = opts.k || 5;
  const LAMBDA = opts.lambda ?? 0.6;
  const HOPS = opts.hops ?? 3;
  const REVERSE_FLOOR = opts.reverseFloor ?? 0.4;

  const qKeys = extractKeys(query);
  if (qKeys.size === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };

  const byId = new Map(index.blocks.map(b => [b.id, b]));
  const score = new Map();
  const why = new Map();
  const coverageOf = new Map();

  const qClean = query.replace(/[\s\p{P}]/gu, '').toLowerCase();
  if (qClean.length === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };
  const qLen = qClean.length;
  const qTokens = [...qKeys.keys()].filter(x => x.length >= 2);

  // 起点识别（与旧版逐字一致）
  for (const b of index.blocks) {
    const lower = _searchFace(b);   // ★ 检索面：文件名 + 小节标题 + 正文
    const covered = new Array(qLen).fill(false);
    let matchedToken = '';
    for (const kk of qTokens) {
      let from = 0;
      while (true) {
        const idx2 = qClean.indexOf(kk, from);
        if (idx2 < 0) break;
        if (lower.includes(kk)) {
          for (let x = idx2; x < idx2 + kk.length; x++) covered[x] = true;
          if (kk.length > matchedToken.length) matchedToken = kk;
        }
        from = idx2 + 1;
      }
    }
    const cov = covered.filter(Boolean).length / qLen;
    if (cov <= 0) continue;
    if (matchedToken.length < 2) continue;
    if (/^[a-z0-9]+$/i.test(qClean) && !lower.includes(qClean)) continue;
    score.set(b.id, cov);
    why.set(b.id, matchedToken);
    coverageOf.set(b.id, cov);
  }
  if (score.size === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };

  const via = new Map();
  for (const id of score.keys()) via.set(id, { fromId: null, hop: 0, word: null });

  let frontier = new Map(score);
  for (let hop = 1; hop <= HOPS; hop++) {
    const next = new Map();
    const nextVia = new Map();
    for (const [node, s] of frontier) {
      const words = index.blockWords.get(node) || [];
      // 先聚合：目标块 -> Σ idf(共享词)，同时记住 idf 最高的那个词（用于 why）
      const agg = new Map();
      const bestWord = new Map();
      for (const w of words) {
        const ids = index.postings.get(w);
        if (!ids) continue;
        const wgt = index.idfOf.get(w) || 0;
        for (const other of ids) {
          if (other === node) continue;
          agg.set(other, (agg.get(other) || 0) + wgt);
          const prev = bestWord.get(other);
          if (prev === undefined || wgt > (index.idfOf.get(prev) || 0)) bestWord.set(other, w);
        }
      }
      const tNode = index.meta.get(node)?.writtenAt ?? 0;
      // ★ 与旧版一致：每块只保留 top-60 邻居（旧 buildGraph 的 K_NEIGHBORS=60）
      const topAgg = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
      for (const [target, wsum] of topAgg) {
        const tTarget = index.meta.get(target)?.writtenAt ?? 0;
        const forward = tNode <= tTarget;
        const val = s * wsum * LAMBDA * (forward ? 1 : REVERSE_FLOOR);
        if (val > (next.get(target) || 0)) {
          next.set(target, val);
          nextVia.set(target, { fromId: node, hop, word: bestWord.get(target) });
        }
      }
    }
    for (const [n, s] of next) {
      if (!score.has(n) || score.get(n) < s) {
        if (!score.has(n)) score.set(n, 0);
        score.set(n, score.get(n) + s * (hop === 1 ? 1 : 0.5));
        if (!via.has(n) || via.get(n).hop === 0) {
          const v = nextVia.get(n);
          if (v) via.set(n, v);
        }
      }
    }
    frontier = next;
  }

  const ranked = [...score.entries()]
    .map(([id, s]) => ({ b: byId.get(id), s, cov: coverageOf.get(id) || 0 }))
    .filter(x => x.b)
    .sort((x, y) => (y.cov > 0 ? 1 : 0) - (x.cov > 0 ? 1 : 0) || y.cov - x.cov || y.s - x.s);

  const snippetAround = _snippetAround;   // ★ 统一 helper
  const missedSnippets = new Set();

  const items = [];
  const sectionMap = new Map();
  for (const { b, s, cov } of ranked) {
    if (sectionMap.size >= k) break;
    const v = via.get(b.id);
    if (cov > 0) {
      const word = why.get(b.id);
      const snip = snippetAround(_searchFace(b), word);
      if (!_snippetHas(snip, word)) { missedSnippets.add(b.file); continue; }
      const item = {
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: snip, why: word,
        score: +Math.min(1, cov).toFixed(3),
        ...(isStaleText(b.text) ? { stale: true } : {}),
      };
      addSectionItem(sectionMap, items, item, b);
    } else if (v && v.fromId != null && byId.get(v.fromId)) {
      const src = byId.get(v.fromId);
      const share = (why.get(v.fromId) || '').replace(/^\(.*\)$/, '');
      const snip = snippetAround(_searchFace(b), share);
      if (!_snippetHas(snip, share)) { missedSnippets.add(b.file); continue; }
      const item = {
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: snip,
        why: `经「${src.anchor}」关联（共享「${share}」）`,
        score: +(Math.min(1, cov) * 0.5).toFixed(3),
      };
      addSectionItem(sectionMap, items, item, b);
    }
  }

  let bestCov = 0;
  for (const c of coverageOf.values()) if (c > bestCov) bestCov = c;
  if (missedSnippets.size) {
    for (const f of missedSnippets) console.error('[memo] snippet-miss: ' + f);
  }
  let confidence;
  if (bestCov >= 0.8) confidence = 'high';
  else if (bestCov >= 0.45) confidence = 'mid';
  else confidence = 'low';
  if (items.length === 0 || bestCov < 0.45) confidence = 'low';

  const text = confidence === 'low' ? '想不起，翻下本子'
    : (confidence === 'high' ? '这里可能相关：' : '可能相关，要细看我可以翻：');
  return { confidence, text, items: confidence === 'low' ? [] : items };
}

// ---- 星形索引落盘 / 读回（v2，副本实验）----
// 定性：索引只是缓存，真相源永远是工作区的 .md。任何校验失败 → 回退重建，绝不报错退出。
// 开关：默认关；只有显式 opts.useStarIndex === true 才读星形，否则走旧路径。
const STAR_VERSION = 2;
const STAR_INDEX_ENABLED_DEFAULT = false;
const STAR_MANIFEST_MAX_FILES = 2000;
function isStarIndexEnabled(opts = {}) { return opts.useStarIndex === true; }

function _walkNotebookFiles(partnerDir, opts = {}) {
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : ['.md'])
    .map(e => String(e).toLowerCase().replace(/^\*?\.?/, '.'));
  const excludeDirs = new Set((opts.excludeDirs && opts.excludeDirs.length ? opts.excludeDirs : ['handoffs', 'blobs', 'tools', 'dialogs', 'raw-log'])
    .map(d => String(d).toLowerCase()));
  const recurse = opts.includeSubdirs !== false;
  const files = [];
  (function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!recurse) continue; if (excludeDirs.has(ent.name.toLowerCase())) continue; walk(p); }
      else if (ent.isFile()) { const low = ent.name.toLowerCase(); if (exts.some(e => low.endsWith(e))) files.push(p); }
    }
  })(partnerDir);
  return files;
}

/** 本子目录清单：top-N 文件的 路径+mtime+size 哈希。 */
function computeManifest(partnerDir, opts = {}) {
  const maxFiles = typeof opts.maxFiles === 'number' ? opts.maxFiles : STAR_MANIFEST_MAX_FILES;
  const abs = _walkNotebookFiles(partnerDir, opts);
  const all = abs.map(p => {
    const st = fs.statSync(p);
    return { file: path.relative(partnerDir, p).replace(/\\/g, '/'), mtimeMs: st.mtimeMs, size: st.size };
  });
  all.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const files = all.slice(0, maxFiles);
  files.sort((a, b) => a.file.localeCompare(b.file));
  const lines = files.map(f => `${f.file}\u0000${f.mtimeMs}\u0000${f.size}`);
  const hash = crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
  return { hash, count: files.length, totalFiles: all.length, truncated: all.length > maxFiles, files };
}

function _diffManifest(storedFiles, currentFiles) {
  const before = new Map((storedFiles || []).map(f => [f.file, f]));
  const after = new Map((currentFiles || []).map(f => [f.file, f]));
  const changed = [];
  for (const [file, a] of after) {
    const b = before.get(file);
    if (!b || b.mtimeMs !== a.mtimeMs || b.size !== a.size) changed.push({ file, before: b || null, after: a });
  }
  for (const [file, b] of before) if (!after.has(file)) changed.push({ file, before: b, after: null, removed: true });
  return changed;
}

/** 代际计数：索引与向量库共用同一个计数，不许各算各的。 */
function readGeneration(indexDir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(indexDir, 'generation.json'), 'utf8'));
    return Number.isFinite(p.generation) ? p.generation : null;
  } catch { return null; }
}

/** 写盘时 +1：返回新的代际号。 */
function bumpGeneration(indexDir) {
  const cur = readGeneration(indexDir);
  const next = (cur == null ? 0 : cur) + 1;
  const file = path.join(indexDir, 'generation.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ generation: next, updatedAt: new Date().toISOString() }), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

function saveStarIndex(indexDir, index, opts = {}) {
  _lastIndexDir = indexDir;
  const dir = path.join(indexDir, 'star');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = opts.partnerDir ? computeManifest(opts.partnerDir, opts) : (index.manifest || null);
  const edges = Array.isArray(index.edges) ? index.edges.length : [...index.postings.values()].reduce((a, v) => a + v.length, 0);
  const { lastIndexedAt: _legacyLastIndexedAt, ...restStats } = index.stats || {};
  const builtAt = index.stats?.builtAt ?? index.stats?.lastIndexedAt ?? new Date().toISOString();
  const savedAt = new Date().toISOString();
  // ★ 代际：内容没变就沿用旧号，变了才 +1（索引与向量共用同一计数）
  let oldManifest = null;
  let oldGeneration = null;
  try {
    const oldRaw = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    oldManifest = oldRaw.manifest || null;
    oldGeneration = Number.isFinite(oldRaw.generation) ? oldRaw.generation : null;
  } catch { /* 盘上没有旧索引 → 照 +1 */ }
  const sameManifest = !!oldManifest && !!manifest && oldManifest.hash === manifest.hash;
  const generation = (sameManifest && oldGeneration != null) ? oldGeneration : bumpGeneration(indexDir);
  const payload = {
    indexVersion: STAR_VERSION,
    savedAt,
    generation,
    manifest,
    stats: { ...restStats, builtAt, addedBlocks: index.blocks.length, indexedEdges: edges },
    blocks: index.blocks,
    edges: index.edges || null,
    vocab: Array.isArray(index.vocab) ? index.vocab : null,
    // 有 edges 时不再重复存 postings/blockWords（召回走旧算法，体积约减）；meta 保留，
    // 让每个块在落盘索引里仍有 file/anchor/preview，id 变了也能人工对上。
    postings: index.edges ? {} : Object.fromEntries(index.postings),
    idfOf: index.edges ? {} : Object.fromEntries(index.idfOf),
    blockWords: index.edges ? {} : Object.fromEntries(index.blockWords),
    meta: Object.fromEntries(index.meta || []),
  };
  const file = path.join(dir, 'index.json');
  const tmp = file + '.tmp-' + process.pid;
  const json = JSON.stringify(payload);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, file);                     // 先 tmp 再 rename，崩了不会留半个文件
  index.savedAt = savedAt;                      // ★ 写回内存对象：后台补齐后 recall 的 savedAt 不再是 null
  index.generation = generation;                // ★ 写回内存对象：代际跟着落盘那一份

  // ★ 落盘后自愈：索引代际被推高、向量还落后 → 立刻起一次后台补齐（不等第一次 recall 踩响）
  //    旁路：fire-and-forget，不阻塞、不重试、不抛——起不来也必须让 saveStarIndex 正常返回
  try {
    const p = _vecPaths();
    let gvDisk = null;
    try {
      const m = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
      gvDisk = Number.isFinite(m.generation) ? m.generation : null;
    } catch { gvDisk = null; }
    if (gvDisk == null || gvDisk !== generation) {
      console.error(`[memo] auto-catchup fired: index=${generation} vectors=${gvDisk ?? 'missing'}`);
      _scheduleAutoCatchup(indexDir, generation);
    }
  } catch { /* 旁路：补跑的任何异常都不能影响落盘 */ }

  return { file, bytes: Buffer.byteLength(json), savedAt, builtAt, generation, blocks: index.blocks.length, edges, manifest };
}

function loadStarIndex(indexDir, opts = {}) {
  _lastIndexDir = indexDir;
  if (!isStarIndexEnabled(opts)) return { ok: false, reason: 'disabled', action: 'legacy' };
  const file = path.join(indexDir, 'star', 'index.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing', action: 'rebuild-full', file };
  const t0 = Date.now();
  const raw = fs.readFileSync(file, 'utf8');
  const readMs = Date.now() - t0;
  let p;
  try { p = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'parse-error', action: 'rebuild-full', error: String(e.message || e) }; }
  const parseMs = Date.now() - t0 - readMs;
  if (p.indexVersion !== STAR_VERSION) {
    return { ok: false, reason: 'version-mismatch', action: 'rebuild-full', got: p.indexVersion, want: STAR_VERSION };
  }
  const t1 = Date.now();
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const edges = Array.isArray(p.edges) ? p.edges : null;
  const vocab = Array.isArray(p.vocab) ? p.vocab : null;
  const postings = new Map(Object.entries(p.postings || {}));
  const idfOf = new Map(Object.entries(p.idfOf || {}));
  // blockWords / meta 的键是块 id（数字）：JSON 会把键变字符串，读回必须还原成数字，否则 get(number) 全部 miss
  const numKey = k => (/^\d+$/.test(k) ? Number(k) : k);
  const blockWords = new Map(Object.entries(p.blockWords || {}).map(([k, v]) => [numKey(k), v]));
  const meta = new Map(Object.entries(p.meta || {}).map(([k, v]) => [numKey(k), v]));
  const structMs = Date.now() - t1;
  const stats = { ...(p.stats || {}) };
  const savedAt = p.savedAt ?? p.indexedAt ?? null;              // 向后兼容：旧文件只有 indexedAt
  stats.builtAt = stats.builtAt ?? stats.lastIndexedAt ?? savedAt ?? null; // 旧 stats.lastIndexedAt → builtAt
  delete stats.lastIndexedAt;
  const savedBlocks = Number(stats.addedBlocks ?? NaN);
  const savedEdges = Number(stats.indexedEdges ?? NaN);
  let edgeCount = 0;
  if (edges) edgeCount = edges.length;
  else for (const v of postings.values()) edgeCount += Array.isArray(v) ? v.length : 0;
  const blockDelta = blocks.length - savedBlocks;
  const edgeDelta = edgeCount - savedEdges;
  // ① 数量对不上 → 整个丢弃重建
  if (!Number.isFinite(savedBlocks) || !Number.isFinite(savedEdges) || blockDelta !== 0 || edgeDelta !== 0) {
    return {
      ok: false, reason: 'count-mismatch', action: 'rebuild-full', blockDelta, edgeDelta,
      savedBlocks, savedEdges, actualBlocks: blocks.length, actualEdges: edgeCount,
      timings: { readMs, parseMs, structMs }, file,
    };
  }
  // ② 清单哈希对不上 → 只重算变了的文件（增量）
  if (opts.partnerDir) {
    const cur = computeManifest(opts.partnerDir, opts);
    if (!p.manifest || p.manifest.hash !== cur.hash) {
      const changed = _diffManifest(p.manifest && p.manifest.files, cur.files);
      return {
        ok: false, reason: 'manifest-mismatch', action: 'rebuild-incremental',
        changedFiles: changed, storedHash: p.manifest && p.manifest.hash, currentHash: cur.hash,
        timings: { readMs, parseMs, structMs }, file,
      };
    }
  }
  const generation = Number.isFinite(p.generation) ? p.generation : null;   // 老索引没有这个字段 → null（当不匹配，不当 0）
  return {
    ok: true,
    index: { indexVersion: p.indexVersion, blocks, edges, vocab, postings, idfOf, blockWords, meta, manifest: p.manifest || null, savedAt, generation, stats, __indexDir: indexDir },
    timings: { readMs, parseMs, structMs, totalMs: readMs + parseMs + structMs },
    savedAt, builtAt: stats.builtAt, generation, file, bytes: Buffer.byteLength(raw),
  };
}

/** 增量重建：只重算 changedFiles（改过/新增），删除的文件直接丢块，其余原样复用。 */
function rebuildChangedFiles(partnerDir, baseIndex, changedFiles, opts = {}) {
  const t0 = Date.now();
  const changed = new Map(changedFiles.map(f => [f.file, f]));
  const kept = baseIndex.blocks.filter(b => !changed.has(b.file));
  const newBlocks = kept.slice();
  for (const [rel] of changed) {
    const abs = path.resolve(partnerDir, rel);
    if (!fs.existsSync(abs)) continue;            // 已删除
    const { blocks } = collectBlocks(partnerDir, [abs]);
    newBlocks.push(...blocks);
  }
  // ★ 按全量构建时的文件遍历顺序 + 行号排序，确保块顺序与 buildStarIndex 一致（否则 top-60 平局会差几条边）
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : ['.md'])
    .map(e => String(e).toLowerCase().replace(/^\*?\.?/, '.'));
  const excludeDirs = new Set((opts.excludeDirs && opts.excludeDirs.length ? opts.excludeDirs : ['handoffs', 'blobs', 'tools', 'dialogs', 'raw-log'])
    .map(d => String(d).toLowerCase()));
  const fileOrder = new Map();
  let oi = 0;
  (function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!excludeDirs.has(ent.name.toLowerCase())) walk(p); }
      else if (ent.isFile()) {
        const low = ent.name.toLowerCase();
        if (exts.some(e => low.endsWith(e))) fileOrder.set(path.relative(partnerDir, p).replace(/\\/g, '/'), oi++);
      }
    }
  })(partnerDir);
  newBlocks.sort((a, b) => (fileOrder.get(a.file) ?? 1e9) - (fileOrder.get(b.file) ?? 1e9) || a.startLine - b.startLine);
  const renumbered = newBlocks.map((b, i) => ({ ...b, id: i + 1 }));
  const idx = buildStar(renumbered, opts);
  idx.edges = buildEdgesFast(renumbered);
  idx.vocab = buildTierVocab(renumbered);
  idx.stats = {
    ...idx.stats,
    addedBlocks: renumbered.length,
    droppedBlocks: 0,
    indexedEdges: idx.edges.length,
    durationMs: Date.now() - t0,
    builtAt: new Date().toISOString(),
  };
  return idx;
}

/** 旧索引是否可用：blocks.json + graph.json 都能 parse 且 blocks 非空。 */
function hasLegacyIndex(indexDir) {
  try {
    const bf = path.join(indexDir, 'blocks.json');
    const gf = path.join(indexDir, 'graph.json');
    if (!fs.existsSync(bf) || !fs.existsSync(gf)) return { ok: false, reason: 'missing' };
    const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    const g = JSON.parse(fs.readFileSync(gf, 'utf8'));
    if (!Array.isArray(b.blocks) || b.blocks.length === 0) return { ok: false, reason: 'empty-blocks' };
    if (!Array.isArray(g.edges)) return { ok: false, reason: 'bad-edges' };
    return { ok: true, blocks: b.blocks.length, edges: g.edges.length, blocksFile: bf, graphFile: gf };
  } catch (e) {
    return { ok: false, reason: 'parse-error', error: String(e.message || e) };
  }
}

/**
 * 对外唯一入口：永远不抛错、永远不返回空索引。
 * 调用链：开关关 → legacy（一个字节不多走）
 *        开关开 → 星形读回失败 → 旧 blocks/graph 可用则 legacy-fallback（①）
 *                              → 旧索引也不可用才 rebuild-full（②，从 .md 重建并落盘）
 */
function openStarIndex(indexDir, partnerDir, opts = {}) {
  if (!isStarIndexEnabled(opts)) return { mode: 'legacy' };
  const r = loadStarIndex(indexDir, { ...opts, partnerDir });
  if (r.ok) return { mode: 'star', index: r.index, timings: r.timings, savedAt: r.savedAt, builtAt: r.builtAt, generation: r.generation, file: r.file, bytes: r.bytes };
  // 清单哈希变了：正常刷新，走增量（只重算 mtime 变了的文件）；增量失败由调用方回退旧索引
  if (r.reason === 'manifest-mismatch') {
    return { mode: 'rebuild-incremental', reason: r.reason, action: 'rebuild-changed-files', changedFiles: r.changedFiles, legacy: hasLegacyIndex(indexDir), timings: r.timings };
  }
  // 数量/版本/解析失败：先回退旧 blocks/graph（①）；旧索引不可用才从 .md 重建（②）
  const legacy = hasLegacyIndex(indexDir);
  if (legacy.ok) {
    return {
      mode: 'legacy-fallback', reason: r.reason, action: 'use-legacy-index',
      blockDelta: r.blockDelta, edgeDelta: r.edgeDelta, legacy, timings: r.timings,
    };
  }
  return { mode: 'rebuild-full', reason: r.reason, action: 'rebuild-from-md', legacyReason: legacy.reason, blockDelta: r.blockDelta, edgeDelta: r.edgeDelta, timings: r.timings };
}

// ---- 星形召回入口（旧索引/星形索引分流）----
const INDEX_VERSION = 2;
function baseRecall(index, query, opts = {}) {
  // ★ 精确召回：星形索引里存了与旧版同语义的 edge 集，有 edges 就走旧算法（逐条一致）
  if (index && Array.isArray(index.edges) && index.edges.length > 0) return legacyRecall(index, query, opts);
  if (index && index.indexVersion === 2 && index.postings instanceof Map) return starRecall(index, query, opts);
  return legacyRecall(index, query, opts);
}

// ---- 三档判定（只加“怎么说”，不改检索/排序/结果）----
const TIER_SPLIT = /(?:要不要|是不是|的|了|吗|呢|和|与|跟|及|或|[\s，。！？、,.!?；;：:"'“”‘’()（）\[\]【】])/;
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

function queryContentWords(query) {
  return String(query || '').split(TIER_SPLIT).map(s => s.trim()).filter(s => s.length >= 2);
}
function _segments(text) {
  const out = [];
  for (const s of SEGMENTER.segment(text)) out.push({ start: s.index, end: s.index + s.segment.length, word: s.isWordLike });
  return out;
}
function _boundariesOf(b) {
  if (!b.__segBounds) {
    const set = new Set();
    for (const s of _segments(b.text)) if (s.word) { set.add(s.start); set.add(s.end); }
    b.__segBounds = set;
  }
  return b.__segBounds;
}
/** 独立片段：word 在 text 里的某次出现，起点和终点都落在分词边界上。 */
function isIndependentPhrase(text, word) {
  if (!text || !word || word.length < 2) return false;
  const bounds = _boundariesOf({ text, __segBounds: null });
  let from = 0;
  while (true) {
    const i = text.indexOf(word, from);
    if (i < 0) return false;
    if (bounds.has(i) && bounds.has(i + word.length)) return true;
    from = i + 1;
  }
}
function whyIsComplete(why, text) {
  if (!isIndependentPhrase(text, why)) return false;
  return !['和', '与', '跟', '及', '或', '的', '了', '吗', '呢', '是', '不'].some(b => why.includes(b));
}
function _lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/** 构建期词表：只收分词器认定的“词”，天然排除跨词碎片。 */
function buildTierVocab(blocks) {
  const set = new Set();
  for (const b of blocks) {
    for (const s of SEGMENTER.segment(b.text)) {
      if (!s.isWordLike) continue;
      const w = String(s.segment).trim();
      if (w && w.length <= 20) set.add(w);
    }
  }
  return [...set];
}
function _tierVocab(index) {
  if (!index.__tierVocab) {
    const list = Array.isArray(index.vocab) ? index.vocab : buildTierVocab(index.blocks);
    const set = new Set(list);
    const chars = new Map();
    for (const k of set) for (const ch of new Set(k)) {
      if (!chars.has(ch)) chars.set(ch, new Set());
      chars.get(ch).add(k);
    }
    index.__tierVocab = set;
    index.__tierCharMap = chars;
  }
  return index.__tierVocab;
}
function closestWords(index, qWords, limit = 3) {
  const vocab = _tierVocab(index);
  const charMap = index.__tierCharMap || new Map();
  const qChars = new Set();
  for (const w of qWords) for (const ch of w) qChars.add(ch);
  const cand = new Map();
  for (const w of qWords) {
    const pool = new Set();
    for (const ch of w) { const set = charMap.get(ch); if (set) for (const k of set) pool.add(k); }
    for (const k of pool) {
      if (k.length < 2) continue;
      if (![...k].some(ch => qChars.has(ch))) continue;
      let score = 9;
      if (k === w) score = 0;
      else if (k.startsWith(w) || w.startsWith(k)) score = 0.5 + Math.abs(k.length - w.length) * 0.1;
      else score = _lev(k, w);
      if (score <= Math.max(2, w.length)) {
        const prev = cand.get(k);
        if (prev === undefined || score < prev) cand.set(k, score);
      }
    }
  }
  return [...cand.entries()]
    .filter(([k]) => [...k].some(ch => qChars.has(ch)))
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .slice(0, limit).map(x => x[0]);
}
function _blockAt(index, file, startLine) {
  if (!index.__tierLoc) {
    const m = new Map();
    for (const b of index.blocks) m.set(`${b.file}:${b.startLine}`, b);
    index.__tierLoc = m;
  }
  return index.__tierLoc.get(`${file}:${startLine}`) || null;
}
function classifyTier(index, query, result) {
  const items = result.items || [];
  const qWords = queryContentWords(query);
  if (!items.length) {
    const list = closestWords(index, qWords);
    const extras = [];
    // 短查询词（2 字）补一个末字候选（如「冷库」→「库」）；长词不拆字
    for (const w of qWords) {
      if (w.length > 2) continue;
      const ch = w[w.length - 1];
      if (!list.includes(ch) && !extras.includes(ch) && index.blocks.some(b => b.text.includes(ch))) extras.push(ch);
    }
    return { tier: 'miss', closest: [...extras, ...list].slice(0, 3) };
  }
  const top = items[0];
  const b = _blockAt(index, top.file, top.startLine);
  const text = b ? b.text : (top.snippet || '');
  const hitWords = qWords.filter(w => text.includes(w));
  const complete = whyIsComplete(top.why, text);
  if (hitWords.length > 0 && complete) return { tier: 'hit' };
  if (top.why && !complete) return { tier: 'weak', reason: 'W1' };
  if (hitWords.length === 0) return { tier: 'weak', reason: 'W2' };
  return { tier: 'hit' };
}
function _legacyPath(index, query, opts) {
  const r = baseRecall(index, query, opts);
  const t = classifyTier(index, query, r);
  return { ...r, ...t };
}

// ---- 向量路（开关 MEMO_RETRIEVAL=vector；默认 legacy）----
const MEMO_KEY_FILE_DEFAULT = 'C:/Users/xu/Coopanion/data/home/companion/workspace/partner/vendor/siliconflow.key.txt';
const MEMO_VECTORS_DIR_DEFAULT = 'C:/Users/xu/Documents/deepseek-harness/default-workspace/_star';
let _vecCache = null;
let _vectorCatchUpRunning = false;   // ★ 后台补齐单飞：同一进程同时只允许一个在跑
let _vectorCatchUpPromise = null;    // ★ 本进程补跑完成的信号（waitForVectorGeneration 用）
let _gvStat = null;                  // ★ 轮询时缓存 meta 的 mtime/size，避免每 300ms 都解析 9MB
let _autoCatchupTimer = null;        // ★ saveStarIndex 之后的 debounce 定时器
let _autoCatchupPending = null;      // ★ 攒着的最后一次落盘（不丢）
let _lastIndexDir = null;            // ★ 最近一次落盘/读盘的索引目录（供后台补齐推路径用）

function _vecPaths() {
  const dir = (process.env.MEMO_VECTORS_DIR || MEMO_VECTORS_DIR_DEFAULT).replace(/[\\/]+$/, '');
  return {
    keyFile: process.env.MEMO_KEY_FILE || MEMO_KEY_FILE_DEFAULT,
    vec: dir + '/vectors.int8',
    meta: dir + '/vectors.meta.json',
  };
}

function _loadVectors() {
  const p = _vecPaths();
  if (_vecCache && _vecCache.vec === p.vec && _vecCache.meta === p.meta) return _vecCache;
  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  const buf = fs.readFileSync(p.vec);
  _vecCache = { vec: p.vec, meta: p.meta, buf, entries: meta.entries, dim: meta.dim, generation: Number.isFinite(meta.generation) ? meta.generation : null };
  return _vecCache;
}

function _embedQuerySync(query) {
  const { execFileSync } = require('node:child_process');
  const p = _vecPaths();
  const keyText = fs.readFileSync(p.keyFile, 'utf8');
  const key = (keyText.match(/sk-[A-Za-z0-9_-]{20,}/) || [])[0];
  if (!key) throw new Error('key not found');
  const base = (keyText.match(/https:\/\/[^\s]+/) || ['https://api.siliconflow.cn/v1'])[0].replace(/\/$/, '');
  const body = JSON.stringify({ model: 'BAAI/bge-m3', input: [query], encoding_format: 'float' });
  const out = execFileSync('curl.exe', [
    '-sS', '--max-time', '1.8', '-X', 'POST', base + '/embeddings',
    '-H', 'Authorization: Bearer ' + key,
    '-H', 'Content-Type: application/json',
    '--data-binary', '@-',
  ], { input: body, timeout: 2000, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const j = JSON.parse(out);
  const v = j && j.data && j.data[0] && j.data[0].embedding;
  if (!Array.isArray(v)) throw new Error('bad embedding response');
  return v;
}

/**
 * 围绕命中词截取原文片段。三条路（legacy / star / vector）共用。
 * 找不到命中词时从块开头截，但调用方必须按 _snippetHas 判定并标 `snippetFromStart`。
 */
function _snippetAround(text, word, span = 120) {
  const w = (word || '').replace(/^\(.*\)$/, '');
  let at = w ? String(text).toLowerCase().indexOf(w.toLowerCase()) : -1;
  if (at < 0) at = 0;
  const half = Math.floor(span / 2);
  let start = Math.max(0, at - half);
  let s = String(text).slice(start, start + span);
  if (start > 0) s = '…' + s;
  if (start + span < String(text).length) s = s + '…';
  return s.replace(/\n/g, ' ');
}

/** 片段里是否真的含这个词（小写比较，去省略号）。 */
function _snippetHas(snippet, word) {
  if (!word) return false;
  return String(snippet).toLowerCase().replace(/…/g, '').includes(String(word).toLowerCase());
}

/**
 * 在 query 切出来的 keys 里，挑 text 真含的、最长的那个当「命中词」。
 * 一个都不含 → 返回 null（表示只是向量近 / 传播近，没有字面命中）。
 */
function _hitWordOf(text, keys) {
  const low = String(text).toLowerCase();
  let best = null;
  for (const k of keys) {
    if (k.length < 2) continue;
    if (low.includes(String(k).toLowerCase()) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

/** 检索面：文件名 + 小节标题(anchor) + 正文。标题层要能被搜到，三个面都得带上。 */
function _searchFace(b) {
  return (b.file + ' ' + (b.anchor || '') + ' ' + (b.text || '')).toLowerCase();
}

function isStaleText(text) {
  return /⛔\s*已推翻|已作废/.test(String(text || ''));
}

function _snippetOf(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function _vecLookup(index) {
  if (index.__vecLookup) return index.__vecLookup;
  const crypto = require('node:crypto');
  const m = new Map();
  for (const b of index.blocks) {
    const h = crypto.createHash('sha1').update(String(b.text || '')).digest('hex');
    const k = b.file + '\u0000' + h;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  index.__vecLookup = m;
  return m;
}

const idsOf = (s) => new Set(String(s || '').match(/\d{6,}/g) || []);

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function lineGap(a, b) {
  const a1 = Number(a.startLine) || 0;
  const a2 = Number(a.endLine) || a1;
  const b1 = Number(b.startLine) || 0;
  const b2 = Number(b.endLine) || b1;
  if (a2 < b1) return b1 - a2;
  if (b2 < a1) return a1 - b2;
  return 0;
}

function hasCommon(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function sameSection(a, b) {
  if (a.file !== b.file) return false;
  if ((a.anchor || '') !== (b.anchor || '')) return false;
  if (lineGap(a, b) > 120) return false;
  const idA = idsOf(a.text), idB = idsOf(b.text);
  if (idA.size && idB.size && !hasCommon(idA, idB)) return false;  // ← 这条是硬验收的命门
  const na = normText(a.text), nb = normText(b.text);
  if (!na || !nb) return (a.anchor || '').trim().length >= 6;
  const [s, l] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (l.includes(s) && s.length / l.length > 0.6) return true;
  if (jaccard(bigrams(na), bigrams(nb)) > 0.75) return true;
  // 长事件标题的同一小节，可能被切成若干互不重叠的段落；按同节归并。
  // 短标题（如 PARTNER.md「号」）不靠这条硬压，避免丢并列事实。
  return (a.anchor || '').trim().length >= 6;
}

function sectionKeyOf(b) {
  return b.file + '\u0000' + (b.anchor || String(b.startLine));
}

function addSectionItem(sectionMap, items, item, block) {
  const key = sectionKeyOf(block);
  const list = sectionMap.get(key);
  if (!list) {
    sectionMap.set(key, [{ item, block }]);
    items.push(item);
    return;
  }
  for (const prev of list) {
    if (sameSection(prev.block, block)) {
      prev.item.startLine = Math.min(prev.item.startLine, item.startLine);
      prev.item.endLine = Math.max(prev.item.endLine, item.endLine);
      prev.item.score = Math.max(prev.item.score, item.score);
      return;
    }
  }
  // 同 key 但内容确认是并列事实（如 PARTNER.md「号」两行）时保留两条。
  list.push({ item, block });
  items.push(item);
}

/** 代际快筛：不一致 → 打日志 + 后台 fire-and-forget 补 + 这一句直接抛（recall 退 legacy）。不等待、不重跑。 */
function _ensureVectorGeneration(index) {
  // ① 便宜的路：先看缓存，相等就立刻返回（不做任何磁盘 I/O）
  let v = _loadVectors();
  const gi = Number.isFinite(index.generation) ? index.generation : null;
  let gv = Number.isFinite(v.generation) ? v.generation : null;
  if (gi != null && gv != null && gi === gv) return v;

  // ② 只有上面判了不等，才绕开 _vecCache 重读一次磁盘真代际（9MB，只在兜底路上付）
  try {
    const p = _vecPaths();
    const diskMeta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
    const gvDisk = Number.isFinite(diskMeta.generation) ? diskMeta.generation : null;
    if (gi != null && gvDisk != null && gi === gvDisk) {
      _vecCache = null;
      v = _loadVectors();            // 刷新缓存
      gv = gvDisk;
      return v;                      // 追上就放行，不降级
    }
    if (gvDisk != null) gv = gvDisk; // 仍不等：日志里报磁盘真值
  } catch { /* 读不到磁盘就沿用缓存值 */ }

  // ③ 仍不等 → 原来的日志 + catch-up + throw，语义不变
  console.error(`[memo] stale-generation: index=${gi ?? 'missing'} vectors=${gv ?? 'missing'}`);
  _startVectorCatchUp(index.__indexDir, gi);
  throw new Error('stale-generation');
}

/** 自动补跑 debounce：把连续多次落盘攒成一次；不丢最后一次（跑完检查是否又落后 → 重新排）。 */
function _autoCatchupDebounceMs() {
  const v = Number(process.env.MEMO_AUTO_CATCHUP_DEBOUNCE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}
function _scheduleAutoCatchup(indexDir, generation) {
  try {
    _autoCatchupPending = { indexDir, generation };
    if (_autoCatchupTimer) return;          // 已排着：只更新"最后一次"的代际
    const delay = _autoCatchupDebounceMs();
    if (delay <= 0) {                        // 0 = 立即（旧行为）
      const job = _autoCatchupPending; _autoCatchupPending = null; _runAutoCatchup(job); return;
    }
    const t = setTimeout(() => { _autoCatchupTimer = null; const job = _autoCatchupPending; _autoCatchupPending = null; if (job) _runAutoCatchup(job); }, delay);
    if (typeof t.unref === 'function') t.unref();
    _autoCatchupTimer = t;
  } catch { /* 旁路 */ }
}
function _runAutoCatchup(job) {
  try {
    if (!job) return;
    console.error(`[memo] auto-catchup run: index=${job.generation}`);
    const p = _startVectorCatchUp(job.indexDir, job.generation);
    const check = () => {
      try {
        const pth = _vecPaths();
        const m = JSON.parse(fs.readFileSync(pth.meta, 'utf8'));
        const gv = Number.isFinite(m.generation) ? m.generation : null;
        let gi = null;
        try { const ix = JSON.parse(fs.readFileSync(path.join(job.indexDir, 'star', 'index.json'), 'utf8')); gi = Number.isFinite(ix.generation) ? ix.generation : null; } catch {}
        if (gi != null && (gv == null || gv !== gi)) {
          console.error(`[memo] auto-catchup re-arm: index=${gi} vectors=${gv ?? 'missing'}`);
          _scheduleAutoCatchup(job.indexDir, gi);
        }
      } catch { /* 旁路 */ }
    };
    if (p && typeof p.then === 'function') p.then(() => setTimeout(check, 0));
    else setTimeout(check, 2000);
  } catch { /* 旁路 */ }
}

/** 后台异步补齐：不 await；同一进程同时只允许一个；跑完打一行并清 flag。返回完成 promise（供等待者用） */
function _startVectorCatchUp(indexDir, expectGeneration) {
  const dir = indexDir || _lastIndexDir;
  if (_vectorCatchUpRunning) return _vectorCatchUpPromise;
  if (!dir) return null;
  _vectorCatchUpRunning = true;
  _gvStat = null;
  _vectorCatchUpPromise = new Promise((resolve) => {
    try {
      const p = _vecPaths();
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [path.join(__dirname, 'build-vectors-inc.cjs')], {
        env: { ...process.env, MEMO_BLOCKS: path.join(dir, 'star', 'index.json'), MEMO_VECTORS_DIR: path.dirname(p.vec) },
        stdio: 'inherit', windowsHide: true,
      });
      if (child && typeof child.unref === 'function') child.unref();
      child.on('error', () => { _vectorCatchUpRunning = false; resolve(false); });
      child.on('close', () => {
        _vectorCatchUpRunning = false;
        console.error(`[memo] vector catch-up done generation=${expectGeneration ?? 'missing'}`);
        resolve(true);
      });
      child.on('close', code => console.log('[memo] vector catch-up exit code=' + code));
    } catch {
      _vectorCatchUpRunning = false;
      resolve(false);
    }
  });
  return _vectorCatchUpPromise;
}

/**
 * 有界等待向量追上 gi（不抛、不阻塞事件循环）。
 * - 本进程有补跑在跑 → await 它的完成 promise；
 * - 没有（跨进程起的）→ 每 300ms 读一次磁盘 meta（用 mtime/size 跳重复解析）；
 * - 超时返回 false。收尾一定重读磁盘确认 gv === gi，不把"崩了"当"完成"。
 */
async function waitForVectorGeneration(gi, timeoutMs = 20000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const readGv = () => {
    try {
      const p = _vecPaths();
      const st = fs.statSync(p.meta);
      if (_gvStat && _gvStat.mtimeMs === st.mtimeMs && _gvStat.size === st.size) return _gvStat.gv;
      const m = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
      const gv = Number.isFinite(m.generation) ? m.generation : null;
      _gvStat = { mtimeMs: st.mtimeMs, size: st.size, gv };
      return gv;
    } catch { return null; }
  };
  const done = () => gi != null && readGv() === gi;
  if (done()) return true;
  if (_vectorCatchUpRunning && _vectorCatchUpPromise) {
    await Promise.race([_vectorCatchUpPromise, sleep(Math.max(0, deadline - Date.now()))]);
  }
  while (Date.now() <= deadline) {
    if (done()) { _vecCache = null; return true; }
    await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
  }
  return done();
}

function _vectorRecall(index, query, opts = {}) {
  const v = _ensureVectorGeneration(index);   // ① 代际快筛（contentHash 校验仍在后面，两层都要）
  const q = _embedQuerySync(query);
  if (q.length !== v.dim) throw new Error('dim mismatch');
  let qn = 0; for (const x of q) qn += x * x; qn = Math.sqrt(qn) || 1;
  const lookup = _vecLookup(index);
  const scored = [];
  for (const e of v.entries) {
    let dot = 0;
    for (let i = 0; i < e.dim; i++) dot += q[i] * (v.buf[e.offset + i] << 24 >> 24);
    scored.push({ e, s: dot / (qn * e.norm8 || 1) });
  }
  scored.sort((a, b) => b.s - a.s);
  const k = Math.max(1, Math.min(20, opts.k || 5));
  // ★ vector 也要有 why：用和 legacy 同一套切词，算出「这块为什么命中」
  const vecKeys = [...extractKeys(query).keys()].filter(xk => xk.length >= 2);
  const crypto = require('node:crypto');
  const stale = new Set();
  const items = [];
  const sectionMap = new Map();
  for (const { e, s } of scored) {
    if (sectionMap.size >= k) break;
    if (!e.contentHash) { stale.add(e.file); continue; }
    const cands = lookup.get(e.file + '\u0000' + e.contentHash) || [];
    if (!cands.length) { stale.add(e.file); continue; }
    let b = cands[0];
    if (e.inFileIndex != null) {
      const exact = cands.find(x => x.inFileIndex === e.inFileIndex);
      b = exact || [...cands].sort((x, y) => Math.abs(x.startLine - e.startLine) - Math.abs(y.startLine - e.startLine))[0];
    }
    const check = crypto.createHash('sha1').update(String(b.text || '')).digest('hex');
    if (check !== e.contentHash) { stale.add(e.file); continue; }
    const flat = String(b.text || '').replace(/[*#|`\s]/g, '');
    if (flat.length < 20 && /[:：]$/.test(flat)) continue;   // 纯标题块，跳过
    // 检索面同样含标题层：命中词可能在文件名/小节标题里
    const face = _searchFace(b);
    const hitWord = _hitWordOf(face, vecKeys);
    const snip = hitWord ? _snippetAround(face, hitWord) : _snippetOf(face);
    const verified = hitWord ? _snippetHas(snip, hitWord) : false;
    if (hitWord && !verified) { stale.add(e.file); continue; }   // ★ 校验不过就丢，不静默
    const item = {
      file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
      startLine: b.startLine, endLine: b.endLine,
      snippet: snip,
      why: hitWord || '(只是向量近，没有字面命中)',
      score: +s.toFixed(3),
      ...(hitWord ? {} : { vectorOnly: true, snippetFromStart: true }),   // ★ 标明：只是向量近 + 片段是块开头
      ...(isStaleText(b.text) ? { stale: true } : {}),
    };
    addSectionItem(sectionMap, items, item, b);
  }
  if (stale.size) for (const f of stale) console.error('[memo] stale-block: ' + f);
  if (items.length === 0) throw new Error('all blocks stale');
  const best = items[0] ? items[0].score : 0;
  const confidence = best >= 0.57 ? 'high' : (best >= 0.42 ? 'mid' : 'low');
  const text = confidence === 'low' ? '想不起，翻下本子'
    : (confidence === 'high' ? '这里可能相关：' : '可能相关，要细看我可以翻：');
  const r = { confidence, text, items: confidence === 'low' ? [] : items };
  const t = classifyTier(index, query, r);
  return { ...r, ...t };
}

// ---- ② 上次成功结果（stale-but-labeled）----
const _staleCache = new Map();
const STALE_CACHE_MAX = 200;
function _lcsLen2(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0), best = 0;
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev = cur;
  }
  return best;
}
function _verifyStaleItems(items, partnerDir) {
  if (!partnerDir || !Array.isArray(items) || !items.length) return false;
  const fs = require('node:fs');
  const path = require('node:path');
  for (const it of items) {
    try {
      const abs = path.join(partnerDir, it.file);
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      const s = Math.max(1, Math.trunc(it.startLine || 1));
      const e = Number.isFinite(it.endLine) ? Math.trunc(it.endLine) : s;
      const span = lines.slice(s - 1, Math.max(s, e)).join(' ').replace(/\s+/g, ' ').trim();
      const core = String(it.snippet || '').replace(/…/g, '').replace(/\s+/g, ' ').trim();
      if (!core) return false;
      if (_lcsLen2(core, span) / core.length < 0.5) return false;
    } catch { return false; }
  }
  return true;
}
function _rememberGoodResult(query, r) {
  try {
    if (!r || r.degraded || !Array.isArray(r.items) || !r.items.length) return;
    _staleCache.set(query, { items: r.items.map((it) => ({ ...it })), asOf: new Date().toISOString() });
    if (_staleCache.size > STALE_CACHE_MAX) { const k = _staleCache.keys().next().value; _staleCache.delete(k); }
  } catch { /* 旁路 */ }
}
function _staleFallback(query, opts, e, gi, gv) {
  try {
    if (process.env.MEMO_STALE_CACHE === '0') return null;
    const c = _staleCache.get(query);
    if (!c) return null;
    if (!_verifyStaleItems(c.items, opts && opts.partnerDir)) {
      console.error('[memo] stale-cache dropped: snippet-mismatch');
      return null;
    }
    console.error(`[memo] stale-cache hit: asOf=${c.asOf}`);
    return {
      confidence: 'stale',
      text: '（上次结果 · 正在补向量）',
      items: c.items.map((it) => ({ ...it, stale: true, asOf: c.asOf })),
      stale: true,
      asOf: c.asOf,
      degraded: String(e && e.message ? e.message : e),
      indexGeneration: gi ?? null,
      vectorsGeneration: gv ?? null,
    };
  } catch { return null; }
}

// ---- ① BM25-lite（只在降级时顶上；snippet 从同一块 _searchFace 截）----
function _bm25Recall(index, query, opts = {}) {
  const keys = [...extractKeys(query).keys()].filter((k) => k.length >= 2);
  if (!keys.length) return { confidence: 'low', text: '（BM25 字面通道）', items: [] };
  const k = Math.max(1, Math.min(20, opts.k || 5));
  const blocks = index.blocks || [];
  const N = blocks.length;
  if (!Number.isFinite(index.__bm25avg)) {
    let sum = 0;
    for (const x of blocks) sum += String(x.text || '').length;
    index.__bm25avg = sum / Math.max(1, N);
  }
  const avg = index.__bm25avg || 1;
  const faces = blocks.map((x) => _searchFace(x));
  const df = new Map();
  for (const key of keys) {
    let c = 0;
    for (const f of faces) if (f.includes(key)) c += 1;
    df.set(key, c);
  }
  const k1 = 1.2, bb = 0.75;
  const scored = [];
  for (let i = 0; i < N; i += 1) {
    const face = faces[i];
    const dl = Math.max(1, face.length);
    let s = 0, firstKey = null;
    for (const key of keys) {
      const tf = face.split(key).length - 1;
      if (!tf) continue;
      if (!firstKey) firstKey = key;
      const d = df.get(key) || 0;
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - bb + bb * dl / avg));
    }
    if (s > 0) scored.push({ x: blocks[i], s, firstKey });
  }
  scored.sort((a, b) => b.s - a.s);
  const items = [];
  for (const { x, s, firstKey } of scored) {
    if (items.length >= k) break;
    const snip = _snippetAround(_searchFace(x), firstKey);
    if (!_snippetHas(snip, firstKey)) continue;
    items.push({
      file: x.file, anchor: x.anchor, writtenAt: x.writtenAt,
      startLine: x.startLine, endLine: x.endLine,
      snippet: snip, why: firstKey, score: +s.toFixed(3), mode: 'bm25',
    });
  }
  return { confidence: 'low', text: '（BM25 字面通道）', items };
}

/** 体检：索引里有、manifest 里没有的孤儿块。兼容 manifest 的两种形状（数组 / {files:[]}）。 */
function orphanStats(index) {
  const raw = index && index.manifest;
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.files) ? raw.files : []);
  const mf = new Set(list.map((f) => String(f && f.file)));
  const perFile = new Map();
  for (const b of (index && index.blocks) || []) {
    const f = String(b.file);
    if (!mf.has(f)) perFile.set(f, (perFile.get(f) || 0) + 1);
  }
  const files = [...perFile.keys()].sort();
  return { blocks: files.reduce((a, f) => a + perFile.get(f), 0), files };
}

function recall(index, query, opts = {}) {
  const mode = process.env.MEMO_RETRIEVAL || 'vector';
  if (mode !== 'vector') {
    const r = _legacyPath(index, query, opts);
    _rememberGoodResult(query, r);
    return r;
  }
  const t0 = Date.now();
  try {
    const r = _vectorRecall(index, query, opts);
    if (Date.now() - t0 > 2000) throw new Error('vector path exceeded 2000ms');
    _rememberGoodResult(query, r);
    return r;
  } catch (e) {
    console.error('[memo] degrade: ' + (e && e.message ? e.message : String(e)));
    const gi = Number.isFinite(index && index.generation) ? index.generation : null;
    let gv = null;
    try {
      const v = _loadVectors();
      gv = Number.isFinite(v && v.generation) ? v.generation : null;
    } catch { gv = null; }
    // ② 上次成功结果先顶着（校验过 snippet 才用）
    const stale = _staleFallback(query, opts, e, gi, gv);
    if (stale) return stale;
    // ① BM25-lite 顶上（只在降级时；默认开，MEMO_BM25=0 关）
    if (process.env.MEMO_BM25 !== '0') {
      try {
        const bm = _bm25Recall(index, query, opts);
        if (bm.items && bm.items.length) {
          return { ...bm, degraded: String(e && e.message ? e.message : e), indexGeneration: gi, vectorsGeneration: gv, mode: 'bm25' };
        }
      } catch { /* 旁路 */ }
    }
    const out = _legacyPath(index, query, opts);
    return {
      ...out,
      degraded: String(e && e.message ? e.message : e),
      indexGeneration: gi,
      vectorsGeneration: gv,
    };
  }
}

function buildVectorsIncremental(opts = {}) {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const script = path.join(__dirname, 'build-vectors-inc.cjs');
  const env = { ...process.env, ...(opts.env || {}) };
  return execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
}

module.exports = {
  buildIndex,
  buildVectorsIncremental,
  buildStar,
  buildStarIndex,
  buildEdgesFast,
  saveStarIndex,
  loadStarIndex,
  openStarIndex,
  hasLegacyIndex,
  computeManifest,
  rebuildChangedFiles,
  STAR_VERSION,
  INDEX_VERSION,
  recall,
  orphanStats,
  waitForVectorGeneration,
  baseRecall,
  classifyTier,
  queryContentWords,
  buildTierVocab,
  rebuildFile,
  rebuildStarFile,
  grep,
  locate,
  extractKeys,
  chunkMarkdown,
  saveIndex,
  loadIndex,
};
