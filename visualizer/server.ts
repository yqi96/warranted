/**
 * Toulmin 可视化引擎 — HTTP 服务器
 *
 * 提供 JSON API 读取 argument.db，供前端 D3.js v7 渲染。
 *
 * Usage:
 *   bun visualizer/server.ts [--db-path ./toulmin.db]
 */

import { openDatabase } from "../src/db.ts";
import { mkdirSync, existsSync, watch as fsWatch } from "fs";
import { dirname, join, resolve } from "path";
import type { Database } from "bun:sqlite";
import type { NodeRow, NodeType } from "../src/types.ts";
import * as repo from "../src/repo.ts";

// =============================================================================
// CLI 参数解析
// =============================================================================

const DEFAULT_DB_PATH = ".toulmin/argument.db";

function parseArgs(): { dbPath: string } {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db-path" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    }
  }

  return { dbPath: resolve(dbPath) };
}

// =============================================================================
// 角色语义
// =============================================================================

type Role = "ground" | "backing" | "rebuttal";

const ROLE_PRECEDENCE: Role[] = ["rebuttal", "backing", "ground"];

function pickPrimaryRole(roles: Set<Role>): Role {
  for (const role of ROLE_PRECEDENCE) {
    if (roles.has(role)) return role;
  }
  return "ground";
}

function computeRoleStats(db: Database): { ground: number; backing: number; rebuttal: number } {
  const statementIds = new Set(
    (db.prepare("SELECT id FROM nodes WHERE type = 'statement'").all() as Array<{ id: number }>).map(r => r.id)
  );

  const groundSet   = new Set<number>();
  const backingSet  = new Set<number>();
  const rebuttalSet = new Set<number>();

  for (const { ground_id } of db.prepare("SELECT ground_id FROM warrant_grounds").all() as Array<{ ground_id: number }>) {
    if (statementIds.has(ground_id)) groundSet.add(ground_id);
  }
  for (const { statement_id } of db.prepare("SELECT statement_id FROM warrant_backings").all() as Array<{ statement_id: number }>) {
    backingSet.add(statement_id);
  }
  for (const { statement_id } of db.prepare("SELECT DISTINCT statement_id FROM rebuttal_targets").all() as Array<{ statement_id: number }>) {
    rebuttalSet.add(statement_id);
  }

  return { ground: groundSet.size, backing: backingSet.size, rebuttal: rebuttalSet.size };
}

// =============================================================================
// 图数据构建
// =============================================================================

