# 记忆指路（Memo Router）· 本地记忆图扩展

给 Cortico / Coopanion 用的 **World 扩展**：把你的一堆 Markdown 笔记（「本子」）切成记忆块、建成一张共现边图，让 agent 能用一句话**联想召回**到相关段落——不只是字面搜到，而是顺着稀有词走到字面不重合的地方。

五个工具：`memo_index` / `memo_recall` / `memo_grep` / `memo_locate` / `memo_link`。

---

## 它为什么存在

- **全读装不下。** 本子到十万字以后，每轮读一遍不是慢，是放不进去。
- **关键字搜太脆。** 搜得到的前提是你还记得原话怎么说；可你想起来一个词，往往是因为那个词稀有，它把你带到一段表面上毫无重合的话里。
- **让模型自己回忆就是编。** 没有出处的那部分，它会补得比真的还像。

结果是一种很难看的状态：**记得越多，越等于没记。** 这个扩展要解决的就是这个。

---

## ⚠️ 已知限制（先读这个，再决定要不要用）

这是一把**标了刻度的尺子**：它能干什么、不能干什么，都写在下面。请先确认这些限制你能接受。

1. **单文件重算很慢（~5–7 秒），和全量差不多。** `memo_link {file}` 只重切那一个文件，但**建图仍是全量**（top-K 建边就是全量计算）。省掉的只有其他文件的重读重切，量级上可忽略。**全量构建约 5.4 秒 / 1 万块量级**；这是「能用但慢」，不是增量百毫秒级。
2. **删了内容必须重算，否则 recall 会翻出幽灵。** `memo_recall` 返回的 snippet 是建索引时的**快照**，存在 `blocks.json` 里。你删掉原文、不重算，那条幽灵还在，直到 `memo_index(full)`。
3. **`memo_locate` 会给「陈旧/移位」提示，但最好还是重算。** 返回里带：
   - `staleSinceIndex`：文件在建索引后被改过（mtime > indexedAt）——**粗判**，只说明该复核；
   - `blockMoved` + `expectedLine`/`actualLine`：在文件里按块首行重定位，告诉你「**别再按第 X 行读，现在在第 Y 行**」——**准判**，能自愈。若块被删/大改，`actualLine=null` 并提示「已被删或大改」。
4. **测试用词别写进被索引的目录。** 想验证「库外词应该想不起」，用的词必须**从没进过本子**。你把负样本词写进笔记，它就真进库了，会被当成命中——这不是引擎的错，是负样本污染了自己。
5. **默认目录约定是猜的。** 见下方「目录约定」。不对就改配置，别硬套。
6. **文件数 / 字数超上限只会「警告」，不会拦。** 默认上限 5000 文件 / 500 万字；超了照常构建，但会很慢、很占内存。别人的本子可能是默认值的十倍大，建议先用 `excludeDirs` 缩范围。

---

## 装法（两条路：pnpm link / 手动建链接）

先在 `extensions` 目录（Cortico 的扩展安装目录，通常 `<部署>/data/extensions`）里做。下面两条路二选一。

**路一：pnpm `link:`（推荐）**
```bash
cd <部署>/data/extensions   # Windows 用 <部署>\data\extensions
# 在 package.json 的 dependencies 里加一行：
#   "cortico-world-memo": "link:<你 clone 下来的绝对路径>"
pnpm install --offline
```

**路二：手动建链接（不想动 pnpm 时用）**
直接在 `extensions/node_modules/` 下建一个链接指向本包目录，再在 `extensions/package.json` 的 `dependencies` 写同名条目 `"cortico-world-memo": "link:<本包绝对路径>"`。
- Windows 用 **junction（目录联接）**，普通权限即可、不需要管理员：
  `cmd /c mklink /J node_modules\cortico-world-memo <本包绝对路径>`
- Linux/mac 用**符号链接**：
  `ln -s <本包绝对路径> node_modules/cortico-world-memo`

