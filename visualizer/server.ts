/**
 * Toulmin 可视化引擎 — HTTP 服务器
 *
 * 提供 JSON API 读取 argument.db，供前端 Cytoscape.js 渲染。
 *
 * Usage:
 *   bun visualizer/server.ts [--db-path ./toulmin.db]
 */

import { openDatabase } from "../src/db.ts";
import { mkdirSync, existsSync, watch as fsWatch } from "fs";
import { dirname, join } from "path";
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

  return { dbPath };
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

function buildGraph(db: Database, typeFilter?: string[]): { nodes: GraphNode[]; edges: GraphEdge[]; stats: Record<string, number> } {
  // 获取所有节点
  const allRows = db.prepare("SELECT * FROM nodes ORDER BY id").all() as NodeRow[];
  const stats = repo.countNodesByType(db);

  // 过滤
  let filteredRows = allRows;
  if (typeFilter && typeFilter.length > 0) {
    filteredRows = allRows.filter(r => typeFilter.includes(r.type));
  }

  const filteredIds = new Set(filteredRows.map(r => r.id));

  // 批量获取编译状态
  interface CompileStateRow {
    claim_id: number;
    verdict: string;
    summary: string;
    created_at: string;
  }
  const compileStateRows = db.prepare("SELECT claim_id, verdict, summary, created_at FROM compile_state").all() as CompileStateRow[];
  const compileStateMap = new Map(compileStateRows.map(s => [s.claim_id, s]));

  // 构建节点
  const nodes: GraphNode[] = filteredRows.map(r => {
    const data = repo.parseNodeData(r) as Record<string, unknown>;
    if (r.type === "claim") {
      const cs = compileStateMap.get(r.id);
      data.compile_verdict = cs?.verdict ?? null;
      data.compile_summary = cs?.summary ?? null;
      data.compile_created_at = cs?.created_at ?? null;
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

  // 构建边
  const edges: GraphEdge[] = [];

  for (const row of filteredRows) {
    const data = repo.parseNodeData(row);

    switch (row.type) {
      case "warrant": {
        // Claim → Warrant (supports): 推理规则支撑主张
        const claimId = data.claim_id as number;
        if (claimId && filteredIds.has(claimId)) {
          edges.push({ id: `e_${claimId}_${row.id}_supports`, source: claimId, target: row.id, type: "supports" });
        }
        // Ground → Warrant (based_on): 证据支撑推理规则
        const groundIds = (data.ground_ids || []) as number[];
        for (const gid of groundIds) {
          if (filteredIds.has(gid)) {
            edges.push({ id: `e_${gid}_${row.id}_based_on`, source: gid, target: row.id, type: "based_on" });
          }
        }
        break;
      }
      case "backing": {
        // Warrant → Backing (reinforces): 支撑推理规则
        const warrantId = data.warrant_id as number;
        if (warrantId && filteredIds.has(warrantId)) {
          edges.push({ id: `e_${warrantId}_${row.id}_reinforces`, source: warrantId, target: row.id, type: "reinforces" });
        }
        break;
      }
      case "rebuttal": {
        // Claim/Warrant → Rebuttal (challenges): 挑战主张或推理
        const targetId = data.target_id as number;
        if (targetId && filteredIds.has(targetId)) {
          edges.push({ id: `e_${targetId}_${row.id}_challenges`, source: targetId, target: row.id, type: "challenges" });
        }
        break;
      }
      case "ground": {
        // Warrant → Ground (derives_from, 链式推理): 上游 Claim 支撑下游 Ground
        const refClaimId = data.ref_claim_id as number | null;
        if (refClaimId && filteredIds.has(refClaimId)) {
          edges.push({ id: `e_${refClaimId}_${row.id}_derives`, source: refClaimId, target: row.id, type: "derives_from" });
        }
        break;
      }
    }
  }

  return { nodes, edges, stats };
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
      // macOS fs.watch sometimes gives null filename — still treat as a change
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

      // API: 获取完整图数据
      if (path === "/viz/graph") {
        const typesParam = url.searchParams.get("types");
        const typeFilter = typesParam ? typesParam.split(",").filter(Boolean) : undefined;
        const graph = buildGraph(db, typeFilter);
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

      // API: 统计
      if (path === "/viz/stats") {
        const stats = repo.countNodesByType(db);
        return Response.json(stats, { headers: corsHeaders });
      }

      // API: 搜索
      if (path === "/viz/search") {
        const q = url.searchParams.get("q") || "";
        const typeParam = url.searchParams.get("type") as NodeType | null;
        if (!q) {
          return Response.json([], { headers: corsHeaders });
        }
        const nodes = repo.searchNodes(db, q, typeParam || undefined);
        return Response.json(nodes.map(n => ({ ...n, data: repo.parseNodeData(n) })), { headers: corsHeaders });
      }

      // API: 查询当前监控路径
      if (path === "/viz/current-db") {
        return Response.json({ dir: dirname(currentDbPath), path: currentDbPath }, { headers: corsHeaders });
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
        // 兼容直接传 argument.db 路径
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

      // 静态文件: index.html
      if (path === "/" || path === "/index.html") {
        const file = Bun.file(htmlPath);
        return new Response(file, { headers: { "Content-Type": "text/html" } });
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
