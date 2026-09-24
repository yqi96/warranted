#!/usr/bin/env python3
"""Prepare the frozen v0.6.0 release for Codex; never launch a model."""

import argparse
import hashlib
import json
import math
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
TOULMIN = "plugin_warranted_toulmin"
BROWSER = "plugin_warranted_browser"


def q(value):
    return json.dumps(value, ensure_ascii=False)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prompt_body(raw):
    # Keep every body byte, including the blank line following frontmatter.
    match = re.match(rb"\A---\n.*?\n---\n", raw, re.S)
    if not match:
        raise ValueError("Expected the frozen agent's YAML frontmatter")
    return raw[match.end():].decode("utf-8")


def verify_source():
    frozen = json.loads((ROOT / "codex/adapter.json").read_text())
    release = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())
    if release["version"] != frozen["release"]:
        raise ValueError("Adapter and frozen release disagree on the version")
    if git("rev-parse", frozen["parent_tag"] + "^{commit}") != frozen["parent_commit"]:
        raise ValueError("Frozen release tag no longer matches the parent commit")
    # Only the declared Codex-specific skill edit may differ from the release.
    changed = git("diff", "--name-only", frozen["parent_commit"], "--", ".", ":(exclude)codex/**")
    unexpected = set(changed.splitlines()) - set(frozen["adapted_parent_files"])
    if unexpected:
        raise ValueError("Frozen parent files changed:\n" + "\n".join(sorted(unexpected)))
    raw = (ROOT / "agents/toulmin-researcher.md").read_bytes()
    body = prompt_body(raw)
    if sha(raw) != frozen["agent_sha256"] or sha(body.encode()) != frozen["prompt_body_sha256"]:
        raise ValueError("Frozen agent prompt hash mismatch")
    return frozen, release, body


def agent_config(path):
    raw = path.read_bytes()
    front = raw.decode().split("---", 2)[1]
    field = lambda key: re.search(r"^" + key + r": (.+)$", front, re.M).group(1)
    body = prompt_body(raw)
    config = f"name = {q(field('name'))}\ndescription = {q(field('description'))}\n"
    config += "developer_instructions = " + q(body) + "\n"
    # Model aliases such as opus/sonnet/haiku belong to Claude. Inherit the
    # explicitly selected Codex model rather than silently translate aliases.
    # Codex 0.155.0 ignores role-level MCP overrides. Retain the original tool
    # list as provenance, not as a claim that an allowlist has been enforced.
    tools = re.findall(r"^  - (.+)$", front, re.M)
    return config, {"source_sha256": sha(raw), "prompt_body_sha256": sha(body.encode()),
                    "source_model_alias": field("model"), "source_tools": tools,
                    "config_sha256": sha(config.encode())}


def skill_files():
    # Copy tracked skills directly; this branch is dedicated to Codex.
    return {path: (ROOT / path).read_bytes()
            for path in git("ls-files", "skills").splitlines()}


