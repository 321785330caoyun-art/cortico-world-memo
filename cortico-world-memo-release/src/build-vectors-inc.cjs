// 增量向量构建器（副本用）：按文件 hash + 块内容 hash 对齐，只重嵌变化的文件
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ★ 补跑是后台任务：把本进程优先级压到 IDLE（Windows 上 PRIORITY_LOW 实测映射为 Idle）
try {
  const os = require('node:os');
  const pr = os.constants.priority;
  os.setPriority(0, pr.PRIORITY_IDLE !== undefined ? pr.PRIORITY_IDLE : pr.PRIORITY_LOW);
} catch { /* 设不上也不影响补跑 */ }

const ROOT = 'C:/Users/xu/Documents/deepseek-harness/default-workspace/_star';
const KEYFILE = 'C:/Users/xu/Coopanion/data/home/companion/workspace/partner/vendor/siliconflow.key.txt';
const BLOCKS = process.env.MEMO_BLOCKS || 'C:/Users/xu/Coopanion/data/home/companion/data/memo-index/blocks.json';
const WORKSPACE = (process.env.MEMO_WORKSPACE || 'C:/Users/xu/Coopanion/data/home/companion/workspace').replace(/[\\/]+$/, '');
const OUTDIR = (process.env.MEMO_VECTORS_DIR || (ROOT + '/inc-vectors')).replace(/[\\/]+$/, '');
const VEC = OUTDIR + '/vectors.int8';
const META = OUTDIR + '/vectors.meta.json';
const BATCH = 32;
const MODEL = 'BAAI/bge-m3';

const keyText = fs.readFileSync(KEYFILE, 'utf8');
const key = (keyText.match(/sk-[A-Za-z0-9_-]{20,}/) || [])[0];
const base = (keyText.match(/https:\/\/[^\s]+/) || ['https://api.siliconflow.cn/v1'])[0].replace(/\/$/, '');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const _src = JSON.parse(fs.readFileSync(BLOCKS, 'utf8'));
const blocks = _src.blocks;
const sourceGeneration = Number.isFinite(_src.generation) ? _src.generation : null;   // 与索引同一代际（不自己加）
const groups = new Map();
for (const b of blocks) {
  if (!groups.has(b.file)) groups.set(b.file, []);
  groups.get(b.file).push(b);
}

let oldMeta = null, oldBuf = null;
try { oldMeta = JSON.parse(fs.readFileSync(META, 'utf8')); oldBuf = fs.readFileSync(VEC); } catch { /* first build */ }
const oldByKey = new Map();
if (oldMeta) for (const e of oldMeta.entries || []) oldByKey.set(e.key, e);

async function embedBatch(texts) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(base + '/embeddings', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: texts, encoding_format: 'float' }),
    });
    if (res.ok) { const j = await res.json(); return j.data.map(d => d.embedding); }
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** (attempt - 1)))); continue; }
    throw new Error('embed failed ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
  throw new Error('retries exhausted');
}

function quantize(v) {
  let maxAbs = 0;
  for (const x of v) { const a = Math.abs(x); if (a > maxAbs) maxAbs = a; }
  const scale = maxAbs / 127 || 1;
  const q = Buffer.allocUnsafe(v.length);
  let norm2 = 0;
  for (let i = 0; i < v.length; i++) {
    const qv = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
    q[i] = qv & 0xff;
    norm2 += qv * qv;
  }
  return { q, scale, norm8: Math.sqrt(norm2) };
}

