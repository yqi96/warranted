#!/usr/bin/env bun
/**
 * Toulmin MCP Server — 入口文件
 *
 * 启动 MCP Server，注册 12 个论证管理工具。
 * 通过 stdio 与 Agent 通信。
 *
 * Usage:
 *   bun src/index.ts [--db-path ./toulmin.db]
 *
 * 默认数据库路径：.toulmin/argument.db（项目目录下，支持跨 Session 恢复）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.ts";
import { registerTools } from "./tools.ts";
import { mkdirSync } from "fs";
import { dirname } from "path";

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
// 主函数
// =============================================================================

async function main() {
  const { dbPath } = parseArgs();

  // 确保数据库目录存在（文件数据库时）
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
  }

  // 打开数据库
  const db = openDatabase(dbPath);
  console.error(`[Toulmin MCP] Database opened: ${dbPath}`);

  // 创建 MCP Server
  const server = new McpServer({
    name: "toulmin-mcp",
    version: "0.1.0",
  });

  // 注册工具
  registerTools(server, db);
  console.error("[Toulmin MCP] 12 tools registered");

  // 连接 stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Toulmin MCP] Server started on stdio");

  // 优雅关闭
  const shutdown = () => {
    console.error("[Toulmin MCP] Shutting down...");
    server.close().then(() => {
      db.close();
      console.error("[Toulmin MCP] Database closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[Toulmin MCP] Fatal error:", err);
  process.exit(1);
});
