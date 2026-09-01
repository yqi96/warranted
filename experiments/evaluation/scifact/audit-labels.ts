#!/usr/bin/env bun

import { existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readJson, sha256File, writeJson } from "../common/manifest.ts";
import {
  type ValidatedAdjudicationBundle,
  validateAdjudicationBundle,
} from "./adjudication-bundle.ts";
import { buildProvisionalGraphVerdictOverlay } from "./graph-verdict.ts";
import { validateFixtureManifest } from "./score-reviews.ts";
import type {
  FixtureManifest,
  GraphExpectedVerdict,
  GraphVerdictOverlay,
} from "./types.ts";

function usage(): string {
  return `Create an auditable graph-verdict overlay without changing a fixture manifest.

Usage:
  bun experiments/evaluation/scifact/audit-labels.ts --fixtures <path> --out <path> [options]

Options:
  --fixtures <path>              Frozen fixture-manifest.json
  --out <path>                   New overlay path; must not already exist
  --bundle <path>                Complete adjudication bundle (required)
  --help                         Show this help

The bundle must hash-lock this fixture manifest, the fixed mechanical/adjudication policy,
the complete adjudications JSONL, and its consensus audit. Partial or unbundled decisions are
rejected.
`;
}

export function applyAdjudicationBundle(
  overlay: GraphVerdictOverlay,
  validated: ValidatedAdjudicationBundle,
  bundlePathFromOverlay: string,
): void {
  const byCase = new Map(overlay.cases.map((item) => [item.caseId, item]));
  const seen = new Set<string>();
  for (const row of validated.rows) {
    if (seen.has(row.caseId)) throw new Error(`Duplicate adjudication caseId: ${row.caseId}`);
    seen.add(row.caseId);
    const item = byCase.get(row.caseId);
    if (!item) throw new Error(`Adjudication refers to unknown fixture ${row.caseId}`);
    item.decisionStatus = "adjudicated";
    item.graphExpectedVerdict = row.graphExpectedVerdict;
    item.changedFromManifest = item.manifestExpectedVerdict !== row.graphExpectedVerdict;
    item.adjudicationReason = row.adjudicationReason.trim();
  }

  const adjudicatedCases = overlay.cases.filter(
    (item) => item.decisionStatus === "adjudicated",
  );
  overlay.adjudication = {
    method: validated.bundle.consensus.method,
    bundlePath: bundlePathFromOverlay,
    bundleSha256: validated.bundleSha256,
    adjudicationsSha256: validated.bundle.adjudications.sha256,
    consensusSha256: validated.bundle.consensus.sha256,
  };
  overlay.counts.adjudicated = adjudicatedCases.length;
  overlay.counts.graphExpectedVerdict = {
    pass: adjudicatedCases.filter((item) => item.graphExpectedVerdict === "pass").length,
    fail: adjudicatedCases.filter((item) => item.graphExpectedVerdict === "fail").length,
  };
  overlay.counts.changedFromManifest = adjudicatedCases.filter(
    (item) => item.changedFromManifest === true,
  ).length;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      fixtures: { type: "string" },
      out: { type: "string" },
      bundle: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values.fixtures) throw new Error("--fixtures is required");
  if (!values.out) throw new Error("--out is required");
  if (!values.bundle) throw new Error("--bundle is required");

  const fixtureManifestPath = resolve(values.fixtures);
  const outputPath = resolve(values.out);
  if (existsSync(outputPath)) throw new Error(`Output file already exists: ${outputPath}`);
  const manifest = readJson<FixtureManifest>(fixtureManifestPath);
  validateFixtureManifest(manifest);
  const fixtureManifestSha256 = sha256File(fixtureManifestPath);
  const validatedBundle = validateAdjudicationBundle(
    resolve(values.bundle),
    fixtureManifestSha256,
    manifest.cases.map((fixture) => fixture.caseId),
  );
  const overlay = buildProvisionalGraphVerdictOverlay(
    manifest,
    fixtureManifestSha256,
  );
  applyAdjudicationBundle(
    overlay,
    validatedBundle,
    relative(dirname(outputPath), validatedBundle.bundlePath),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeJson(outputPath, overlay);
  console.log(`Wrote ${overlay.counts.total}-case graph-verdict overlay: ${outputPath}`);
  console.log(
    `  mechanical: pass=${overlay.counts.mechanicalGraphVerdict.pass}, ` +
      `fail=${overlay.counts.mechanicalGraphVerdict.fail}, ` +
      `changed=${overlay.counts.mechanicalChangedFromManifest}`,
  );
  console.log(
    `  adjudicated: ${overlay.counts.adjudicated}/${overlay.counts.total}, ` +
      `pass=${overlay.counts.graphExpectedVerdict.pass}, ` +
      `fail=${overlay.counts.graphExpectedVerdict.fail}, ` +
      `changed=${overlay.counts.changedFromManifest}`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`scifact label audit failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
