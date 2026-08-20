/**
 * Warranted — Schema(唯一事实源)
 *
 * 本体:一个命题 + 五个槽位(content / evidence / warrant / rebuttal / qualifier),
 * 见 docs/design.md §1.2。旧的 3 节点模型(nodes / compile_state / warrant_grounds /
 * warrant_backings / rebuttal_targets / tags)已断代,不迁移(§5.2)。
 *
 * 这里是 schema 的**唯一**副本。旧仓库有两份(`src/db.ts` 内联 + `sql/schema.sql`),
 * 靠注释互相提醒"保持同步"——那是一条必然漂移的路径,已删。需要建库的地方
 * (含 tests/agent-eval)一律 import 本模块或调 `initializeSchema`。
 */

/** qualifier 的五档有序标尺(design.md §1.2)。数组顺序即强度顺序,不要重排。 */
export const QUALIFIERS = [
  "refuted",
  "unestablished",
  "possibly",
  "probably",
  "certainly",
] as const;

export type Qualifier = (typeof QUALIFIERS)[number];

/** 正向三档:反驳要有攻击力,自己必须落在这三档之内(design.md §3.1)。 */
export const POSITIVE_QUALIFIERS: readonly Qualifier[] = [
  "possibly",
  "probably",
  "certainly",
];

/** 事件流的操作类型(design.md §3.1c)。 */
export const EVENT_OPS = [
  "create",
  "update",
  "delete",
  "qualifier",
  "promote",
  "review",
  "dismiss",
] as const;

export type EventOp = (typeof EVENT_OPS)[number];

/** 归因。`human` 在 visualizer 写入通道落地前不会实际产出(design.md §5.1)。 */
export const EVENT_ACTORS = ["tool", "human", "system"] as const;

export type EventActor = (typeof EVENT_ACTORS)[number];

/** 基线里一条引用扮演的角色。 */
export const REF_ROLES = ["evidence", "rebuttal", "warrant"] as const;

export type RefRole = (typeof REF_ROLES)[number];

const qualifierCheck = QUALIFIERS.map((q) => `'${q}'`).join(",");
const opCheck = EVENT_OPS.map((o) => `'${o}'`).join(",");
const actorCheck = EVENT_ACTORS.map((a) => `'${a}'`).join(",");
const refRoleCheck = REF_ROLES.map((r) => `'${r}'`).join(",");

/** 本体版本标识。写进 schema_meta,供开库时识别旧库(§5.2 断代)。 */
export const ONTOLOGY_VERSION = "proposition-v1";

