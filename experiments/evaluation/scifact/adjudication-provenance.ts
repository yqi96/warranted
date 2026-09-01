export const SOL_ULTRA_ADJUDICATOR_MODEL = "gpt-5.6-sol" as const;
export const SOL_ULTRA_REASONING_EFFORT = "ultra" as const;

export interface SolUltraInputProvenance {
  model?: unknown;
  reasoningEffort?: unknown;
}

export function validateSolUltraInputProvenance(
  document: SolUltraInputProvenance,
  source: string,
): {
  model: typeof SOL_ULTRA_ADJUDICATOR_MODEL;
  reasoningEffort: typeof SOL_ULTRA_REASONING_EFFORT;
} {
  if (document.model !== SOL_ULTRA_ADJUDICATOR_MODEL) {
    throw new Error(`${source} must record model=${SOL_ULTRA_ADJUDICATOR_MODEL} at top level`);
  }
  if (document.reasoningEffort !== SOL_ULTRA_REASONING_EFFORT) {
    throw new Error(
      `${source} must record reasoningEffort=${SOL_ULTRA_REASONING_EFFORT} at top level`,
    );
  }
  return {
    model: SOL_ULTRA_ADJUDICATOR_MODEL,
    reasoningEffort: SOL_ULTRA_REASONING_EFFORT,
  };
}

/** Case-level disclosure takes precedence over a homogeneous file-level declaration. */
export function inheritedBoolean(...values: unknown[]): boolean | null {
  for (const value of values) if (typeof value === "boolean") return value;
  return null;
}

export function requireSelectedVoteBlindness(
  blindedToRunResults: boolean | null,
  blindedToPriorAdjudication: boolean | null,
  source: string,
): void {
  if (blindedToRunResults !== true) {
    throw new Error(`${source} must explicitly record blindedToRunResults=true`);
  }
  if (blindedToPriorAdjudication !== true) {
    throw new Error(`${source} must explicitly record blindedToPriorAdjudication=true`);
  }
}
