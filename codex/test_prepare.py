"""Offline adapter checks. No model or reviewer requests are made."""
import importlib.util
import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("prepare", HERE / "prepare.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
MANIFEST = json.loads((HERE / "adapter.json").read_text())
PROFILE = MANIFEST["profile"]


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="warranted-codex-test-")
        self.root = Path(self.temp.name)
        self.task = self.root / 'task with spaces "and quotes"'
        self.task.mkdir()
        (self.task / "TASK.md").write_text("An offline adapter fixture.\n")
        self.runtime = self.root / "runtime"
        self.review = self.root / "review.json"
        self.review.write_text(json.dumps({"apiKey": "TEST_ONLY_NEVER_TRANSMITTED", "timeoutMs": 1_000_000}))

    def tearDown(self):
        self.temp.cleanup()

    def command(self, *extra, review=True):
        args = ["python3", str(HERE / "prepare.py"), "--task-dir", str(self.task),
                "--runtime-dir", str(self.runtime), "--model", "exact-model-id",
                "--base-url", "http://127.0.0.1:9/v1"]
        if review:
            args += ["--review-config", str(self.review)]
        return subprocess.run(args + list(extra), text=True, capture_output=True)

    def test_frozen_parent_and_prompt(self):
        frozen, release, body = adapter.verify_source()
        self.assertEqual(frozen["release"], "0.6.0")
        self.assertEqual(release["version"], "0.6.0")
        self.assertEqual(adapter.sha(body.encode()), frozen["prompt_body_sha256"])
        # A real original-file change must block preparation, even if prompts match.
        original = adapter.git
        with patch.object(adapter, "git", side_effect=lambda *a: "src/tools.ts" if a[0] == "diff" else original(*a)):
            with self.assertRaisesRegex(ValueError, "Frozen parent files changed"):
                adapter.verify_source()

    def test_generated_profile_preserves_treatment_and_secrets(self):
        result = self.command()
        self.assertEqual(result.returncode, 0, result.stderr)
        common = tomllib.loads((self.runtime / "config.toml").read_text())
        profile_text = (self.runtime / f"{PROFILE}.config.toml").read_text()
        profile = tomllib.loads(profile_text)
        self.assertEqual(profile["developer_instructions"], adapter.verify_source()[2])
        self.assertNotIn("model_instructions_file", profile)
        self.assertEqual(common["model"], "exact-model-id")
        self.assertEqual(common["model_providers"]["experiment"]["wire_api"], "responses")
        self.assertEqual(common["project_doc_max_bytes"], 0)
        self.assertFalse(common["features"]["hooks"])
        self.assertEqual(set(profile["mcp_servers"]), {adapter.TOULMIN, adapter.BROWSER})
        mcp = profile["mcp_servers"][adapter.TOULMIN]
        self.assertEqual(mcp["cwd"], str(self.task))
        self.assertEqual(mcp["args"][:3], [str(HERE.parent / "src/index.ts"), "--db-path", str(self.task / ".toulmin/graph.db")])
        self.assertTrue(mcp["required"])
        self.assertEqual(mcp["default_tools_approval_mode"], "approve")
        self.assertNotIn("enabled_tools", mcp)
        self.assertEqual(mcp["args"][-2:], ["--review-config", str(self.review)])
        self.assertGreaterEqual(mcp["tool_timeout_sec"], 2120)
        browser = profile["mcp_servers"][adapter.BROWSER]
        self.assertEqual(browser["args"], [str(HERE.parent / "src/browser/index.ts")])
        for path in self.runtime.rglob("*"):
            if path.is_file():
                self.assertNotIn("TEST_ONLY_NEVER_TRANSMITTED", path.read_text())
        self.assertFalse((self.task / ".toulmin").exists())
        self.assertEqual(json.loads((self.runtime / "preparation.json").read_text())["status"], "prepared_only")

    def test_never_overwrites_runtime_or_reuses_graph(self):
        self.runtime.mkdir()
        sentinel = self.runtime / "keep"
        sentinel.write_text("keep")
        self.assertNotEqual(self.command().returncode, 0)
        self.assertEqual(sentinel.read_text(), "keep")
        sentinel.unlink()
        self.runtime.rmdir()
        (self.task / ".toulmin").mkdir()
        self.assertNotEqual(self.command().returncode, 0)
        self.assertFalse(self.runtime.exists())

    def test_rejects_credential_urls_and_project_configuration(self):
        result = self.command("--base-url", "https://user:secret@example.invalid/v1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.runtime.exists())
        (self.task / ".agents").mkdir()
        self.assertNotEqual(self.command().returncode, 0)

    def test_review_cannot_be_silently_disabled(self):
        self.assertNotEqual(self.command(review=False).returncode, 0)
        inside = self.task / "review.json"
        inside.write_text(self.review.read_text())
        self.assertNotEqual(self.command("--review-config", str(inside)).returncode, 0)
        self.review.write_text("{}")
        self.assertNotEqual(self.command().returncode, 0)

    def test_subagent_prompts_and_permission_limit_are_recorded(self):
        result = self.command()
        self.assertEqual(result.returncode, 0, result.stderr)
        roles = {}
        for path in (self.runtime / "agents").glob("*.toml"):
            role = tomllib.loads(path.read_text())
            roles[role["name"]] = role
            raw = (HERE.parent / "agents" / (path.stem + ".md")).read_bytes()
            self.assertEqual(role["developer_instructions"], adapter.prompt_body(raw))
            self.assertNotIn("model", role)
            self.assertNotIn("mcp_servers", role)
        self.assertEqual(set(roles), set(MANIFEST["subagents"]))
        receipt = json.loads((self.runtime / "preparation.json").read_text())
        self.assertEqual(receipt["compatibility"]["subagent_mcp_allowlists"], "not_enforced_by_codex_0_155_0")
        self.assertEqual(receipt["subagents"]["toulmin-explorer"]["source_tools"],
                         [f"mcp__{adapter.TOULMIN}__{tool}" for tool in ("find_propositions", "get_argument", "get_stats")])

    def test_skills_copy_branch_sources_directly(self):
        result = self.command()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({p.parent.name for p in (self.runtime / "skills").glob("*/SKILL.md")}, set(MANIFEST["skills"]))
        for path in adapter.git("ls-files", "skills").splitlines():
            target = self.runtime / path
            self.assertEqual(target.read_bytes(), (HERE.parent / path).read_bytes())
        self.assertFalse((self.runtime / "skills/overleaf-setup/SKILL.claude.md").exists())

    def test_runtime_must_not_mutate_the_frozen_checkout(self):
        result = self.command("--runtime-dir", str(HERE.parent / "must-not-create-runtime"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((HERE.parent / "must-not-create-runtime").exists())


if __name__ == "__main__":
    unittest.main()
