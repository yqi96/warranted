/**
 * Warranted 可视化引擎 — HTTP 服务器
 *
 * 提供 JSON API 读取 graph.db，供前端 D3.js v7 渲染。
 *
 * 本体是"一个命题 + 五槽位"(docs/design.md §1.2)：图里只有一种节点，边全部由
 * 槽位成员关系派生。旧的 3 节点模型(claim / warrant / statement + compile_state)
 * 已断代，这里不做兼容读取 —— 旧库连 `openDatabase` 都过不去(§5.2)。
 *
 * 视觉编码随之整体位移：**颜色不再表示"是什么类型"，而是表示 qualifier 落在哪一档**。
 * 这不是配色偏好。旧图里节点类型是它的身份，一个 ground 永远是 ground；新本体里
 * 命题的身份只有一条 content，唯一会变、且唯一值得一眼看出来的是它挣到了什么档位。
 *
 * Usage:
 *   bun visualizer/server.ts [--db-path ./toulmin.db]
 */

import { openDatabase, DEFAULT_DB_PATH } from "../src/db.ts";
import { mkdirSync, existsSync, watch as fsWatch } from "fs";
import { dirname, join, resolve } from "path";
import type { Database } from "bun:sqlite";
import type {
  PropositionRow,
  Qualifier,
  WarrantSlot,
  CheckCode,
} from "../src/types.ts";
import { QUALIFIERS } from "../src/schema.ts";
import * as repo from "../src/repo.ts";
import * as service from "../src/service.ts";
import {
  checkContext,
  computeWarningsFor,
  loadNodeState,
  warrantSlotOf,
  type CheckContext,
} from "../src/structural-check.ts";

// =============================================================================
// CLI 参数解析
// =============================================================================

const DEFAULT_PORT = 3456;

function parseArgs(): { dbPath: string; port: number } {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB_PATH;
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db-path" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    } else if (args[i] === "--port" && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) port = parsed;
      i++;
    }
  }

  return { dbPath: resolve(dbPath), port };
}

function parseQualifiers(raw: string | null): Qualifier[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Qualifier => (QUALIFIERS as readonly string[]).includes(s));
  return wanted.length > 0 ? wanted : undefined;
}

// =============================================================================
// 图数据构建
// =============================================================================

interface GraphNode {
  id: number;
  content: string;
  qualifier: Qualifier;
  warrant: WarrantSlot;
  attachments: string[];
  evidence: number[];
  rebuttals: number[];
  /** 未处理/已阅的计数与判据编号。图上只画"有没有"，明细在 /viz/nodes/:id。 */
  warnings: { pending: number; acknowledged: number; codes: CheckCode[] };
  findings: { pending: number; acknowledged: number };
  created_at: string;
  updated_at: string;
}

/**
 * 边的方向统一为**被引用者 → 拥有槽位者**：source 是被挂进去的那条命题，
 * target 是槽位的主人。三种边对应三个可以指向别的命题的槽。
 */
type EdgeType = "evidence" | "rebuts" | "warrants";

interface GraphEdge {
  id: string;
  source: number;
  target: number;
  type: EdgeType;
}

function buildGraph(
  db: Database,
  ctx: CheckContext
): { nodes: GraphNode[]; edges: GraphEdge[]; stats: Record<Qualifier, number>; total: number } {
  const rows = db
    .prepare("SELECT * FROM propositions ORDER BY id")
    .all() as PropositionRow[];
  const allIds = new Set(rows.map((r) => r.id));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const row of rows) {
    const state = loadNodeState(db, row.id)!;
    const warnings = computeWarningsFor(db, ctx, state);
    const findings = service.findingViews(db, row.id);

    nodes.push({
      id: row.id,
      content: row.content,
      qualifier: row.qualifier,
      warrant: warrantSlotOf(row),
      attachments: state.attachments,
      evidence: state.evidenceNodes,
      rebuttals: state.rebuttals,
      warnings: {
        pending: warnings.filter((w) => w.state === "pending").length,
        acknowledged: warnings.filter((w) => w.state === "acknowledged").length,
        codes: [...new Set(warnings.filter((w) => w.state === "pending").map((w) => w.code))],
      },
      findings: {
        pending: findings.filter((f) => f.state === "pending").length,
        acknowledged: findings.filter((f) => f.state === "acknowledged").length,
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
    });

    for (const eid of state.evidenceNodes) {
      if (allIds.has(eid)) {
        edges.push({ id: `e_${eid}_${row.id}_evidence`, source: eid, target: row.id, type: "evidence" });
      }
    }
    for (const rid of state.rebuttals) {
      if (allIds.has(rid)) {
        edges.push({ id: `e_${rid}_${row.id}_rebuts`, source: rid, target: row.id, type: "rebuts" });
      }
    }
    if (state.warrant.kind === "promoted" && allIds.has(state.warrant.node_id)) {
      const wid = state.warrant.node_id;
      edges.push({ id: `e_${wid}_${row.id}_warrants`, source: wid, target: row.id, type: "warrants" });
    }
  }

  const stats = Object.fromEntries(QUALIFIERS.map((q) => [q, 0])) as Record<Qualifier, number>;
  for (const [q, n] of Object.entries(repo.countByQualifier(db))) {
    stats[q as Qualifier] = n;
  }

  return { nodes, edges, stats, total: rows.length };
}