/**
 * 核心表。可重复执行(全部 IF NOT EXISTS)。
 * FTS5 虚表与触发器不在这里 —— 它可能在缺少 FTS5 的 SQLite 上抛错,单独 try 包住。
 */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- ---------------------------------------------------------------------------
  -- 命题:唯一的节点类型
  -- ---------------------------------------------------------------------------
  --
  -- 理由(warrant)两种形态互斥(design.md §1.2):内联文本、或指向晋升后的命题。
  -- 两者同时非空是无意义状态(读的时候不知道该信哪个),由 CHECK 挡住。
  -- 两者同时为空合法 —— warrant 非空是结构检查的表内判据,不是入场券(V4 已取消)。
  --
  -- qualifier 默认 'unestablished':新建命题一律落此档,create 不接受 qualifier 入参。
  -- 这是基线"只有一个写入者"在数据层的对应物(design.md §3.1c)。
  CREATE TABLE IF NOT EXISTS propositions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT    NOT NULL,
    warrant_text    TEXT,
    warrant_node_id INTEGER REFERENCES propositions(id) ON DELETE SET NULL,
    qualifier       TEXT    NOT NULL DEFAULT 'unestablished'
                            CHECK (qualifier IN (${qualifierCheck})),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (warrant_text IS NULL OR warrant_node_id IS NULL)
  );

  CREATE INDEX IF NOT EXISTS idx_propositions_qualifier ON propositions(qualifier);

  -- ---------------------------------------------------------------------------
  -- 证据槽:附件与命题共用一个槽,分两张表存(design.md §1.2)
  -- ---------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS evidence_attachments (
    node_id  INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    path     TEXT    NOT NULL,
    added_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (node_id, path)
  );

  -- 挂进来的是引用不是副本。没有防自引用/防环的 CHECK:循环论证是审查器的
  -- 识别辅助(design.md §2.2),不是合同条款,做成 DB 约束就是把它升回成门。
  CREATE TABLE IF NOT EXISTS evidence_nodes (
    node_id     INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    evidence_id INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (node_id, evidence_id)
  );

  -- 反查:删一条命题时要知道谁在引用它(delete_proposition 的受影响清单)。
  CREATE INDEX IF NOT EXISTS idx_evidence_nodes_evidence ON evidence_nodes(evidence_id);

  -- ---------------------------------------------------------------------------
  -- 反驳槽:node_id 是被攻击的命题,rebuttal_id 是攻击它的命题
  -- ---------------------------------------------------------------------------
  -- 约定:node_id 永远是"拥有这个槽的命题",与 evidence_nodes 一致。
  -- 攻击内联理由时不在这里加特例列 —— 系统先把理由晋升成命题(§1.2),
  -- 反驳挂到晋升后的那条命题上,于是"攻击 content"和"攻击 warrant"在存储上同形。
  CREATE TABLE IF NOT EXISTS rebuttals (
    node_id     INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    rebuttal_id INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (node_id, rebuttal_id)
  );

  CREATE INDEX IF NOT EXISTS idx_rebuttals_rebuttal ON rebuttals(rebuttal_id);

  -- ---------------------------------------------------------------------------
  -- I8 事件流:append-only,永不更新、永不删除(design.md §3.1c)
  -- ---------------------------------------------------------------------------
  --
  -- node_id **没有外键**,这是有意的:删除一条命题时,那条 delete 事件(载荷是整节点
  -- before 快照)就是墓碑,它必须在节点消失之后继续存在。加了 FK 墓碑会跟着被删,
  -- 等于"删除即抹除",正是 design.md §0 要消灭的东西。
  --
  -- 列名 actor 而不是 by:BY 在 SQL 里是保留字,每次都要加引号。对外(get_history)
  -- 这个字段的名字是 by,映射发生在读取层。
  --
  -- target_key:dismiss 事件驳回的对象(警告 id 或 finding id)。"已阅"状态就是
  -- "事件流里有没有同 target_key 的 dismiss 事件"算出来的,不存可变状态表(§5)。
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id    INTEGER,
    op         TEXT    NOT NULL CHECK (op IN (${opCheck})),
    actor      TEXT    NOT NULL CHECK (actor IN (${actorCheck})),
    payload    TEXT    NOT NULL DEFAULT '{}',
    note       TEXT,
    target_key TEXT,
    at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id, id);
  CREATE INDEX IF NOT EXISTS idx_events_op ON events(op, id);
  CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_key)
    WHERE target_key IS NOT NULL;

  -- ---------------------------------------------------------------------------
  -- findings:review 事件载荷的**派生索引**,不是第二份事实源
  -- ---------------------------------------------------------------------------
  --
  -- 权威记录是 events 里那条 review 事件的 payload;本表只为"按 node_id 取未处理
  -- finding"提供索引,整表可从事件流重建。所以它跟着命题 CASCADE 删除不违反
  -- I8 的"永不删除"—— 被删的是索引行,历史仍在事件流里。
  --
  -- **没有 status 列**:未处理 / 已阅由有没有同 id 的 dismiss 事件算出来
  -- (design.md §2.2 / api.md §4.1)。加一列 status 就破了 I8 的"永不更新"。
  CREATE TABLE IF NOT EXISTS findings (
    id              TEXT    PRIMARY KEY,
    review_event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    node_id         INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    question        TEXT    NOT NULL CHECK (question IN ('Q1','Q2')),
    confidence      TEXT    NOT NULL CHECK (confidence IN ('high','low')),
    content         TEXT    NOT NULL,
    citation        TEXT    NOT NULL,
    at              TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_findings_node ON findings(node_id);

  -- ---------------------------------------------------------------------------
  -- 基线:设 qualifier 那一刻的快照(design.md §3.1c)
  -- ---------------------------------------------------------------------------
  --
  -- self_fingerprint 是判断当时**本命题自身**的指纹(content + warrant + 证据成员
  -- 清单 + 反驳成员清单),对应重查触发条件①;baseline_refs 是当时每个直接引用的
  -- (content hash, qualifier),对应触发条件②。
  --
  -- 只有 set_qualifier 写这两张表。这是接口面的硬约束:create / update 都不接受
  -- qualifier 入参,否则出现第二个写入者,基线就退化成旧 compile_state 那种谎话。
  CREATE TABLE IF NOT EXISTS baseline_head (
    node_id          INTEGER PRIMARY KEY REFERENCES propositions(id) ON DELETE CASCADE,
    qualifier        TEXT    NOT NULL CHECK (qualifier IN (${qualifierCheck})),
    self_fingerprint TEXT    NOT NULL,
    at               TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ref_id **没有外键**,这也是有意的:基线是历史快照,引用的命题被删之后这一行
  -- 必须留下 —— 判据"每条直接引用的命题存在"正是靠"基线里有、图里没有"才成立。
  -- 加了 FK 这一行会跟着消失,于是"证据被删掉了"变成查不出来的事。
  CREATE TABLE IF NOT EXISTS baseline_refs (
    node_id      INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
    ref_id       INTEGER NOT NULL,
    ref_role     TEXT    NOT NULL CHECK (ref_role IN (${refRoleCheck})),
    content_hash TEXT    NOT NULL,
    qualifier    TEXT    NOT NULL CHECK (qualifier IN (${qualifierCheck})),
    PRIMARY KEY (node_id, ref_id, ref_role)
  );
`;

/** FTS5 虚表。与 propositions.content 同步,trigram 分词(支持中文子串检索)。 */
export const FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS propositions_fts USING fts5(
    content, content='propositions', content_rowid='id', tokenize='trigram'
  );
`;

/** FTS5 同步触发器。外部内容表(content=)必须靠触发器维护,否则索引与表漂移。 */
export const FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS propositions_fts_ai AFTER INSERT ON propositions BEGIN
    INSERT INTO propositions_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS propositions_fts_ad AFTER DELETE ON propositions BEGIN
    INSERT INTO propositions_fts(propositions_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS propositions_fts_au
  AFTER UPDATE OF content ON propositions BEGIN
    INSERT INTO propositions_fts(propositions_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    INSERT INTO propositions_fts(rowid, content) VALUES (new.id, new.content);
  END;
`;

/** 旧本体的表名。开库时命中任意一张即判定为旧库,拒绝在其上建新 schema。 */
export const LEGACY_TABLES = [
  "nodes",
  "compile_state",
  "warrant_grounds",
  "warrant_backings",
  "rebuttal_targets",
  "tags",
  "node_tags",
  "tag_namespaces",
] as const;
