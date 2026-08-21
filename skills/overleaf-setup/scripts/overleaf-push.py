#!/usr/bin/env python3
r"""Push a LaTeX directory to Overleaf with \cite{prop_N} replaced by real bib keys.

Reads proposition attachment filenames from the Warranted DB, mirrors the source directory
into a temporary staging directory (replacing citations in .tex files), calls
`leaf push`, then deletes the staging directory. Source files are never modified.

Only `.pdf` attachments are treated as bib keys. The old ontology filtered on
`source = 'literature'` to keep observation statements out of the citation map; that field
no longer exists, and without a replacement filter every explanatory `.md` attached to a
proposition would be emitted as a citation key. The paper-is-a-PDF convention is the
replacement — it is the same convention the literature-writing citation contract states
("each attached paper's filename stem matches a BibTeX key in the project .bib").

Prerequisites (one-time setup):
    uv tool install overleaf-for-agents
    leaf login
    leaf init --project PROJECT_ID --dir LATEX_DIR   # writes leaf.toml into LATEX_DIR

Usage:
    # Push to Overleaf (hook or manual):
    uv run overleaf-push.py --dir LATEX_DIR

    # Push only if every citation key is a prop_N key:
    uv run overleaf-push.py --dir LATEX_DIR --require-prop-cites

    # Stage only, do not push (for inspection):
    uv run overleaf-push.py --dir LATEX_DIR --stage /tmp/inspect --no-push

    # Single-file citation replacement to stdout (dry-run):
    uv run overleaf-push.py --tex paper.tex

    # Override DB path:
    uv run overleaf-push.py --dir LATEX_DIR --db /path/to/graph.db
"""

import argparse
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

CITE_RE = re.compile(
    r'(\\cite\w*\*?(?:\[[^\]]*\]){0,2}\{)([^}]+)(\})'
)
PROP_KEY_RE = re.compile(r'prop_(\d+)')
LEGACY_KEY_RE = re.compile(r'statement_(\d+)')
BIB_ENTRY_RE = re.compile(r'@\w+\s*[({]\s*([^,\s]+)\s*,', re.IGNORECASE)


def build_proposition_map(db_path: str) -> dict[str, list[str]]:
    if not os.path.exists(db_path):
        return {}  # no DB → no map; citations left as-is

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT node_id, path FROM evidence_attachments ORDER BY node_id, path"
    ).fetchall()
    conn.close()

    prop_map: dict[str, list[str]] = {}
    for row in rows:
        pid = str(row["node_id"])
        path = Path(row["path"])
        if path.suffix.lower() == ".pdf":
            keys = prop_map.setdefault(pid, [])
            if path.stem not in keys:
                keys.append(path.stem)

    return prop_map


def cited_proposition_ids(tex: str) -> set[str]:
    ids: set[str] = set()
    for match in CITE_RE.finditer(tex):
        for key in (item.strip() for item in match.group(2).split(',')):
            prop = PROP_KEY_RE.fullmatch(key)
            if prop:
                ids.add(prop.group(1))
    return ids


def bib_keys_in_dir(source: Path) -> set[str]:
    keys: set[str] = set()
    for bib_path in source.rglob("*.bib"):
        if bib_path.is_file():
            keys.update(BIB_ENTRY_RE.findall(bib_path.read_text(encoding="utf-8")))
    return keys


