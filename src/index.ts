#!/usr/bin/env bun
/**
 * Toulmin MCP Server — 入口文件
 *
 * 启动 MCP Server，注册 12 个论证管理工具。
 * 通过 stdio 与 Agent 通信。
 *
 * Usage:
 *   bun src/index.ts [--db-path ./toulmin.db] [--review-config ./review.json]
 *
 * 默认数据库路径：.toulmin/argument.db（项目目录下，支持跨 Session 恢复）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.ts";
import { registerTools } from "./tools.ts";
import type { Lifecycle } from "./tools.ts";
import { initLogger } from "./logger.ts";
import { loadReviewConfig } from "./review-config.ts";
import { mkdirSync } from "fs";
import { dirname } from "path";

// =============================================================================
// CLI 参数解析
// =============================================================================

const DEFAULT_DB_PATH = ".toulmin/argument.db";

function parseArgs(): { dbPath: string; reviewConfigPath: string | null } {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB_PATH;
  let reviewConfigPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db-path" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    } else if (args[i] === "--review-config" && args[i + 1]) {
      reviewConfigPath = args[i + 1];
      i++;
    }
  }

  return { dbPath, reviewConfigPath };
}

// =============================================================================
// 主函数
// =============================================================================

async function main() {
  const { dbPath, reviewConfigPath } = parseArgs();

  // 确保数据库目录存在（文件数据库时）
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
  }

  // 打开数据库
  const db = openDatabase(dbPath);
  console.error(`[Toulmin MCP] Database opened: ${dbPath}`);

  // 初始化操作日志（写入 .toulmin/ 目录下，与数据库同位置）
  if (dbPath !== ":memory:") {
    const logPath = dirname(dbPath) + "/operation.log";
    initLogger(logPath);
    console.error(`[Toulmin MCP] Operation log: ${logPath}`);
  }

  // 创建 MCP Server
  const server = new McpServer({
    name: "toulmin-mcp",
    version: "0.1.0",
  });

  // 加载审查配置
  const reviewConfig = loadReviewConfig(reviewConfigPath, dbPath);
  if (reviewConfig) {
    console.error(`[Toulmin MCP] Async review enabled (model: ${reviewConfig.model})`);
  } else {
    console.error("[Toulmin MCP] Async review disabled");
  }

  // 追踪 in-flight 工具调用，确保关闭前全部完成
  let _pendingOps = 0;
  let _drainResolve: (() => void) | null = null;
  const lifecycle: Lifecycle = {
    beginOp() { _pendingOps++; },
    endOp() {
      _pendingOps--;
      if (_pendingOps === 0 && _drainResolve) {
        const r = _drainResolve;
        _drainResolve = null;
        r();
      }
    },
    drain(): Promise<void> {
      if (_pendingOps === 0) return Promise.resolve();
      return new Promise<void>(resolve => { _drainResolve = resolve; });
    },
  };

  // 注册工具
  registerTools(server, db, reviewConfig, lifecycle);
  console.error("[Toulmin MCP] 12 tools registered");

  // 连接 stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Toulmin MCP] Server started on stdio");

  // 优雅关闭
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error("[Toulmin MCP] Shutting down...");
    await server.close();
    await lifecycle.drain();
    try {
      db.close();
      console.error("[Toulmin MCP] Database closed");
    } catch (e) {
      console.error("[Toulmin MCP] Warning: db.close() failed:", e);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[Toulmin MCP] Fatal error:", err);
  process.exit(1);
});
