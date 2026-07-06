-- =============================================================================
-- Toulmin MCP — SQLite Schema
--
-- 单表 nodes + JSON data 列设计：
-- - 公共字段 (id, type, content, timestamps) 直接是列，可索引
-- - 类型特有字段存储在 data JSON 中，用 json_extract() 按需查询
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL CHECK(type IN ('claim','ground','warrant','backing','rebuttal')),
    content    TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 按类型查询
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

-- Warrant 按 claim_id 查询（data JSON 中提取）
CREATE INDEX IF NOT EXISTS idx_nodes_warrant_claim ON nodes(
    CAST(json_extract(data, '$.claim_id') AS INTEGER)
) WHERE type = 'warrant';

-- Backing 按 warrant_id 查询
CREATE INDEX IF NOT EXISTS idx_nodes_backing_warrant ON nodes(
    CAST(json_extract(data, '$.warrant_id') AS INTEGER)
) WHERE type = 'backing';

-- Rebuttal 按 target_id 查询
CREATE INDEX IF NOT EXISTS idx_nodes_rebuttal_target ON nodes(
    CAST(json_extract(data, '$.target_id') AS INTEGER)
) WHERE type = 'rebuttal';

-- Ground 按 ref_claim_id 查询（链式推理）
CREATE INDEX IF NOT EXISTS idx_nodes_ground_ref_claim ON nodes(
    CAST(json_extract(data, '$.ref_claim_id') AS INTEGER)
) WHERE type = 'ground' AND json_extract(data, '$.ref_claim_id') IS NOT NULL;