装好后在部署的 `config.json` 里 `worlds` 段加：
```json
"cortico-world-memo": { "enabled": true }
```
**重启 Cortico / Coopanion** 后生效（改代码后同样要重启，内存里不会自动热更）。

---

## 第一次用：建索引

重启后，让 agent 调一次 `memo_index { mode: "full" }`。它会扫本子、切块、建图，在 `indexDir`（默认 `<dataDir>/memo-index/`）落 `blocks.json` + `graph.json`。

- 全量：约 5.4 秒 / 1.1 万块（你的本子越大越慢）。
- 之后重启会**自动从磁盘载入**上次索引，不用重跑全量。
- `memo_recall` 返回里第一行 `indexedAt` 就是「这份表是什么时候建的」。**表比它新写的东西就是没有的。**

---

## 目录约定（默认值，不对就改）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `partnerDir` | 自动猜：`<botDir>/workspace/partner` → `<botDir>/partner` → `<dataDir 同级>/workspace/partner` | 猜不到会明说「没找到本子，先告诉我在哪」。也可用环境变量 `MEMO_PARTNER_DIR`。 |
| `indexDir` | `<dataDir>/memo-index` | 索引落点。 |
| `indexMode` | `write` | `readonly`=只读不落盘（启动能载入已有索引，但不写；适合不想被写磁盘的场景）。 |
| `extensions` | `['.md']` | 收哪些后缀。 |
| `excludeDirs` | `['handoffs','archive','blobs','tools']` | 任意层级跳过的目录名。**这套是为原作者的本子分层定的，别人的目录结构未必一样——不对就自己改。** |
| `includeSubdirs` | `true` | 是否递归子目录。 |
| `maxFiles` | `5000` | 超过只警告不拦。 |
| `maxChars` | `5000000` | 超过只警告不拦。 |

配置写在部署 `config.json` 的 `worlds["cortico-world-memo"]` 段，例如：
```json
"cortico-world-memo": {
  "enabled": true,
  "partnerDir": "/home/me/notes",
  "indexMode": "readonly",
  "excludeDirs": ["archive", "tmp"]
}
```

---

## 工具速览

- **`memo_index { mode }`** — `full`=全量重建并落盘；`load`=只载入磁盘索引。
- **`memo_recall { query, k? }`** — 联想召回，返回 `indexedAt` + 命中段落（文件/小节/行号/片段/命中词/置信度）。想不起就说想不起（置信度 low）。
- **`memo_grep { query, limit? }`** — 字面精确搜（不是联想）。
- **`memo_locate { file, anchor?|line?, span? }`** — 点回原文那一行，带陈旧/移位校验。
- **`memo_link { file }`** — 单文件重算并落盘（写完笔记立刻挂上）；或 `{ id }` / `{ file, line }` 看某块的邻居。

---

## 设计要点（给想看内部的人）

- **切块按结构边界**（标题 / 列表项 / 表格行 / 空行），不按字数；字数只做兜底。每块都能反查回原文行。
- **key = 中文 2~4 字最长贪心 n-gram + 英文/数字整词**，去停用。最长匹配避免同一名字被 2~4gram 重复计 6 倍。
- **边权 = Σ IDF(key) = Σ 1/log(1+df)**。df 大的词自动降权（趋 0），不删——高频词往往是重要实体。
- **建边单位是「每块 top-K 邻居（K=60）」**，不是「每 key 连多少」。问的是「这一块跟谁最像」，天然压掉靠单个高频词沾上的假边。**不按 id 邻近、不封顶每 key 对数、不设 MIN_CO。**
- **有向选择、无向合并**：出度是我主动选的 60 个邻居，入度是别人选中我；枢纽块入度可很高，不砍（砍了毁连通性）。

---

## 许可

AGPL-3.0-or-later。私用/改造随意；若你基于它提供服务，按 AGPL 同样开源。
