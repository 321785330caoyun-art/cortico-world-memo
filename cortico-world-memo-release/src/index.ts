/**
 * 记忆指路 World（本地版）
 *
 * 干什么：把 partner 本子（workspace\partner\**\*.md）切成记忆块、建共现边图，
 *   暴露五个工具给 agent：memo_index / memo_link / memo_recall / memo_locate / memo_grep。
 *   引擎全是纯逻辑（memo-engine.cjs），这里只做「装配壳」：推路径、装引擎、把工具接上。
 *
 * 铁律（继承引擎）：
 *   ① 只读本子，绝不写本子
 *   ② 索引是可删派生物，落在 dataDir\memo-index\，删了能重建
 *   ③ 每个块都能反查回原文行（locate）
 *
 * 与 emo 扩展同一套 World 骨架：id 逐字等于包名，default 导出定义，ctx 提供 dataDir/botDir。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import type { WorldDefinition, WorldContext } from 'cortico/world.ts';
import type { ToolDef } from 'cortico/core/types.ts';

export const MEMO_ID = 'cortico-world-memo';

/** 本子目录解析：配了用配的 → 环境变量 → 按约定猜 → 猜不到返回 null（调用方明说「没找到本子，先告诉我在哪」）。 */
function resolvePartnerDir(ctx: { botDir?: string; dataDir?: string; cfg?: MemoConfigSection }): string | null {
  // ① 配置显式覆盖
  const override = ctx.cfg?.partnerDir?.trim();
  if (override) return existsSync(override) ? override : null;
  // ② 环境变量覆盖（发出去给别人用时最方便）
  const envDir = (process.env.MEMO_PARTNER_DIR ?? '').trim();
  if (envDir) return existsSync(envDir) ? envDir : null;
  // ③ 按约定猜
  const candidates: string[] = [];
  if (ctx.botDir) {
    candidates.push(join(ctx.botDir, 'workspace', 'partner'));
    candidates.push(join(ctx.botDir, 'partner'));
  }
  // dataDir 通常是 <根>\data，partner 在 <根>\workspace\partner（与 data 同级）
  if (ctx.dataDir) {
    candidates.push(join(dirname(ctx.dataDir), 'workspace', 'partner'));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  // ④ 猜不到
  return null;
}

export interface MemoConfigSection {
  /** 框架读它决定挂不挂载。 */
  enabled: boolean;
  /** 本子目录；留空则按约定自动推导（<botDir>\workspace\partner 等）。 */
  partnerDir: string;
  /** 索引目录；留空则用 <dataDir>\memo-index。 */
  indexDir: string;
  /** 索引落盘模式：'write'=正常落盘；'readonly'=只读不落盘（启动能载入已有索引，但不写入）。 */
  indexMode: 'write' | 'readonly';
  /** 收哪些后缀，默认 ['.md']。 */
  extensions: string[];
  /** 跳过的目录名（任意层级），默认 ['handoffs','archive','blobs','tools']。 */
  excludeDirs: string[];
  /** 是否递归子目录，默认 true。 */
  includeSubdirs: boolean;
  /** 文件数超过它只警告，默认 5000。 */
  maxFiles: number;
  /** 总字数超过它只警告，默认 5000000。 */
  maxChars: number;
}

export const MEMO_DEFAULTS: MemoConfigSection = {
  enabled: true,
  partnerDir: '',
  indexDir: '',
  indexMode: 'write',
  extensions: ['.md'],
  excludeDirs: ['handoffs', 'archive', 'blobs', 'tools'],
  includeSubdirs: true,
  maxFiles: 5000,
  maxChars: 5_000_000,
};

type Engine = {
  buildIndex: (partnerDir: string, opts?: Record<string, unknown>) => MemoIndex;
  rebuildFile: (indexDir: string, partnerDir: string, relFile: string, opts?: Record<string, unknown>) => { ok: boolean; index?: MemoIndex; file?: string; fileBlocks?: number; saved?: boolean; error?: string };
  recall: (index: MemoIndex, query: string, opts?: Record<string, unknown>) => unknown;
  grep: (index: MemoIndex, query: string, limit?: number) => unknown;
  locate: (partnerDir: string, file: string, opts?: Record<string, unknown>) => unknown;
  saveIndex: (indexDir: string, index: MemoIndex) => { blocksFile: string; graphFile: string };
  loadIndex: (indexDir: string) => MemoIndex | null;
};

type MemoBlock = {
  id: number; file: string; anchor: string;
  startLine: number; endLine: number; writtenAt: string; text: string;
};
type MemoEdge = { from: number; to: number; weight: number };
type MemoIndex = {
  blocks: MemoBlock[];
  edges: MemoEdge[];
  stats: { scannedFiles: number; addedBlocks: number; droppedBlocks: number; indexedEdges: number; durationMs: number; lastIndexedAt: string };
};

function loadEngine(path: string | null, where: string): Engine | null {
  if (!path) {
    try { console.error(`[memo] ${where}: 没找到引擎文件（路径推不出来或在磁盘上不存在）`); } catch { /* 日志不能崩 */ }
    return null;
  }
  try {
    const require_ = createRequire(import.meta.url);
    const mod = require_(path);
    try { console.error(`[memo] ${where}: 引擎加载成功 ← ${path}`); } catch { /* 日志不能崩 */ }
    return mod;
  } catch (e) {
    try { console.error(`[memo] ${where}: 引擎加载失败 ← ${path} (${e instanceof Error ? e.message : String(e)})`); } catch { /* 日志不能崩 */ }
    return null;
  }
}

export interface MemoWorldOptions {
  cfg: MemoConfigSection;
  dataDir?: string;
  botDir?: string;
}

export class MemoWorld {
  readonly id = MEMO_ID;
  private readonly cfg: MemoConfigSection;
  private readonly dataDir: string | undefined;
  private readonly botDir: string | undefined;
  private host: import('cortico/core/types.ts').WorldHost | null = null;
  private engine: Engine | null = null;
  private partnerDir: string | null = null;
  private indexDir: string | null = null;
  /** 内存里的当前索引；懒加载自 indexDir。 */
  private index: MemoIndex | null = null;
  /** start 后 host.log 可用；用它把引擎/构建日志写进运行日志。 */
  private log(msg: string): void {
    try { this.host?.log?.info?.(msg); } catch { /* 日志不能崩 */ }
    try { console.error(`[memo] ${msg}`); } catch { /* 日志不能崩 */ }
  }

  constructor(opts: MemoWorldOptions) {
    this.cfg = opts.cfg;
    this.dataDir = opts.dataDir;
    this.botDir = opts.botDir;
    this.engine = loadEngine(this.enginePath(), '构造时');
    this.partnerDir = resolvePartnerDir({ botDir: opts.botDir, dataDir: opts.dataDir, cfg: opts.cfg });
    this.indexDir = this.resolveIndexDir();
    try {
      const ro = this.cfg.indexMode === 'readonly' ? ' [只读不落盘]' : '';
      console.error(`[memo] 扩展已加载 | partner=${this.partnerDir ?? '(未找到 · 没找到本子，先告诉我在哪：配 partnerDir 或设环境变量 MEMO_PARTNER_DIR)'} | indexDir=${this.indexDir ?? '(无)'}${ro} | enabled=${this.cfg.enabled}`);
    } catch { /* 日志不能崩 */ }
  }

  /** 扫描参数（后缀/排除目录/上限），从配置取，转发给引擎。 */
  private scanOpts(): Record<string, unknown> {
    return {
      extensions: this.cfg.extensions,
      excludeDirs: this.cfg.excludeDirs,
      includeSubdirs: this.cfg.includeSubdirs,
      maxFiles: this.cfg.maxFiles,
      maxChars: this.cfg.maxChars,
    };
  }

  private get readOnlyIndex(): boolean {
    return this.cfg.indexMode === 'readonly';
  }

  private enginePath(): string | null {
    // 引擎与 index.ts 同目录：src/memo-engine.cjs
    const here = dirname(fileURLToPath(import.meta.url));
    const p = join(here, 'memo-engine.cjs');
    return existsSync(p) ? p : null;
  }

  private resolveIndexDir(): string | null {
    if (this.cfg.indexDir?.trim()) return this.cfg.indexDir.trim();
    if (this.dataDir) return join(this.dataDir, 'memo-index');
    return null;
  }

  async start(host: import('cortico/core/types.ts').WorldHost): Promise<void> {
    this.host = host;
    if (!this.engine) this.engine = loadEngine(this.enginePath(), 'start 时重试');
    if (!this.partnerDir) this.partnerDir = resolvePartnerDir({ botDir: this.botDir, dataDir: this.dataDir, cfg: this.cfg });
    // 尝试从磁盘懒加载上次的索引（不构建，构建要显式 memo_index）
    if (this.engine && this.indexDir) {
      const loaded = this.engine.loadIndex(this.indexDir);
      if (loaded) {
        this.index = loaded;
        this.log(`start: 已从磁盘载入索引 blocks=${loaded.blocks.length} edges=${loaded.edges.length} lastIndexedAt=${loaded.stats?.lastIndexedAt ?? '?'}`);
      } else {
        this.log('start: 磁盘无索引，等 memo_index 构建');
      }
    }
    this.log(`start 完成 | engineLoaded=${!!this.engine} | partner=${this.partnerDir ?? '(未找到)'}${this.readOnlyIndex ? ' | 索引只读不落盘' : ''}`);
    if (!this.partnerDir) {
      this.log('没找到本子目录。先告诉我在哪：在配置 memo.partnerDir 填路径，或设环境变量 MEMO_PARTNER_DIR。现在五个工具都会报「找不到本子」。');
    }
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  envPromptVars(): Record<string, string> | null {
    return null;
  }

  /** 确保索引在内存：有就直接用，没有就从磁盘载，再没有报错说「先 memo_index」。 */
  private ensureIndex(): MemoIndex {
    if (this.index) return this.index;
    if (this.engine && this.indexDir) {
      const loaded = this.engine.loadIndex(this.indexDir);
      if (loaded) { this.index = loaded; return loaded; }
    }
    throw new Error('还没有索引，先调 memo_index 构建一次');
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'memo_index',
        description: '重建/加载记忆索引。mode="full"=重新扫本子全部切块建图并落盘；mode="load"=只从磁盘载入上次索引。构建后返回块数、边数、耗时。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['full', 'load'], description: 'full=重新构建；load=只载入磁盘索引（默认 full）' },
          },
        },
        tags: ['write', 'snapshot'],
        handler: async (args) => {
          if (!this.engine) return { text: '建不了 · 引擎没加载', failed: true };
          if (!this.partnerDir) return { text: '建不了 · 没找到本子目录。先告诉我在哪：配置 partnerDir 或设环境变量 MEMO_PARTNER_DIR', failed: true };
          const mode = String(args.mode ?? 'full');
          try {
            if (mode === 'load') {
              if (!this.indexDir) return { text: '载入失败 · 没配 indexDir', failed: true };
              const loaded = this.engine.loadIndex(this.indexDir);
              if (!loaded) return { text: '没有已保存的索引，先用 mode=full 构建', failed: true };
              this.index = loaded;
              return `已载入索引 · 块${loaded.blocks.length} 边${loaded.edges.length}`;
            }
            const idx = this.engine.buildIndex(this.partnerDir, this.scanOpts()) as MemoIndex & { warnings?: string[] };
            this.index = idx;
            let savedNote: string;
            if (this.readOnlyIndex) {
              savedNote = '只读模式，不落盘（下次启动需重新构建）';
            } else if (this.indexDir) {
              this.engine.saveIndex(this.indexDir, idx);
              savedNote = '索引目录 ' + this.indexDir;
            } else {
              savedNote = '(未落盘：没配 indexDir)';
            }
            const s = idx.stats;
            this.log(`memo_index(full): files=${s.scannedFiles} blocks=${s.addedBlocks} dropped=${s.droppedBlocks} edges=${s.indexedEdges} ${s.durationMs}ms${idx.warnings?.length ? ' | 警告:' + idx.warnings.join(' / ') : ''}`);
            const warnLine = idx.warnings && idx.warnings.length ? '\n⚠ ' + idx.warnings.join('\n⚠ ') : '';
            return `索引完成 · 文件${s.scannedFiles} 块${s.addedBlocks} 丢弃${s.droppedBlocks} 边${s.indexedEdges} 耗时${s.durationMs}ms · ${savedNote}${warnLine}`;
          } catch (e) {
            return { text: '构建失败 · ' + (e instanceof Error ? e.message : String(e)), failed: true };
          }
        },
      },
      {
        name: 'memo_recall',
        description: '按一句话联想召回：给一个查询，从记忆图里沿边传播，返回最相关的几段本子原文（带文件、小节、行号、片段、命中词、置信度）。想不起就说想不起。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要回忆的事，一句话' },
            k: { type: 'number', description: '要几段，默认 5' },
          },
          required: ['query'],
        },
        tags: ['read'],
        handler: async (args) => {
          if (!this.engine) return { text: '想不起 · 引擎没加载', failed: true };
          try {
            const idx = this.ensureIndex();
            const r = this.engine.recall(idx, String(args.query ?? ''), { k: args.k }) as { confidence: string; text: string; items: unknown[] };
            // 一眼看见这份索引是什么时候建的：表比它新写的东西就是没有的
            const out = { indexedAt: idx.stats?.lastIndexedAt ?? '(未知)', ...r };
            return JSON.stringify(out, null, 2);
          } catch (e) {
            return { text: '想不起 · ' + (e instanceof Error ? e.message : String(e)), failed: true };
          }
        },
      },
      {
        name: 'memo_grep',
        description: '在本子里做字面精确搜索（不是联想）。返回命中片段，片段围绕命中词截取，保证命中词看得见。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要精确找的字词' },
            limit: { type: 'number', description: '最多几条，默认 10' },
          },
          required: ['query'],
        },
        tags: ['read'],
        handler: async (args) => {
          if (!this.engine) return { text: '搜不了 · 引擎没加载', failed: true };
          try {
            const idx = this.ensureIndex();
            const r = this.engine.grep(idx, String(args.query ?? ''), typeof args.limit === 'number' ? args.limit : 10);
            return JSON.stringify(r, null, 2);
          } catch (e) {
            return { text: '搜不了 · ' + (e instanceof Error ? e.message : String(e)), failed: true };
          }
        },
      },
      {
        name: 'memo_locate',
        description: '点回本子原文：给定文件(相对本子根的路径) + 小节标题或起始行号，返回那一段逐字原文与行号范围。只读，不写。',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '本子内相对路径，如 notes.md 或 dialogs/2026-10-25.md' },
            anchor: { type: 'string', description: '小节标题（## 后面的字）' },
            line: { type: 'number', description: '起始行号（1 起），与 anchor 二选一' },
            span: { type: 'number', description: '给 line 时回多少行上下文，默认 8' },
          },
          required: ['file'],
        },
        tags: ['read'],
        handler: async (args) => {
          if (!this.engine) return { text: '翻不了 · 引擎没加载', failed: true };
          if (!this.partnerDir) return { text: '翻不了 · 找不到本子目录', failed: true };
          try {
            const opts: Record<string, unknown> = {};
            const startLine = typeof args.line === 'number' ? args.line : null;
            if (startLine !== null) opts.anchor = startLine;
            else if (typeof args.anchor === 'string' && args.anchor.trim()) opts.anchor = args.anchor;
            if (typeof args.span === 'number') opts.span = args.span;
            const r = this.engine.locate(this.partnerDir, String(args.file ?? ''), opts) as {
              ok: boolean; file?: string; lines?: string; text?: string; error?: string;
            };
            // ---- 陈旧/移位校验（全在壳层，引擎签名不动）----
            // 只在文件 mtime > 索引 lastIndexedAt 时才跑（省一次读文件）。
            // 粗：staleSinceIndex 只说「文件改过」。
            // 准：在文件里按块首行文字重定位，回答「这一块现在到底在哪」——
            //     找不到=已删/大改；找到但行号变=移位并报出新行号（可自愈）。
            const normalizeLine = (s: string): string =>
              s.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')   // 去列表符号
               .replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '') // 去表格边
               .replace(/\s+/g, '')                     // 去所有空白
               .trim();
            const stale = (source: Record<string, unknown>): { staleSinceIndex?: boolean; blockMoved?: boolean; expectedLine?: number; actualLine?: number | null; warning?: string } => {
              const notes: string[] = [];
              const out: { staleSinceIndex?: boolean; blockMoved?: boolean; expectedLine?: number; actualLine?: number | null; warning?: string } = {};
              try {
                const idx = this.index;
                const relFile = String(args.file ?? '').replace(/\\/g, '/');
                const abs = join(this.partnerDir!, relFile);
                if (!idx?.stats?.lastIndexedAt || !existsSync(abs)) return out;
                // 只有文件建索引后改过才值得读
                const fileM = statSync(abs).mtimeMs;
                const idxT = Date.parse(idx.stats.lastIndexedAt);
                const changed = !Number.isNaN(idxT) && fileM > idxT;
                out.staleSinceIndex = changed;
                if (!changed) { out.blockMoved = false; return out; }
                notes.push('这份表比文件旧（文件在建索引后被改过），位置可能偏');
                // 找索引里对应的块（按 file + 行号范围/或首个落点）
                const anchorLine = typeof opts.anchor === 'number' ? opts.anchor : null;
                let blk = anchorLine !== null
                  ? idx.blocks.find(b => b.file === relFile && b.startLine <= anchorLine && b.endLine >= anchorLine)
                  : undefined;
                if (!blk) blk = idx.blocks.find(b => b.file === relFile);
                if (blk) {
                  out.expectedLine = blk.startLine;
                  const expectFirst = normalizeLine(blk.text.split('\n')[0]);
                  const curLines = readFileSync(abs, 'utf8').split(/\r?\n/);
                  // 在全文里找「整行去空白后完全等于块首行」的行
                  let foundAt = -1;
                  if (expectFirst) {
                    for (let i = 0; i < curLines.length; i++) {
                      if (normalizeLine(curLines[i]) === expectFirst) { foundAt = i + 1; break; }
                    }
                  }
                  out.actualLine = foundAt > 0 ? foundAt : null;
                  if (foundAt < 0) {
                    out.blockMoved = true;
                    notes.push(`这块已被删或大改（索引里的首行「${blk.text.split('\n')[0].trim().slice(0, 24)}」在文件里找不到了）`);
                  } else if (foundAt !== blk.startLine) {
                    out.blockMoved = true;
                    notes.push(`这块已移位：别再按第 ${blk.startLine} 行读，现在在第 ${foundAt} 行`);
                  } else {
                    out.blockMoved = false;
                  }
                }
              } catch { /* 校验失败不阻断，只是没提示 */ }
              if (notes.length) out.warning = notes.join('；');
              return out;
            };
            if (r && typeof r === 'object') {
              return JSON.stringify({ ...r, ...stale(r as Record<string, unknown>) }, null, 2);
            }
            return JSON.stringify(r, null, 2);
          } catch (e) {
            return { text: '翻不了 · ' + (e instanceof Error ? e.message : String(e)), failed: true };
          }
        },
      },
      {
        name: 'memo_link',
        description: '两种用法：①只给 file → 立刻重算这一个文件并落盘（我刚写完某个本子文件，用这个把它挂进图，不用全量重跑），返回该文件的块数和重建后的索引时间；②给 id，或 file+line → 看某一块的邻居（共现边），顺着记忆走。',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '本子内相对路径。只给 file（不给 line/id）= 单文件重算并落盘' },
            id: { type: 'number', description: 'block id（memo_index/recall 结果里带）' },
            line: { type: 'number', description: '配合 file 定位块所在行号' },
            limit: { type: 'number', description: '最多返回几个邻居，默认 10' },
          },
        },
        tags: ['write'],
        handler: async (args) => {
          if (!this.engine) return { text: '连不了 · 引擎没加载', failed: true };
          // 用法①：只给 file → 单文件重算
          const hasId = typeof args.id === 'number';
          const hasLine = typeof args.line === 'number';
          const hasFile = typeof args.file === 'string' && (args.file as string).trim() !== '';
          if (hasFile && !hasId && !hasLine) {
            if (!this.partnerDir) return { text: '重算不了 · 没找到本子目录', failed: true };
            try {
              // readonly 或无 indexDir：不落盘，只在内存里重建
              const noSave = this.readOnlyIndex || !this.indexDir;
              const r = this.engine.rebuildFile(this.indexDir ?? '', this.partnerDir, String(args.file), { ...this.scanOpts(), noSave });
              if (!r.ok || !r.index) return { text: '重算失败 · ' + (r.error ?? '未知'), failed: true };
              this.index = r.index;
              const at = r.index.stats?.lastIndexedAt ?? '?';
              const savedNote = noSave ? ' · 只读不落盘' : '';
              return `已重算 ${r.file} · 该文件块${r.fileBlocks} · 全库块${r.index.blocks.length} 边${r.index.edges.length} · indexedAt=${at}${savedNote}`;
            } catch (e) {
              return { text: '重算失败 · ' + (e instanceof Error ? e.message : String(e)), failed: true };
            }
          }
          // 用法②：看邻居
          try {
            const idx = this.ensureIndex();
            let id = hasId ? (args.id as number) : -1;
            if (id < 0 && hasFile && hasLine) {
              const hit = idx.blocks.find(b => b.file === args.file && b.startLine <= (args.line as number) && b.endLine >= (args.line as number));
              if (hit) id = hit.id;
            }
            if (id < 0) return { text: '找不到要连的块：给 id 或 file+line（只给 file 则做单文件重算）', failed: true };
            const byId = new Map(idx.blocks.map(b => [b.id, b]));
            const limit = typeof args.limit === 'number' ? args.limit : 10;
            const neighbors: Array<Record<string, unknown>> = [];
            for (const e of idx.edges) {
              let other: number;
              if (e.from === id) other = e.to;
              else if (e.to === id) other = e.from;
              else continue;
              const b = byId.get(other);
              if (!b) continue;
              neighbors.push({ id: b.id, file: b.file, anchor: b.anchor, startLine: b.startLine, endLine: b.endLine, weight: e.weight, snippet: b.text.slice(0, 80).replace(/\n/g, ' ') });
            }
            neighbors.sort((a, b) => (b.weight as number) - (a.weight as number));
            const self = byId.get(id);
            return JSON.stringify({ indexedAt: idx.stats?.lastIndexedAt ?? '?', self: self ? { id: self.id, file: self.file, anchor: self.anchor, startLine: self.startLine, endLine: self.endLine } : null, neighbors: neighbors.slice(0, limit) }, null, 2);
          } catch (e) {
            return { text: '连不了 · ' + (e instanceof Error ? e.message : String(e)), failed: true };
          }
        },
      },
    ];
  }
}

export function memoDefinition(): WorldDefinition<MemoConfigSection> {
  return {
    id: MEMO_ID,
    get label() {
      return '记忆指路（本地版）';
    },
    defaults: () => structuredClone(MEMO_DEFAULTS),
    create: (ctx: WorldContext<MemoConfigSection>) =>
      new MemoWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, botDir: ctx.botDir }),
  } as WorldDefinition<MemoConfigSection>;
}

export const MEMO = memoDefinition();
export default MEMO;