def prepare(args):
    frozen, _, body = verify_source()
    task = Path(args.task_dir).expanduser().resolve(strict=True)
    runtime = Path(args.runtime_dir).expanduser().resolve()
    if not task.is_dir() or task.is_relative_to(ROOT) or ROOT.is_relative_to(task):
        raise ValueError("Use a task directory separate from the Warranted source checkout")
    if runtime.is_relative_to(task) or task.is_relative_to(runtime):
        raise ValueError("Keep runtime configuration and task inputs in separate directories")
    if runtime.is_relative_to(ROOT) or ROOT.is_relative_to(runtime):
        raise ValueError("Keep runtime outside the frozen source checkout")
    if runtime.exists():
        raise ValueError("Runtime directory already exists; use a fresh directory for each trial")
    if (task / ".toulmin").exists():
        raise ValueError("Task already contains .toulmin state; use a fresh task directory")
    # A clean home alone cannot exclude project-local skills/configuration.
    if (task / ".codex").exists() or (task / ".agents").exists():
        raise ValueError("Remove project-specific .codex/.agents from the trial input copy")
    endpoint = urlsplit(args.base_url)
    if endpoint.scheme not in {"https", "http"} or not endpoint.netloc or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError("Use an HTTP(S) API base URL without credentials, query or fragment")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.api_key_env):
        raise ValueError("Invalid API key environment variable name")
    codex = shutil.which("codex")
    if not codex:
        raise ValueError("Install Codex CLI first")
    version = subprocess.check_output([codex, "--version"], text=True).strip()
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (0, 155, 0):
        raise ValueError("This adapter requires Codex CLI >= 0.155.0 (validated: 0.155.0)")
    if not args.review_config:
        raise ValueError("The v0.6.0 adapter requires --review-config; review must not silently disappear")
    review = Path(args.review_config).expanduser().resolve(strict=True)
    if review.is_relative_to(task):
        raise ValueError("Keep reviewer credentials outside the task input directory")
    cfg = json.loads(review.read_text())
    if not cfg.get("apiKey"):
        raise ValueError("Review configuration must contain its own apiKey")
    attempt_ms = cfg.get("timeoutMs", 600_000)
    if not isinstance(attempt_ms, int) or isinstance(attempt_ms, bool) or attempt_ms <= 0:
        raise ValueError("review timeoutMs must be a positive integer")
    # Existing reviewer can make two attempts. Include scheduling/IO headroom.
    timeout = max(1800, math.ceil(2 * attempt_ms / 1000) + 120)
    if args.tool_timeout_sec is not None:
        if args.tool_timeout_sec < timeout:
            raise ValueError(f"MCP tool timeout must be at least {timeout} seconds")
        timeout = args.tool_timeout_sec

    # JSON string encoding is compatible with TOML basic strings for these inputs.
    common = f'''# Generated by codex/prepare.py; credentials stay in the environment.
model = {q(args.model)}
model_provider = "experiment"
approval_policy = "never"
sandbox_mode = "workspace-write"
project_doc_max_bytes = 0
project_root_markers = []
web_search = "disabled"

[features]
memories = false
hooks = false
apps = false
remote_plugin = false

[projects.{q(str(task))}]
trust_level = "untrusted"

[model_providers.experiment]
name = "Fixed experiment model"
base_url = {q(args.base_url.rstrip('/'))}
env_key = {q(args.api_key_env)}
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[agents]
enabled = true
'''
    profile = f"# Release: {frozen['release']}; parent: {frozen['parent_commit']}\n"
    profile += "developer_instructions = " + q(body) + "\n"
    if frozen["mcp_tools"]:
        bun = shutil.which("bun")
        if not bun or not (ROOT / "node_modules").is_dir():
            raise ValueError("Install Bun and run bun install --frozen-lockfile in this checkout first")
        mcp_args = [str(ROOT / "src/index.ts"), "--db-path", str(task / ".toulmin/graph.db")]
        if review:
            mcp_args += ["--review-config", str(review)]
        profile += f'''
[mcp_servers.{TOULMIN}]
command = {q(bun)}
args = {q(mcp_args)}
cwd = {q(str(task))}
required = true
# This is the frozen local Warranted server, explicitly permitted for the trial.
default_tools_approval_mode = "approve"
startup_timeout_sec = 60
tool_timeout_sec = {timeout}

[mcp_servers.{BROWSER}]
command = {q(bun)}
args = {q([str(ROOT / 'src/browser/index.ts')])}
cwd = {q(str(task))}
required = true
default_tools_approval_mode = "approve"
startup_timeout_sec = 60
tool_timeout_sec = 180
'''
        if not shutil.which("node"):
            raise ValueError("Install Node.js for the frozen browser MCP server")
    profile_name = frozen["profile"]
    agents = {name: agent_config(ROOT / "agents" / f"{name}.md") for name in frozen["subagents"]}
    resources = skill_files()
    receipt = {
        "release": frozen["release"], "profile": profile_name, "parent_tag": frozen["parent_tag"],
        "parent_commit": frozen["parent_commit"],
        "adapted_parent_files": frozen["adapted_parent_files"],
        "adapter_commit": git("rev-parse", "HEAD"),
        "adapter_dirty": bool(git("status", "--porcelain", "--", "codex")),
        "agent_sha256": frozen["agent_sha256"], "prompt_body_sha256": frozen["prompt_body_sha256"],
        "expected_mcp_tools": frozen["mcp_tools"], "mcp_servers": [TOULMIN, BROWSER],
        "subagents": {name: metadata for name, (_, metadata) in agents.items()},
        "skill_files_sha256": {path: sha(data) for path, data in resources.items()},
        "compatibility": {"visualizer_selection_hook": "not_loaded",
                          "overleaf_sync": "explicit_command_no_automatic_stop_hook",
                          "subagent_models": "inherit_selected_codex_model",
                          "subagent_mcp_allowlists": "not_enforced_by_codex_0_155_0",
                          "native_tool_allowlists": "not_equivalent_to_claude_native_tools"},
        "codex_version": version, "model": args.model,
        "task_dir": str(task), "source_checkout": str(ROOT),
        "review_config_path": str(review) if review else None,
        "config_sha256": sha(common.encode()), "profile_sha256": sha(profile.encode()),
        "status": "prepared_only",
    }
    runtime.mkdir(parents=True, mode=0o700)
    (runtime / "config.toml").write_text(common)
    (runtime / f"{profile_name}.config.toml").write_text(profile)
    (runtime / "preparation.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    (runtime / "agents").mkdir()
    for name, (config, _) in agents.items():
        (runtime / "agents" / f"{name}.toml").write_text(config)
    for path, data in resources.items():
        destination = runtime / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    command = ["env", f"CODEX_HOME={runtime}", "codex", "exec", "--strict-config", "-p", profile_name,
               "-C", str(task), "--skip-git-repo-check", "--json", "-"]
    print("Prepared only; no model or reviewer has been called.")
    print("Codex 0.155.0 subagents inherit parent MCP tools; original role allowlists are not enforced.")
    print(shlex.join(command) + " < " + shlex.quote(str(task / "TASK.md")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="check parent files and prompt hashes only")
    parser.add_argument("--task-dir")
    parser.add_argument("--runtime-dir", help="new isolated Codex configuration/state directory")
    parser.add_argument("--model", help="exact model ID; never inferred or substituted")
    parser.add_argument("--base-url", help="Responses-compatible API base URL, without secrets")
    parser.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    parser.add_argument("--review-config", help="existing reviewer configuration; never copied")
    parser.add_argument("--tool-timeout-sec", type=int)
    args = parser.parse_args()
    try:
        if args.verify:
            frozen, _, _ = verify_source()
            print(json.dumps({"release": frozen["release"], "unchanged_parent_files_verified": True,
                              "adapted_parent_files": frozen["adapted_parent_files"],
                              "prompt_body_sha256": frozen["prompt_body_sha256"]}))
        else:
            for name in ("task_dir", "runtime_dir", "model", "base_url"):
                if not getattr(args, name):
                    parser.error("required: --" + name.replace("_", "-"))
            prepare(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Preparation failed: {error}\n")


if __name__ == "__main__":
    main()