(async () => {
  const t0 = Date.now();
  const outEntries = [];
  const outChunks = [];
  const filesMeta = {};
  const changed = [], removed = [], reused = [];
  let requests = 0, embeddedBlocks = 0, offset = 0, dim = oldMeta ? oldMeta.dim : null;

  for (const [file, arr] of groups) {
    const abs = path.join(WORKSPACE, file);
    let st = null;
    try { st = fs.statSync(abs); } catch { /* missing file → drop blocks */ }
    if (!st) { removed.push(file); continue; }

    const contentHash = sha1(fs.readFileSync(abs));
    const keys = arr.map((b, i) => `${file}\u0000${sha1(String(b.text || ''))}\u0000${i}`);
    const rec = oldMeta && oldMeta.files && oldMeta.files[file];
    const same = rec && rec.hash === contentHash && rec.blockCount === arr.length && keys.every(k => oldByKey.has(k));

    if (same) {
      reused.push(file);
      for (let i = 0; i < keys.length; i++) {
        const e = oldByKey.get(keys[i]);
        outChunks.push(oldBuf.subarray(e.offset, e.offset + e.dim));
        outEntries.push({ ...e, blockId: arr[i].id, offset });
        offset += e.dim;
      }
    } else {
      changed.push(file);
      const texts = arr.map(b => `${b.file} ${b.anchor || ''} ${b.text}`);
      for (let i = 0; i < texts.length; i += BATCH) {
        const part = texts.slice(i, i + BATCH);
        const vecs = await embedBatch(part); requests++;
        for (let j = 0; j < vecs.length; j++) {
          const v = vecs[j];
          if (dim === null) dim = v.length;
          if (v.length !== dim) throw new Error('dim mismatch');
          const { q, scale, norm8 } = quantize(v);
          const b = arr[i + j];
          const idx = i + j;
          outChunks.push(q);
          outEntries.push({
            key: keys[idx], blockId: b.id, file, startLine: b.startLine, anchor: b.anchor || '',
            contentHash: sha1(String(b.text || '')), inFileIndex: idx,
            offset, dim, scale, norm8,
          });
          offset += dim; embeddedBlocks++;
        }
      }
    }

    const ids = arr.map(b => b.id);
    filesMeta[file] = {
      mtimeMs: st.mtimeMs, size: st.size, hash: contentHash, blockCount: arr.length,
      firstBlockId: ids[0] ?? null, lastBlockId: ids[ids.length - 1] ?? null, keys,
    };
  }
  if (oldMeta && oldMeta.files) {
    for (const f of Object.keys(oldMeta.files)) {
      if (!groups.has(f) && !removed.includes(f)) removed.push(f);
    }
  }

  const genSame = oldMeta && ((oldMeta.generation ?? null) === sourceGeneration);
  if (requests === 0 && removed.length === 0 && genSame) {
    console.log(JSON.stringify({ ok: true, skipped: true, files: groups.size, blocks: blocks.length, reusedFiles: reused.length, changedFiles: 0, removedFiles: removed.length, embeddedBlocks: 0, requests: 0, seconds: +((Date.now() - t0) / 1000).toFixed(1) }));
    return;
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  // ★ 临时文件带 pid：两个补跑进程并发时不会抢同一个 tmp（避免向量与元数据错位）
  const tmpVec = VEC + '.tmp-' + process.pid;
  const tmpMeta = META + '.tmp-' + process.pid;
  const fd = fs.openSync(tmpVec, 'w');
  try { for (const c of outChunks) fs.writeSync(fd, c); } finally { fs.closeSync(fd); }
  fs.writeFileSync(tmpMeta, JSON.stringify({ model: MODEL, dim, count: outEntries.length, bytes: offset, generation: sourceGeneration, files: filesMeta, entries: outEntries }), 'utf8');
  fs.renameSync(tmpVec, VEC);
  fs.renameSync(tmpMeta, META);

  console.log(JSON.stringify({
    ok: true, files: groups.size, blocks: blocks.length, dim, bytes: offset,
    int8MB: +(offset / 1048576).toFixed(2),
    reusedFiles: reused.length, changedFiles: changed.length, removedFiles: removed.length,
    changed: changed.slice(0, 20), removed: removed.slice(0, 20),
    embeddedBlocks, requests, seconds: +((Date.now() - t0) / 1000).toFixed(1),
  }));
})().catch(e => { console.error('FAIL ' + (e && e.message)); process.exit(1); });
