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
        bump(run.slice(i, i + matched));
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
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let curTitle = '';

  const emit = (text, startLine, endLine) => {
    const t = text.trim();
    if (t.length >= 4) blocks.push({ anchor: curTitle || '(正文)', startLine, endLine, text: t });
  };

  // 当前"非结构段落"缓存（普通散文，既不是列表也不是表格）
  let para = [], paraStart = -1;
  const flushPara = (endLine) => {
    if (para.length === 0) return;
    const t = para.join('\n').trim();
    // 兜底：普通段落若有超长且内部无结构边界 → 按句号切
    if (t.length > HARD_CAP) {
      const parts = t.split(/(?<=[。！？；!?;])/).filter(s => s.trim().length);
      let cur = '';
      let curStart = paraStart;
      const pl = para;
      // 逐行重新定位行号
      let rowIdx = 0;
      const segs = [];
      let acc = '';
      for (const ln of pl) {
        if (acc && (acc + ln).length > HARD_CAP) { segs.push({ text: acc, end: paraStart + rowIdx - 1 }); acc = ''; }
        acc += (acc ? '\n' : '') + ln; rowIdx++;
      }
      if (acc) segs.push({ text: acc, end: endLine });
      for (const s of segs) emit(s.text, paraStart, s.end);
    } else {
      emit(t, paraStart, endLine);
    }
    para = []; paraStart = -1;
  };

  // 当前"结构块"（一个列表项 / 一行表格 —— 各自独立）
  let cur = [], curStart = -1;
  const flushCur = (endLine) => {
    if (cur.length === 0) return;
    // 单个结构块也可能超长（比如一个列表项塞了 5000 字）——此时才按句兜底
    const t = cur.join('\n').trim();
    if (t.length > 1600) {
      // 极端兜底：这个列表项内部超长，按句切（这属于本子写法问题，切块器只防崩）
      const parts = t.split(/(?<=[。！？；!?;])/);
      let acc = '';
      for (const p of parts) {
        if (acc && (acc + p).length > HARD_CAP) { emit(acc, curStart, endLine); acc = ''; }
        acc += p;
      }
      if (acc.trim()) emit(acc, curStart, endLine);
    } else {
      emit(t, curStart, endLine);
    }
    cur = []; curStart = -1;
  };

  // 记录上一行形态，用来合并"表格连续行"的判定
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const lineNo = i + 1;

    const h = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (h) {
      flushPara(lineNo - 1);
      flushCur(lineNo - 1);
      curTitle = h[2].trim();
      continue;
    }
    if (ln.trim() === '') {
      flushPara(lineNo - 1);
      flushCur(lineNo - 1);
      continue;
    }

    // 表格行：每行独立成块（一行一条消息/一行表格记录）
    if (TABLE_RE.test(ln)) {
      flushPara(lineNo - 1);
      flushCur(lineNo - 1);
      emit(ln, lineNo, lineNo);
      continue;
    }

    // 列表项：每项独立成块（项内的缩进续行归到该项）
    if (LIST_RE.test(ln)) {
      flushPara(lineNo - 1);
      flushCur(lineNo - 1);
      curStart = lineNo;
      cur = [ln];
      continue;
    }

    // 缩进续行：若在列表项里 → 归入该项；否则归入段落
    if (cur.length > 0 && /^\s+\S/.test(ln)) {
      cur.push(ln);
      continue;
    }

    // 其余：普通段落
    flushCur(lineNo - 1);
    if (para.length === 0) paraStart = lineNo;
    para.push(ln);
  }
  flushPara(lines.length);
  flushCur(lines.length);
  return blocks;
}

