/**
 * agent frontmatter 的 tools 白名单一致性 — agents/*.md
 *
 * Claude Code 给插件自带的 MCP server 加作用域前缀:
 *   mcp__plugin_<plugin-name>_<server-name>__<tool>
 * 裸的服务端工具名(search_nodes)在白名单里永远解析不到。后果按 agent 而异:
 * 若整条白名单无一项解析成功,subagent 起不来;若混着内置工具,它会静默地
 * 只剩内置工具——丢掉 MCP 能力而不报错。这个测试盯住两种情况,并让前缀
 * 随 plugin.json / .mcp.json 漂移时在 CI 报错而不是运行时失能。
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../src/content/tools.ts";

const ROOT = join(import.meta.dir, "..");
const AGENTS_DIR = join(ROOT, "agents");

const pluginName: string = JSON.parse(
  readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8"),
).name;
const serverKeys: string[] = Object.keys(
  JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers,
);

/** 服务端注册的工具名,取自唯一权威来源 */
const REGISTERED = new Set(Object.keys(TOOLS));
/** 本插件所有合法的作用域前缀 */
const PREFIXES = serverKeys.map(k => `mcp__plugin_${pluginName}_${k}__`);

/** 取出 frontmatter 里 tools 的条目,兼容块列表与内联逗号两种写法 */
function toolList(text: string): string[] {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return [];

  const inline = fm.match(/^tools:[ \t]+(.+)$/m);
  if (inline) return inline[1].split(",").map(s => s.trim()).filter(Boolean);

  const block = fm.match(/^tools:[ \t]*$/m);
  if (!block) return [];

  const rest = fm.slice(fm.indexOf(block[0]) + block[0].length).split("\n");
  const out: string[] = [];
  for (const line of rest) {
    const item = line.match(/^\s+-[ \t]+(.+?)[ \t]*$/);
    if (item) out.push(item[1]);
    else if (line.trim() !== "") break; // 下一个 frontmatter key
  }
  return out;
}

const agents = readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith(".md"))
  .map(f => ({ file: f, tools: toolList(readFileSync(join(AGENTS_DIR, f), "utf8")) }));

describe("agent tools 白名单", () => {
  test("agents/ 能被解析出至少一个带白名单的 agent", () => {
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.filter(a => a.tools.length > 0).length).toBeGreaterThan(0);
  });

  test("至少一处用了本插件的作用域前缀,测试不空转", () => {
    const all = agents.flatMap(a => a.tools);
    expect(all.some(t => PREFIXES.some(p => t.startsWith(p)))).toBe(true);
  });

  for (const { file, tools } of agents) {
    if (tools.length === 0) continue;

    test(`${file}: 没有裸的服务端工具名`, () => {
      // 裸名解析不到任何工具 —— 白名单静默失能的根因
      expect(tools.filter(t => REGISTERED.has(t))).toEqual([]);
    });

    test(`${file}: 作用域名的前缀与工具名都成立`, () => {
      const broken = tools.filter(t => t.startsWith("mcp__")).filter(t => {
        const prefix = PREFIXES.find(p => t.startsWith(p));
        if (!prefix) return true; // 前缀不属于本插件(常见于 plugin.json 改名后)
        const bare = t.slice(prefix.length);
        return bare !== "*" && !REGISTERED.has(bare);
      });
      expect(broken).toEqual([]);
    });
  }
});
