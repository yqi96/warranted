#!/usr/bin/env python3
"""
finalize-cites.py  —  replace Ground-ID citations with bib keys in a .tex file.

During writing, cite Grounds as \\cite{ground_42} (using the Ground's numeric ID).
Before finalizing, the agent produces a ground-map JSON mapping each Ground ID
to one or more bib keys (derived from the Ground's attachment filenames, minus extension).

This script performs the replacement and reports any mismatches.

ground-map.json format (value is a string or a list of strings):
    {
      "42": "vaswani2017attention",
      "7":  ["ouyang2022training", "ziegler2019fine"],
      "13": "wei2022finetuned"
    }

\\cite{ground_7} expands to \\cite{ouyang2022training, ziegler2019fine}.

Usage:
    # Dry run — show what would change:
    uv run finalize-cites.py survey.tex ground-map.json

    # Write replacement to new file:
    uv run finalize-cites.py survey.tex ground-map.json --output survey-final.tex

    # In-place replacement:
    uv run finalize-cites.py survey.tex ground-map.json --inplace
"""
import re
import json
import sys
import argparse
from pathlib import Path

# Matches \cite{ground_42}, \citep{ground_42}, \citet{ground_7,ground_42}, etc.
# Also handles optional notes: \cite[see][p.3]{ground_42}
GROUND_CITE_RE = re.compile(
    r'(\\cite\w*\*?(?:\[[^\]]*\]){0,2}\{)([^}]+)(\})'
)
GROUND_KEY_RE = re.compile(r'\bground_(\d+)\b')


def normalize_map(raw: dict) -> dict[str, list[str]]:
    """Normalize map values to lists: "key" -> ["key"], ["a","b"] -> ["a","b"]."""
    return {
        gid: ([v] if isinstance(v, str) else list(v))
        for gid, v in raw.items()
    }


def replace_cites(tex: str, ground_map: dict[str, list[str]]) -> tuple[str, list[dict]]:
    """Return (updated_tex, list_of_replacements)."""
    replacements = []
    missing = []

    def replace_match(m: re.Match) -> str:
        prefix, keys_str, suffix = m.group(1), m.group(2), m.group(3)
        keys = [k.strip() for k in keys_str.split(',')]
        new_keys = []
        for key in keys:
            gnd = GROUND_KEY_RE.match(key)
            if gnd:
                gid = gnd.group(1)
                if gid in ground_map:
                    bib_keys = ground_map[gid]
                    replacements.append({"ground_id": gid, "bib_keys": bib_keys, "original": key})
                    new_keys.extend(bib_keys)
                else:
                    missing.append(gid)
                    new_keys.append(key)  # leave unchanged
            else:
                new_keys.append(key)  # not a Ground reference, leave as-is
        return prefix + ', '.join(new_keys) + suffix

    updated = GROUND_CITE_RE.sub(replace_match, tex)

    if missing:
        print(f"Warning: {len(missing)} Ground ID(s) not found in map: {sorted(set(missing))}", file=sys.stderr)

    cited_ids = {r["ground_id"] for r in replacements}
    uncited = set(ground_map) - cited_ids
    if uncited:
        print(f"Note: {len(uncited)} mapped Ground(s) not cited in tex: {sorted(uncited)}", file=sys.stderr)

    return updated, replacements


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tex", type=Path, help="Input .tex file")
    ap.add_argument("ground_map", type=Path, help="JSON file mapping Ground ID -> bib key(s)")
    ap.add_argument("--output", "-o", type=Path, default=None, help="Write result to this file")
    ap.add_argument("--inplace", action="store_true", help="Overwrite the input .tex file")
    args = ap.parse_args()

    if not args.tex.exists():
        print(f"Error: {args.tex} not found", file=sys.stderr)
        sys.exit(1)
    if not args.ground_map.exists():
        print(f"Error: {args.ground_map} not found", file=sys.stderr)
        sys.exit(1)
    if args.output and args.inplace:
        print("Error: --output and --inplace are mutually exclusive", file=sys.stderr)
        sys.exit(1)

    tex = args.tex.read_text(encoding="utf-8")
    raw_map = json.loads(args.ground_map.read_text(encoding="utf-8"))
    ground_map = normalize_map(raw_map)

    updated, replacements = replace_cites(tex, ground_map)

    if not replacements:
        print("No Ground citations found — nothing to replace.", file=sys.stderr)
    else:
        print(f"Replaced {len(replacements)} citation(s):", file=sys.stderr)
        for r in replacements:
            arrow = ', '.join(r['bib_keys'])
            print(f"  ground_{r['ground_id']} -> {arrow}", file=sys.stderr)

    if args.inplace:
        args.tex.write_text(updated, encoding="utf-8")
        print(f"Updated {args.tex} in place.", file=sys.stderr)
    elif args.output:
        args.output.write_text(updated, encoding="utf-8")
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(updated)


if __name__ == "__main__":
    main()