// ---- 切块收块：给定一组绝对文件路径，扫出来变成 blocks ----
// 每个块带 id（全局递增，调用方重编号）、file(相对 partnerDir)、行号、原文。
function collectBlocks(partnerDir, absFiles) {
  const blocks = [];
  let scannedFiles = 0;
  let dropped = 0;
  for (const file of absFiles) {
    scannedFiles++;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(partnerDir, file).replace(/\\/g, '/');
    const stat = fs.statSync(file);
    const writtenAt = new Date(stat.mtimeMs).toISOString();
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
      blocks.push({
        id: blocks.length + 1,
        file: rel,
        anchor: c.anchor,
        startLine: c.startLine,
        endLine: c.endLine,
        writtenAt,
        text: c.text,
      });
    }
  }
  return { blocks, scannedFiles, dropped };
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

  // ④ 每块取 top-K → 生成无向边（a<b 归一，去重）
  const byId = new Map(blocks.map(b => [b.id, b]));
  const edgeW = new Map(); // "a|b"(a<b) -> weight（同一 pair 从两端各算一次，取较大/相同值）
  for (const [a, m] of cand) {
    // 该块候选按分数取 top-K
    const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, K_NEIGHBORS);
    for (const [b, w] of top) {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const kk = lo + '|' + hi;
      // 两端可能都给同一 pair 分，理论上相等（同一 idf 累加），取较大更稳
      const prev = edgeW.get(kk);
      if (prev === undefined || w > prev) edgeW.set(kk, w);
    }
  }

  let edges = [];
  for (const [kk, wsum] of edgeW) {
    const [a, b] = kk.split('|').map(Number);
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
    (opts.excludeDirs && opts.excludeDirs.length ? opts.excludeDirs : ['handoffs', 'archive', 'blobs', 'tools'])
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

  const { blocks, scannedFiles, dropped } = collectBlocks(partnerDir, files);
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
      lastIndexedAt: new Date().toISOString(),
    },
  };
}

// ---- 单文件重算：只重切一个文件，替换它的块，重建图，落盘 ----
// 路径安全：relFile 必须落在 partnerDir 内。
// 正确性：该文件旧块全部删掉、新块追加并重编号 → 全图重算（保证边与新块一致）。
// 代价：建图仍是全量（≈几秒）；但省掉了其余文件的重读重切。
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
  merged.forEach((b, i) => { b.id = i + 1; });

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
      lastIndexedAt: new Date().toISOString(),
    },
  };
  if (!opts.noSave) saveIndex(indexDir, index);
  return { ok: true, index, file: rel, fileBlocks: fresh.length, saved: !opts.noSave };
}

