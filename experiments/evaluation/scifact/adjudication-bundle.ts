import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readJson, readJsonl, sha256File } from "../common/manifest.ts";
import {
  GRAPH_VERDICT_ADJUDICATION_RULE,
  MECHANICAL_GRAPH_VERDICT_RULE,
} from "./graph-verdict.ts";
import {
  MECHANICAL_GRAPH_VERDICT_POLICY_VERSION,
  type GraphExpectedVerdict,
  type GraphVerdictAdjudicationBundle,
} from "./types.ts";

export interface AdjudicationBundleRow {
  caseId: string;
  graphExpectedVerdict: GraphExpectedVerdict;
  adjudicationReason: string;
}

interface ConsensusCase {
  caseId: string;
  final: {
    verdict: GraphExpectedVerdict;
    reason: string;
  };
}

interface ConsensusDocument {
  schemaVersion: number;
  method: string;
  frozenArtifacts?: {
    fixtureManifest?: { sha256?: string };
  };
  counts?: {
    total?: number;
    finalVerdict?: { pass?: number; fail?: number };
  };
  cases: ConsensusCase[];
}

export interface ValidatedAdjudicationBundle {
  bundle: GraphVerdictAdjudicationBundle;
  bundlePath: string;
  bundleSha256: string;
  adjudicationsPath: string;
  consensusPath: string;
  rows: AdjudicationBundleRow[];
  consensus: ConsensusDocument;
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function bundledPath(bundlePath: string, value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const root = dirname(bundlePath);
  const resolved = resolve(root, value);
  const rel = relative(root, resolved);
  const parentPrefix = `..${process.platform === "win32" ? "\\" : "/"}`;
  if (rel === "" || rel === ".." || rel.startsWith(parentPrefix) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the adjudication bundle directory`);
  }
  return resolved;
}

function assertOrderedCaseIds(actual: string[], expected: string[], label: string): void {
  const seen = new Set<string>();
  for (const caseId of actual) {
    if (typeof caseId !== "string" || caseId.trim() === "") {
      throw new Error(`${label} contains an empty caseId`);
    }
    if (seen.has(caseId)) throw new Error(`${label} repeats ${caseId}`);
    seen.add(caseId);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must cover every fixture exactly once in manifest order`);
  }
}

/** Validate the complete immutable adjudication chain before an overlay can be built or scored. */
export function validateAdjudicationBundle(
  bundleFile: string,
  fixtureManifestSha256: string,
  fixtureCaseIds: string[],
): ValidatedAdjudicationBundle {
  const bundlePath = resolve(bundleFile);
  const bundle = readJson<GraphVerdictAdjudicationBundle>(bundlePath);
  if (bundle.schemaVersion !== 1) {
    throw new Error(`Unsupported adjudication bundle schema: ${bundle.schemaVersion}`);
  }
  if (bundle.fixtureManifestSha256 !== fixtureManifestSha256) {
    throw new Error("Adjudication bundle does not lock the selected fixture manifest");
  }
  if (
    bundle.policy?.mechanicalVersion !== MECHANICAL_GRAPH_VERDICT_POLICY_VERSION ||
    bundle.policy.mechanicalRule !== MECHANICAL_GRAPH_VERDICT_RULE ||
    bundle.policy.adjudicationRule !== GRAPH_VERDICT_ADJUDICATION_RULE
  ) {
    throw new Error("Adjudication bundle uses an unsupported labeling policy");
  }
  sha256(bundle.adjudications?.sha256, "Adjudications hash");
  sha256(bundle.consensus?.sha256, "Consensus hash");
  if (
    bundle.adjudications.cases !== fixtureCaseIds.length ||
    bundle.consensus.cases !== fixtureCaseIds.length
  ) {
    throw new Error("Adjudication bundle case counts do not match the fixture manifest");
  }
  if (typeof bundle.consensus.method !== "string" || bundle.consensus.method.trim() === "") {
    throw new Error("Adjudication bundle has no consensus method");
  }

  const adjudicationsPath = bundledPath(
    bundlePath,
    bundle.adjudications.path,
    "Adjudications path",
  );
  const consensusPath = bundledPath(bundlePath, bundle.consensus.path, "Consensus path");
  if (sha256File(adjudicationsPath) !== bundle.adjudications.sha256) {
    throw new Error("Adjudications file hash does not match the bundle");
  }
  if (sha256File(consensusPath) !== bundle.consensus.sha256) {
    throw new Error("Consensus file hash does not match the bundle");
  }

  const rows = readJsonl<AdjudicationBundleRow>(adjudicationsPath);
  if (rows.length !== bundle.adjudications.cases) {
    throw new Error("Adjudications row count does not match the bundle");
  }
  assertOrderedCaseIds(
    rows.map((row) => row.caseId),
    fixtureCaseIds,
    "Adjudications",
  );
  for (const row of rows) {
    if (row.graphExpectedVerdict !== "pass" && row.graphExpectedVerdict !== "fail") {
      throw new Error(`Adjudication ${row.caseId} has an invalid graphExpectedVerdict`);
    }
    if (typeof row.adjudicationReason !== "string" || row.adjudicationReason.trim() === "") {
      throw new Error(`Adjudication ${row.caseId} has an empty adjudicationReason`);
    }
  }

  const consensus = readJson<ConsensusDocument>(consensusPath);
  if (consensus.schemaVersion !== 2 || consensus.method !== bundle.consensus.method) {
    throw new Error("Consensus schema or method does not match the bundle");
  }
  if (consensus.frozenArtifacts?.fixtureManifest?.sha256 !== fixtureManifestSha256) {
    throw new Error("Consensus does not lock the selected fixture manifest");
  }
  if (!Array.isArray(consensus.cases) || consensus.cases.length !== bundle.consensus.cases) {
    throw new Error("Consensus case count does not match the bundle");
  }
  assertOrderedCaseIds(
    consensus.cases.map((item) => item.caseId),
    fixtureCaseIds,
    "Consensus",
  );
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const item = consensus.cases[index]!;
    if (
      item.final?.verdict !== row.graphExpectedVerdict ||
      item.final.reason !== row.adjudicationReason
    ) {
      throw new Error(`Consensus and adjudications disagree for ${row.caseId}`);
    }
  }
  const pass = rows.filter((row) => row.graphExpectedVerdict === "pass").length;
  const fail = rows.length - pass;
  if (
    consensus.counts?.total !== rows.length ||
    consensus.counts.finalVerdict?.pass !== pass ||
    consensus.counts.finalVerdict.fail !== fail
  ) {
    throw new Error("Consensus counts do not match its final decisions");
  }

  return {
    bundle,
    bundlePath,
    bundleSha256: sha256File(bundlePath),
    adjudicationsPath,
    consensusPath,
    rows,
    consensus,
  };
}
