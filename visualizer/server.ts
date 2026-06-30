/**
 * Toulmin 可视化引擎 — HTTP 服务器
 *
 * 提供 JSON API 读取 argument.db，供前端 Cytoscape.js 渲染。
 *
 * Usage:
 *   bun visualizer/server.ts [--db-path ./toulmin.db]
 */

import { openDatabase, initializeSchema } from "../src/db.ts";
import { mkdirSync, writeFileSync, copyFileSync } from "fs";
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

  // 构建节点
  const nodes: GraphNode[] = filteredRows.map(r => ({
    id: r.id,
    type: r.type,
    content: r.content,
    data: repo.parseNodeData(r),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  // 构建边
  const edges: GraphEdge[] = [];

  for (const row of filteredRows) {
    const data = repo.parseNodeData(row);

    switch (row.type) {
      case "warrant": {
        // Warrant → Claim (supports)
        const claimId = data.claim_id as number;
        if (claimId && filteredIds.has(claimId)) {
          edges.push({ id: `e_${row.id}_${claimId}_supports`, source: row.id, target: claimId, type: "supports" });
        }
        // Warrant → Ground[] (based_on)
        const groundIds = (data.ground_ids || []) as number[];
        for (const gid of groundIds) {
          if (filteredIds.has(gid)) {
            edges.push({ id: `e_${row.id}_${gid}_based_on`, source: row.id, target: gid, type: "based_on" });
          }
        }
        break;
      }
      case "backing": {
        // Backing → Warrant (reinforces)
        const warrantId = data.warrant_id as number;
        if (warrantId && filteredIds.has(warrantId)) {
          edges.push({ id: `e_${row.id}_${warrantId}_reinforces`, source: row.id, target: warrantId, type: "reinforces" });
        }
        break;
      }
      case "qualifier": {
        // Qualifier → Claim (qualifies)
        const claimId = data.claim_id as number;
        if (claimId && filteredIds.has(claimId)) {
          edges.push({ id: `e_${row.id}_${claimId}_qualifies`, source: row.id, target: claimId, type: "qualifies" });
        }
        break;
      }
      case "rebuttal": {
        // Rebuttal → Claim/Warrant (challenges)
        const targetId = data.target_id as number;
        if (targetId && filteredIds.has(targetId)) {
          edges.push({ id: `e_${row.id}_${targetId}_challenges`, source: row.id, target: targetId, type: "challenges" });
        }
        break;
      }
      case "ground": {
        // Ground → Claim (derives_from, 链式推理)
        const refClaimId = data.ref_claim_id as number | null;
        if (refClaimId && filteredIds.has(refClaimId)) {
          edges.push({ id: `e_${row.id}_${refClaimId}_derives`, source: row.id, target: refClaimId, type: "derives_from" });
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

const { dbPath } = parseArgs();

// 确保数据库目录存在
if (dbPath !== ":memory:") {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
}

let db = openDatabase(dbPath);
console.error(`[Toulmin Viz] Database opened: ${dbPath}`);

// 获取 index.html 路径
const htmlPath = join(import.meta.dir, "index.html");

const server = Bun.serve({
  port: 3456,

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
      // API: 获取完整图数据
      if (path === "/api/graph") {
        const typesParam = url.searchParams.get("types");
        const typeFilter = typesParam ? typesParam.split(",").filter(Boolean) : undefined;
        const graph = buildGraph(db, typeFilter);
        return Response.json(graph, { headers: corsHeaders });
      }

      // API: 获取单个节点
      if (path.startsWith("/api/nodes/")) {
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
      if (path === "/api/nodes") {
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
      if (path === "/api/stats") {
        const stats = repo.countNodesByType(db);
        return Response.json(stats, { headers: corsHeaders });
      }

      // API: 搜索
      if (path === "/api/search") {
        const q = url.searchParams.get("q") || "";
        const typeParam = url.searchParams.get("type") as NodeType | null;
        if (!q) {
          return Response.json([], { headers: corsHeaders });
        }
        const nodes = repo.searchNodes(db, q, typeParam || undefined);
        return Response.json(nodes.map(n => ({ ...n, data: repo.parseNodeData(n) })), { headers: corsHeaders });
      }

      // API: 上传数据库文件（支持 .db + .db-wal + .db-shm 三文件集）
      if (path === "/api/upload" && req.method === "POST") {
        const formData = await req.formData();
        const files = formData.getAll("files") as File[];
        if (!files || files.length === 0) {
          return Response.json({ error: "No files provided" }, { status: 400, headers: corsHeaders });
        }

        // 找到主 .db 文件
        const mainFile = files.find(f => f.name.endsWith(".db") || f.name.endsWith(".sqlite"));
        if (!mainFile) {
          return Response.json({ error: "No .db or .sqlite file found" }, { status: 400, headers: corsHeaders });
        }

        // 关闭当前数据库
        db.close();

        // 保存所有上传的文件
        for (const file of files) {
          let targetName = file.name;
          // 标准化文件名
          if (file.name.endsWith("-wal")) targetName = dbPath + "-wal";
          else if (file.name.endsWith("-shm")) targetName = dbPath + "-shm";
          else targetName = dbPath;

          const buffer = await file.arrayBuffer();
          writeFileSync(targetName, Buffer.from(buffer));
          console.error(`[Toulmin Viz] Saved: ${targetName} (${buffer.byteLength} bytes)`);
        }

        // 打开数据库，checkpoint WAL 合并数据到主文件
        try {
          const tempDb = new (await import("bun:sqlite")).Database(dbPath);
          tempDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          tempDb.close();
          console.error(`[Toulmin Viz] WAL checkpoint completed`);
        } catch (e) {
          console.error(`[Toulmin Viz] WAL checkpoint failed:`, e);
        }

        // 清理 WAL/SHM 文件（checkpoint 后数据已在主文件中）
        try {
          const { unlinkSync, existsSync } = await import("fs");
          if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
          if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
        } catch {}

        // 重新打开数据库
        db = openDatabase(dbPath);

        const stats = repo.countNodesByType(db);
        return Response.json({ success: true, filename: mainFile.name, fileCount: files.length, stats }, { headers: corsHeaders });
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
