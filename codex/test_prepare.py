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
ARM = json.loads((HERE / "adapter.json").read_text())["arm"]


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

    def command(self, *extra):
        args = ["python3", str(HERE / "prepare.py"), "--task-dir", str(self.task),
                "--runtime-dir", str(self.runtime), "--model", "exact-model-id",
                "--base-url", "http://127.0.0.1:9/v1"]
        if ARM == "full":
            args += ["--review-config", str(self.review)]
        return subprocess.run(args + list(extra), text=True, capture_output=True)

    def test_frozen_parent_and_prompt(self):
        frozen, experiment, body = adapter.verify_source()
        self.assertEqual(frozen["arm"], ARM)
        self.assertEqual(experiment["arm"], ARM)
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
        profile_text = (self.runtime / f"warranted-{ARM}.config.toml").read_text()
        profile = tomllib.loads(profile_text)
        self.assertEqual(profile["developer_instructions"], adapter.verify_source()[2])
        self.assertNotIn("model_instructions_file", profile)
        self.assertEqual(common["model"], "exact-model-id")
        self.assertEqual(common["model_providers"]["experiment"]["wire_api"], "responses")
        self.assertEqual(common["project_doc_max_bytes"], 0)
        self.assertFalse(common["features"]["hooks"])
        if ARM == "guidance":
            self.assertNotIn("mcp_servers", profile)
        else:
            mcp = profile["mcp_servers"]["toulmin"]
            self.assertEqual(mcp["cwd"], str(self.task))
            self.assertEqual(mcp["args"][:3], [str(HERE.parent / "src/index.ts"), "--db-path", str(self.task / ".toulmin/graph.db")])
            self.assertTrue(mcp["required"])
            self.assertEqual(mcp["default_tools_approval_mode"], "approve")
            self.assertNotIn("enabled_tools", mcp)  # Use the actual treatment backend.
            if ARM == "full":
                self.assertEqual(mcp["args"][-2:], ["--review-config", str(self.review)])
                self.assertGreaterEqual(mcp["tool_timeout_sec"], 2120)
            else:
                self.assertNotIn("--review-config", mcp["args"])
        for path in self.runtime.iterdir():
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

    def test_review_cannot_be_silently_disabled_or_added(self):
        if ARM == "full":
            inside = self.task / "review.json"
            inside.write_text(self.review.read_text())
            self.assertNotEqual(self.command("--review-config", str(inside)).returncode, 0)
            self.review.write_text("{}")
            self.assertNotEqual(self.command().returncode, 0)
        else:
            self.assertNotEqual(self.command("--review-config", str(self.review)).returncode, 0)


if __name__ == "__main__":
    unittest.main()