// ---- 召回：带衰减的方向性传播 ----
function recall(index, query, opts = {}) {
  const k = opts.k || 5;
  const LAMBDA = opts.lambda ?? 0.6;   // 每跳衰减
  const HOPS = opts.hops ?? 3;         // 最多传播 3 跳
  const REVERSE_FLOOR = opts.reverseFloor ?? 0.4; // 逆流阻力
  const HIGH = 0.75, MID = 0.4;

  const qKeys = extractKeys(query);
  if (qKeys.size === 0) return { confidence: 'low', text: '想不起，翻下本子', items: [] };

  // 建邻接
  const out = new Map(), inMap = new Map();
  for (const e of index.edges) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
    (inMap.get(e.to) || inMap.set(e.to, []).get(e.to)).push(e);
  }

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
    const lower = b.text.toLowerCase();
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
    for (const [node, s] of frontier) {
      for (const e of (out.get(node) || [])) {
        next.set(e.to, Math.max(next.get(e.to) || 0, s * e.weight * LAMBDA));
      }
      for (const e of (inMap.get(node) || [])) {
        next.set(e.from, Math.max(next.get(e.from) || 0, s * e.weight * LAMBDA * REVERSE_FLOOR));
      }
    }
    for (const [n, s] of next) {
      if (!score.has(n) || score.get(n) < s) {
        if (!score.has(n)) score.set(n, 0);
        score.set(n, score.get(n) + s * (hop === 1 ? 1 : 0.5));
        if (!via.has(n) || via.get(n).hop === 0) {
          // 记录来源：找是哪个 frontier 节点连过来的
          let fromId = null;
          for (const [fn] of frontier) {
            const hasEdge = (out.get(fn) || []).some(e => e.to === n) || (inMap.get(fn) || []).some(e => e.from === n);
            if (hasEdge) { fromId = fn; break; }
          }
          if (!(via.has(n) && via.get(n).hop === 0)) via.set(n, { fromId, hop });
        }
      }
    }
    frontier = next;
  }

  // 排序取前 k
  const ranked = [...score.entries()]
    .map(([id, s]) => ({ b: byId.get(id), s, cov: coverageOf.get(id) || 0 }))
    .filter(x => x.b)
    .sort((x, y) => y.s - x.s)
    .slice(0, k);

  // ★ snippet 围绕"命中词"截取，保证展示的原文里能看见"为什么命中"
  const snippetAround = (text, word, span = 120) => {
    const w = (word || '').replace(/^\(.*\)$/, '');
    let at = w ? text.toLowerCase().indexOf(w.toLowerCase()) : -1;
    if (at < 0) at = 0;
    const half = Math.floor(span / 2);
    let start = Math.max(0, at - half);
    let s = text.slice(start, start + span);
    if (start > 0) s = '…' + s;
    if (start + span < text.length) s = s + '…';
    return s.replace(/\n/g, ' ');
  };

  // ★ 只保留"有实体依据"的条目：
  //   起点命中(cov>0) → 有依据（why=命中词）
  //   传播来的(cov=0) → 必须能追到起点，且给出"经由哪段"的说明；追不到→剔除（噪音）
  const items = [];
  for (const { b, s, cov } of ranked) {
    const v = via.get(b.id);
    if (cov > 0) {
      // 起点直接命中
      items.push({
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: snippetAround(b.text, why.get(b.id)), why: why.get(b.id),
        score: +Math.min(1, cov).toFixed(3),
      });
    } else if (v && v.fromId != null && byId.get(v.fromId)) {
      // 传播来的：说清"经由哪段相关"——共享词是什么
      const src = byId.get(v.fromId);
      const share = (why.get(v.fromId) || '').replace(/^\(.*\)$/, '');
      items.push({
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: snippetAround(b.text, ''), 
        why: `经「${src.anchor}」关联（共享「${share}」）`,
        score: +(Math.min(1, cov) * 0.5).toFixed(3),  // 传播的分打对折
      });
    }
    // cov=0 且无来源 → 不加入（噪音剔除）
  }
  // 若起点(有依据)为空但有低分传播，全丢弃 → low

  // ★ 置信度按「起点对 query 的覆盖率」定：覆盖高=真命中；覆盖低=沾边→low
  const bestCov = ranked.length ? Math.max(...ranked.map(r => r.cov)) : 0;
  let confidence;
  if (bestCov >= 0.8) confidence = 'high';
  else if (bestCov >= 0.45) confidence = 'mid';
  else confidence = 'low';
  if (items.length === 0 || bestCov < 0.45) confidence = 'low';

  const text = confidence === 'low' ? '想不起，翻下本子'
    : (confidence === 'high' ? '这里可能相关：' : '可能相关，要细看我可以翻：');
  return { confidence, text, items: confidence === 'low' ? [] : items };
}

// ---- grep：字面精确 ----
function grep(index, query, limit = 10) {
  const q = String(query || '');
  if (!q) return { hits: [] };
  const hits = [];
  const low = q.toLowerCase();
  for (const b of index.blocks) {
    const at = b.text.toLowerCase().indexOf(low);
    if (at >= 0) {
      // snippet 围绕命中位置截取，保证「命中词看得见」
      const span = 120, half = Math.floor(span / 2);
      let start = Math.max(0, at - half);
      let s = b.text.slice(start, start + span).replace(/\n/g, ' ');
      if (start > 0) s = '…' + s;
      if (start + span < b.text.length) s = s + '…';
      hits.push({
        file: b.file, anchor: b.anchor, writtenAt: b.writtenAt,
        startLine: b.startLine, endLine: b.endLine,
        snippet: s, matched: b.text.substr(at, q.length),
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

module.exports = { buildIndex, rebuildFile, recall, grep, locate, extractKeys, chunkMarkdown, saveIndex, loadIndex };