def validate_citation_targets(source: Path, db_path: str) -> None:
    """Fail before staging when a prop_N citation cannot expand to existing paper PDFs
    whose filename stems are real keys in the LaTeX project's .bib files."""
    cited: set[str] = set()
    for tex_path in source.rglob("*.tex"):
        if tex_path.is_file():
            cited.update(cited_proposition_ids(tex_path.read_text(encoding="utf-8")))
    if not cited:
        return

    errors: list[str] = []
    if not os.path.exists(db_path):
        fail_for_mapping_errors([
            f"Warranted database not found: {db_path}. Pass the absolute path to .toulmin/graph.db."
        ])

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    propositions = {
        str(row["id"])
        for row in conn.execute("SELECT id FROM propositions").fetchall()
    }
    rows = conn.execute(
        "SELECT node_id, path FROM evidence_attachments ORDER BY node_id, path"
    ).fetchall()
    conn.close()

    attachments: dict[str, list[str]] = {}
    for row in rows:
        attachments.setdefault(str(row["node_id"]), []).append(str(row["path"]))

    bib_keys = bib_keys_in_dir(source)
    db_root = Path(db_path).resolve().parent.parent

    for pid in sorted(cited, key=int):
        if pid not in propositions:
            errors.append(
                f"prop_{pid}: proposition #{pid} does not exist in {db_path}. "
                "Repoint the citation to an existing proposition."
            )
            continue

        paths = attachments.get(pid, [])
        pdfs = [Path(path) for path in paths if Path(path).suffix.lower() == ".pdf"]
        if not pdfs:
            detail = "no attachments" if not paths else "only non-PDF attachments: " + ", ".join(paths)
            errors.append(
                f"prop_{pid}: {detail}. Attach the original paper PDF; notes and other files "
                "cannot be expanded into bibliography citations."
            )
            continue

        for pdf in pdfs:
            resolved = pdf if pdf.is_absolute() else db_root / pdf
            if not resolved.is_file():
                errors.append(
                    f"prop_{pid}: attached paper PDF is missing: {pdf} "
                    f"(resolved to {resolved}). Restore it or update the proposition attachment."
                )
            if pdf.stem not in bib_keys:
                errors.append(
                    f"prop_{pid}: PDF '{pdf}' maps to BibTeX key '{pdf.stem}', but that key "
                    "is absent from the LaTeX project's .bib files. Rename the PDF to an existing "
                    "key or add the matching BibTeX entry."
                )

    fail_for_mapping_errors(errors)


def fail_for_mapping_errors(errors: list[str]) -> None:
    if not errors:
        return
    print("Error: proposition citation(s) cannot be expanded safely:", file=sys.stderr)
    for error in errors:
        print(f"  {error}", file=sys.stderr)
    raise SystemExit(2)


def replace_cites(tex: str, prop_map: dict[str, list[str]]) -> tuple[str, int]:
    count = 0
    missing: list[str] = []

    def replace_match(m: re.Match) -> str:
        nonlocal count
        prefix, keys_str, suffix = m.group(1), m.group(2), m.group(3)
        keys = [k.strip() for k in keys_str.split(',')]
        new_keys: list[str] = []
        for key in keys:
            prop = PROP_KEY_RE.fullmatch(key)
            if prop:
                pid = prop.group(1)
                if pid in prop_map:
                    new_keys.extend(prop_map[pid])
                    count += 1
                else:
                    missing.append(pid)
                    new_keys.append(key)
            else:
                new_keys.append(key)
        return prefix + ', '.join(new_keys) + suffix

    updated = CITE_RE.sub(replace_match, tex)

    if missing:
        print(
            "Warning: proposition ID(s) not in map (no PDF attached?): "
            f"{sorted(set(missing), key=int)}",
            file=sys.stderr,
        )

    return updated, count


def find_bad_cites(tex: str, source_name: str) -> list[str]:
    """Every citation key must be prop_N. Legacy statement_N keys get their own message:
    they are not renamed prop_N keys — the numbering belongs to an archived graph."""
    errors: list[str] = []

    for match in CITE_RE.finditer(tex):
        line = tex.count("\n", 0, match.start()) + 1
        keys = [k.strip() for k in match.group(2).split(',')]
        for key in keys:
            if PROP_KEY_RE.fullmatch(key):
                continue
            if LEGACY_KEY_RE.fullmatch(key):
                errors.append(
                    f"{source_name}:{line}: legacy citation key {key} — re-identify what it "
                    "cited and repoint it; the number does not carry over"
                )
            else:
                errors.append(f"{source_name}:{line}: citation key is not prop_N: {key}")

    return errors


def find_bad_cites_in_dir(source: Path) -> list[str]:
    errors: list[str] = []

    for src_path in source.rglob("*.tex"):
        if src_path.is_file():
            rel = src_path.relative_to(source)
            tex = src_path.read_text(encoding="utf-8")
            errors.extend(find_bad_cites(tex, str(rel)))

    return errors


def fail_for_citation_errors(citation_errors: list[str]) -> None:
    if citation_errors:
        print("Error: citation key(s) that do not point into the graph:", file=sys.stderr)
        for error in citation_errors:
            print(f"  {error}", file=sys.stderr)
        print("Replace every listed citation key with a prop_N key before stopping.", file=sys.stderr)
        raise SystemExit(2)