interface GraphNode {
  id: number;
  type: string;
  content: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface GraphEdge {
  id: string;
  source: number;
  target: number;
  type: string;
}

interface CompileStateRow {
  claim_id: number;
  verdict: string;
  summary: string;
  created_at: string;
}

function buildGraph(db: Database): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
  roleStats: { ground: number; backing: number; rebuttal: number };
} {
  const allRows = db.prepare("SELECT * FROM nodes ORDER BY id").all() as NodeRow[];
  const stats = repo.countNodesByType(db);

  // Build role sets for statement nodes
  const statementIds = new Set(allRows.filter(r => r.type === "statement").map(r => r.id));
  const roleMap = new Map<number, Set<Role>>();

  for (const { ground_id } of db.prepare("SELECT ground_id FROM warrant_grounds").all() as Array<{ ground_id: number }>) {
    if (statementIds.has(ground_id)) {
      if (!roleMap.has(ground_id)) roleMap.set(ground_id, new Set());
      roleMap.get(ground_id)!.add("ground");
    }
  }
  for (const { statement_id } of db.prepare("SELECT statement_id FROM warrant_backings").all() as Array<{ statement_id: number }>) {
    if (!roleMap.has(statement_id)) roleMap.set(statement_id, new Set());
    roleMap.get(statement_id)!.add("backing");
  }
  for (const { statement_id } of db.prepare("SELECT DISTINCT statement_id FROM rebuttal_targets").all() as Array<{ statement_id: number }>) {
    if (!roleMap.has(statement_id)) roleMap.set(statement_id, new Set());
    roleMap.get(statement_id)!.add("rebuttal");
  }

  // Role stats: each role counted independently (multi-role statement counts in each)
  const roleStats = { ground: 0, backing: 0, rebuttal: 0 };
  for (const [, roles] of roleMap) {
    if (roles.has("ground"))   roleStats.ground++;
    if (roles.has("backing"))  roleStats.backing++;
    if (roles.has("rebuttal")) roleStats.rebuttal++;
  }

  // Compile state
  const compileStateRows = db.prepare("SELECT claim_id, verdict, summary, created_at FROM compile_state").all() as CompileStateRow[];
  const compileStateMap = new Map(compileStateRows.map(s => [s.claim_id, s]));

  const allIds = new Set(allRows.map(r => r.id));

  // Build nodes
  const nodes: GraphNode[] = allRows.map(r => {
    const data = repo.parseNodeData(r) as Record<string, unknown>;
    if (r.type === "claim") {
      const cs = compileStateMap.get(r.id);
      data.compile_verdict   = cs?.verdict   ?? null;
      data.compile_summary   = cs?.summary   ?? null;
      data.compile_created_at = cs?.created_at ?? null;
    }
    if (r.type === "statement") {
      const roles = roleMap.get(r.id);
      data.roles        = roles ? [...roles] : [];
      data.primary_role = roles ? pickPrimaryRole(roles) : "ground";
    }
    return {
      id: r.id,
      type: r.type,
      content: r.content,
      data,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  // Build edges
  const edges: GraphEdge[] = [];

  for (const row of allRows) {
    const data = repo.parseNodeData(row);

    switch (row.type) {
      case "warrant": {
        const claimId = data.claim_id as number;
        if (claimId && allIds.has(claimId)) {
          edges.push({ id: `e_${claimId}_${row.id}_supports`, source: claimId, target: row.id, type: "supports" });
        }
        const groundLinks = db.prepare("SELECT ground_id FROM warrant_grounds WHERE warrant_id = ?").all(row.id) as Array<{ ground_id: number }>;
        for (const { ground_id: gid } of groundLinks) {
          if (allIds.has(gid)) {
            edges.push({ id: `e_${gid}_${row.id}_based_on`, source: gid, target: row.id, type: "based_on" });
          }
        }
        break;
      }
      case "statement": {
        const backingLinks = db.prepare("SELECT warrant_id FROM warrant_backings WHERE statement_id = ?").all(row.id) as Array<{ warrant_id: number }>;
        for (const { warrant_id: wid } of backingLinks) {
          if (allIds.has(wid)) {
            edges.push({ id: `e_${wid}_${row.id}_reinforces`, source: wid, target: row.id, type: "reinforces" });
          }
        }
        const rebuttalLinks = db.prepare("SELECT target_id FROM rebuttal_targets WHERE statement_id = ?").all(row.id) as Array<{ target_id: number }>;
        for (const { target_id: tid } of rebuttalLinks) {
          if (allIds.has(tid)) {
            edges.push({ id: `e_${tid}_${row.id}_challenges`, source: tid, target: row.id, type: "challenges" });
          }
        }
        break;
      }
    }
  }

  return { nodes, edges, stats, roleStats };
}

// =============================================================================
// HTTP 服务器
// =============================================================================

const { dbPath: initialDbPath } = parseArgs();

// 确保数据库目录存在
if (initialDbPath !== ":memory:") {
  const dir = dirname(initialDbPath);
  mkdirSync(dir, { recursive: true });
}

let db = openDatabase(initialDbPath);
let currentDbPath = initialDbPath;
console.error(`[Toulmin Viz] Database opened: ${initialDbPath}`);

// ── In-memory selection state (written by browser, read by hook) ──
interface SelectionNode { id: number; type: string; content: string; roles?: string[]; }
let currentSelection: { ids: number[]; nodes: SelectionNode[] } = { ids: [], nodes: [] };

// 获取 index.html 路径
const htmlPath = join(import.meta.dir, "index.html");

// =============================================================================
// SSE 实时推送
// =============================================================================

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

function broadcastSSE(event: string, data: Record<string, unknown> = {}) {
  const msg = sseEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of [...sseClients]) {
    try {
      ctrl.enqueue(msg);
    } catch {
      sseClients.delete(ctrl);
    }
  }
  if (sseClients.size > 0) {
    console.error(`[Toulmin Viz] Broadcast '${event}' → ${sseClients.size} client(s)`);
  }
}

// =============================================================================
// 文件监听 & 数据库切换
// =============================================================================

let watchDebounce: ReturnType<typeof setTimeout> | null = null;
let currentWatcher: ReturnType<typeof fsWatch> | null = null;

function startWatcher(watchDir: string) {
  try {
    currentWatcher = fsWatch(watchDir, (_event, filename) => {
      if (filename && !filename.endsWith(".db") && !filename.endsWith(".db-wal") && !filename.endsWith(".db-shm")) return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => broadcastSSE("data_updated"), 300);
    });
    console.error(`[Toulmin Viz] Watching: ${watchDir}`);
  } catch (e) {
    console.error(`[Toulmin Viz] Watch failed (real-time sync unavailable):`, e);
  }
}

function switchDatabase(newPath: string) {
  db.close();
  if (currentWatcher) { currentWatcher.close(); currentWatcher = null; }
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }

  db = openDatabase(newPath);
  currentDbPath = newPath;
  startWatcher(dirname(newPath));
  console.error(`[Toulmin Viz] Switched to: ${newPath}`);
  broadcastSSE("data_updated", { path: newPath });
}

startWatcher(dirname(initialDbPath));