// =============================================================================
// HTTP 服务器
// =============================================================================

const { dbPath: initialDbPath, port: listenPort } = parseArgs();

// 确保数据库目录存在
if (initialDbPath !== ":memory:") {
  const dir = dirname(initialDbPath);
  mkdirSync(dir, { recursive: true });
}

let db = openDatabase(initialDbPath);
let ctx = checkContext(initialDbPath);
let currentDbPath = initialDbPath;
console.error(`[Warranted Viz] Database opened: ${initialDbPath}`);

// ── In-memory selection state (written by browser, read by hook) ──
interface SelectionNode { id: number; content: string; qualifier: string; }
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
    console.error(`[Warranted Viz] Broadcast '${event}' → ${sseClients.size} client(s)`);
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
    console.error(`[Warranted Viz] Watching: ${watchDir}`);
  } catch (e) {
    console.error(`[Warranted Viz] Watch failed (real-time sync unavailable):`, e);
  }
}

function switchDatabase(newPath: string) {
  db.close();
  if (currentWatcher) { currentWatcher.close(); currentWatcher = null; }
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }

  db = openDatabase(newPath);
  // ctx 必须跟着换：附件路径是相对项目根解析的，换库不换根等于拿旧根去查新库的
  // 附件，S2(附件不存在)会整片误报。
  ctx = checkContext(newPath);
  currentDbPath = newPath;
  startWatcher(dirname(newPath));
  console.error(`[Warranted Viz] Switched to: ${newPath}`);
  broadcastSSE("data_updated", { path: newPath });
}

startWatcher(dirname(initialDbPath));

const server = Bun.serve({
  port: listenPort,
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

      // API: 完整图数据（命题 + 三种槽位边 + 按档计数）
      if (path === "/viz/graph") {
        return Response.json(buildGraph(db, ctx), { headers: corsHeaders });
      }

      // API: 单条命题的完整视图（含警告与 finding 明细）
      if (path.startsWith("/viz/nodes/")) {
        const id = parseInt(path.split("/").pop()!);
        if (!Number.isInteger(id) || !repo.getProposition(db, id)) {
          return Response.json({ error: "Proposition not found" }, { status: 404, headers: corsHeaders });
        }
        return Response.json(service.propositionView(db, ctx, id), { headers: corsHeaders });
      }

      // API: 命题列表，可按 qualifier 过滤（?qualifier=possibly,probably）
      if (path === "/viz/nodes") {
        const qualifier = parseQualifiers(url.searchParams.get("qualifier"));
        const { rows, total } = repo.findPropositions(db, { qualifier, limit: 500 });
        return Response.json({ rows, total }, { headers: corsHeaders });
      }

      // API: 结算清单（红名单：未处理 finding、结构违规、缺失附件）
      if (path === "/viz/stats") {
        return Response.json(service.getStats(db, ctx), { headers: corsHeaders });
      }

      // API: 搜索
      if (path === "/viz/search") {
        const q = url.searchParams.get("q") || "";
        if (!q) {
          return Response.json({ rows: [], total: 0 }, { headers: corsHeaders });
        }
        const qualifier = parseQualifiers(url.searchParams.get("qualifier"));
        const { rows, total } = repo.findPropositions(db, { query: q, qualifier, limit: 200 });
        return Response.json({ rows, total }, { headers: corsHeaders });
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

      // API: 切换监控目录（接收 .toulmin 目录路径或 graph.db 文件路径）
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
        const newDbPath = dir.endsWith(".db") ? dir : join(dir, "graph.db");
        if (!existsSync(newDbPath)) {
          return Response.json({ error: `File not found: ${newDbPath}` }, { status: 404, headers: corsHeaders });
        }
        try {
          switchDatabase(newDbPath);
        } catch (switchErr) {
          console.error("[Warranted Viz] switchDatabase failed:", switchErr);
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
      console.error("[Warranted Viz] Error:", err);
      return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders });
    }
  },
});

console.error(`[Warranted Viz] Server started on http://localhost:${server.port}`);
console.error(`[Warranted Viz] Press Ctrl+C to stop`);
