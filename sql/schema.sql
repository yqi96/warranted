-- =============================================================================
-- Warranted — SQLite Schema (reference only)
--
-- NOTE: src/db.ts:initializeSchema() is authoritative. This file is
-- documentation-only and is NOT executed at runtime. Keep it in sync manually.
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL CHECK(type IN ('claim','statement','warrant')),
    content    TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

CREATE INDEX IF NOT EXISTS idx_nodes_warrant_claim ON nodes(
    CAST(json_extract(data, '$.claim_id') AS INTEGER)
) WHERE type = 'warrant';

-- Compile state per claim
CREATE TABLE IF NOT EXISTS compile_state (
    claim_id       INTEGER PRIMARY KEY,
    verdict        TEXT    NOT NULL DEFAULT 'passed',
    summary        TEXT    NOT NULL DEFAULT '',
    node_hashes    TEXT    NOT NULL DEFAULT '{}',
    argument_hash  TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Grounds for a warrant (statement or claim nodes)
CREATE TABLE IF NOT EXISTS warrant_grounds (
    warrant_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    ground_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (warrant_id, ground_id)
);

-- Backing statements for a warrant
CREATE TABLE IF NOT EXISTS warrant_backings (
    warrant_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    statement_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (warrant_id, statement_id)
);

-- Rebuttal targets: a statement rebuts a claim or warrant
CREATE TABLE IF NOT EXISTS rebuttal_targets (
    statement_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_type  TEXT    NOT NULL CHECK(target_type IN ('claim','warrant')),
    PRIMARY KEY (statement_id, target_id, target_type)
);

CREATE INDEX IF NOT EXISTS idx_rebuttal_targets_target ON rebuttal_targets(target_id, target_type);