def mirror_to_stage(
    source: Path,
    stage: Path,
    prop_map: dict[str, list[str]],
    require_prop_cites: bool = False,
) -> int:
    """Copy source → stage. .tex files get citation replacement; everything else copied as-is."""
    stage.mkdir(parents=True, exist_ok=True)
    total = 0
    citation_errors: list[str] = []

    for src_path in source.rglob("*"):
        if src_path.is_dir():
            continue
        rel = src_path.relative_to(source)
        dst_path = stage / rel
        dst_path.parent.mkdir(parents=True, exist_ok=True)

        if src_path.suffix == ".tex":
            tex = src_path.read_text(encoding="utf-8")
            if require_prop_cites:
                citation_errors.extend(find_bad_cites(tex, str(rel)))
            updated, count = replace_cites(tex, prop_map)
            dst_path.write_text(updated, encoding="utf-8")
            if count:
                print(f"  {rel}: {count} citation(s) replaced", file=sys.stderr)
                total += count
        else:
            shutil.copy2(src_path, dst_path)

    fail_for_citation_errors(citation_errors)

    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--dir", type=Path, help="LaTeX source directory (must contain leaf.toml)")
    target.add_argument("--tex", type=Path, help="Single .tex file — print replaced content to stdout")
    ap.add_argument("--db", default=".toulmin/graph.db", help="Path to Warranted graph.db")
    ap.add_argument("--stage", type=Path, default=None,
                    help="Persistent staging path for --dir; if omitted a temp dir is used and deleted after push")
    ap.add_argument("--no-push", action="store_true",
                    help="Stage only, do not call leaf push (useful with --stage for inspection)")
    ap.add_argument("--require-prop-cites", action="store_true",
                    help="Fail if any citation key is not exactly prop_N")
    args = ap.parse_args()

    prop_map = build_proposition_map(args.db)

    # ── Single-file mode ──────────────────────────────────────────────────────
    if args.tex:
        if not args.tex.exists():
            print(f"Error: {args.tex} not found", file=sys.stderr)
            sys.exit(1)
        tex = args.tex.read_text(encoding="utf-8")
        if args.require_prop_cites:
            fail_for_citation_errors(find_bad_cites(tex, str(args.tex)))
            validate_citation_targets(args.tex.parent, args.db)
        updated, count = replace_cites(tex, prop_map)
        if count == 0:
            print("No proposition citations found.", file=sys.stderr)
        else:
            print(f"{count} citation(s) replaced.", file=sys.stderr)
        print(updated)
        return

    # ── Directory mode ────────────────────────────────────────────────────────
    if not args.dir.is_dir():
        sys.exit(0)  # LATEX_DIR doesn't exist in this project — skip silently

    if args.require_prop_cites:
        fail_for_citation_errors(find_bad_cites_in_dir(args.dir))
        validate_citation_targets(args.dir, args.db)

    leaf_toml = args.dir / "leaf.toml"
    if not leaf_toml.exists() and not args.no_push:
        print(f"Error: leaf.toml not found in {args.dir}", file=sys.stderr)
        print("Run:  leaf init --project PROJECT_ID --dir " + str(args.dir), file=sys.stderr)
        sys.exit(1)

    # Skip push if nothing changed since last push
    last_push_file = args.dir / ".overleaf-last-push"
    last_push = last_push_file.stat().st_mtime if last_push_file.exists() else 0
    changed = any(
        f.stat().st_mtime > last_push
        for f in args.dir.rglob("*")
        if f.is_file() and f.name != ".overleaf-last-push"
    )
    if not changed:
        print("No changes since last push, skipping.", file=sys.stderr)
        return

    use_tempdir = args.stage is None
    stage = Path(tempfile.mkdtemp(prefix="overleaf-push-")) if use_tempdir else args.stage

    try:
        print(f"Staging {args.dir} → {stage}", file=sys.stderr)
        total = mirror_to_stage(args.dir, stage, prop_map, require_prop_cites=args.require_prop_cites)
        print(f"Staged. {total} citation(s) replaced.", file=sys.stderr)

        if not args.no_push:
            result = subprocess.run(["leaf", "push", "--dir", str(stage)], check=False)
            if result.returncode != 0:
                print(f"Error: leaf push exited with code {result.returncode}", file=sys.stderr)
                sys.exit(result.returncode)
            last_push_file.touch()
    finally:
        if use_tempdir and stage.exists():
            shutil.rmtree(stage)
            print(f"Staging directory removed.", file=sys.stderr)


if __name__ == "__main__":
    main()