const server = Bun.serve({
  port: 3456,
  idleTimeout: 255,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // SSE: 实时事件推送
      if (path === "/viz/events") {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        let heartbeat: ReturnType<typeof setInterval>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            sseClients.add(ctrl);
            ctrl.enqueue(sseEncoder.encode(`event: connected\ndata: {}\n\n`));
            heartbeat = setInterval(() => {
              try { ctrl.enqueue(sseEncoder.encode(":\n\n")); }
              catch { clearInterval(heartbeat); sseClients.delete(ctrl); }
            }, 5000);
          },
          cancel() {
            clearInterval(heartbeat);
            sseClients.delete(ctrl);
          },
        });
        req.signal?.addEventListener("abort", () => {
          clearInterval(heartbeat);
          sseClients.delete(ctrl);
        });
        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // API: 获取完整图数据（含角色注释）
      if (path === "/viz/graph") {
        const graph = buildGraph(db);
        return Response.json(graph, { headers: corsHeaders });
      }

      // API: 获取单个节点
      if (path.startsWith("/viz/nodes/")) {
        const id = parseInt(path.split("/").pop()!);
        const node = repo.getNodeById(db, id);
        if (!node) {
          return Response.json({ error: "Node not found" }, { status: 404, headers: corsHeaders });
        }
        return Response.json({
          ...node,
          data: repo.parseNodeData(node),
        }, { headers: corsHeaders });
      }

      // API: 获取节点列表
      if (path === "/viz/nodes") {
        const typeParam = url.searchParams.get("type") as NodeType | null;
        let nodes: NodeRow[];
        if (typeParam) {
          nodes = repo.listNodesByType(db, typeParam);
        } else {
          nodes = db.prepare("SELECT * FROM nodes ORDER BY id").all() as NodeRow[];
        }
        return Response.json(nodes.map(n => ({ ...n, data: repo.parseNodeData(n) })), { headers: corsHeaders });
      }

      // API: 统计（含角色统计）
      if (path === "/viz/stats") {
        const stats = repo.countNodesByType(db);
        const roleStats = computeRoleStats(db);
        return Response.json({ ...stats, roleStats }, { headers: corsHeaders });
      }

      // API: 搜索
      if (path === "/viz/search") {
        const q = url.searchParams.get("q") || "";
        const typeParam = url.searchParams.get("type") as NodeType | null;
        if (!q) {
          return Response.json([], { headers: corsHeaders });
        }
        const nodes = repo.searchNodes(db, q, typeParam || undefined);
        return Response.json(nodes.rows.map(n => ({ ...n, data: repo.parseNodeData(n) })), { headers: corsHeaders });
      }

      // API: 查询当前监控路径
      if (path === "/viz/current-db") {
        return Response.json({ dir: dirname(currentDbPath), path: currentDbPath }, { headers: corsHeaders });
      }

      // API: 获取当前选中节点
      if (path === "/viz/selection" && req.method === "GET") {
        return Response.json(currentSelection, { headers: corsHeaders });
      }

      // API: 更新选中节点（由浏览器 POST）
      if (path === "/viz/selection" && req.method === "POST") {
        let body: { ids?: number[]; nodes?: SelectionNode[] };
        try {
          body = await req.json() as { ids?: number[]; nodes?: SelectionNode[] };
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
        }
        currentSelection = { ids: body.ids || [], nodes: body.nodes || [] };
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // API: 切换监控目录（接收 .toulmin 目录路径或 argument.db 文件路径）
      if (path === "/viz/switch-db" && req.method === "POST") {
        let body: { dir?: string };
        try {
          body = await req.json() as { dir?: string };
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
        }
        const { dir } = body;
        if (!dir) {
          return Response.json({ error: "Missing 'dir' field" }, { status: 400, headers: corsHeaders });
        }
        const newDbPath = dir.endsWith("argument.db") ? dir : join(dir, "argument.db");
        if (!existsSync(newDbPath)) {
          return Response.json({ error: `File not found: ${newDbPath}` }, { status: 404, headers: corsHeaders });
        }
        try {
          switchDatabase(newDbPath);
        } catch (switchErr) {
          console.error("[Toulmin Viz] switchDatabase failed:", switchErr);
          return Response.json({ error: `Switch failed: ${String(switchErr)}` }, { status: 500, headers: corsHeaders });
        }
        return Response.json({ success: true, path: newDbPath }, { headers: corsHeaders });
      }

      // 静态文件: index.html + css/js assets
      if (path === "/" || path === "/index.html") {
        const file = Bun.file(htmlPath);
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }

      if (path.startsWith("/css/") || path.startsWith("/js/")) {
        const filePath = join(import.meta.dir, path);
        const file = Bun.file(filePath);
        if (await file.exists()) {
          const ext = path.split(".").pop();
          const mime = ext === "css" ? "text/css" : "application/javascript";
          return new Response(file, { headers: { "Content-Type": mime } });
        }
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("[Toulmin Viz] Error:", err);
      return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders });
    }
  },
});

console.error(`[Toulmin Viz] Server started on http://localhost:${server.port}`);
console.error(`[Toulmin Viz] Press Ctrl+C to stop`);
