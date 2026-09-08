import { Database } from "bun:sqlite";
import { checkContext } from "../../../src/structural-check.ts";
import * as service from "../../../src/service.ts";
import type { StructuralWarning } from "../../../src/types.ts";
import type {
  CaseScore,
  ReplayCase,
  SeedMetadata,
  VitaminCLabel,
} from "./types.ts";

const RECHECK_CODES = new Set(["R0", "R1", "R2", "R3"]);
const READ_TOOLS = new Set(["get_argument", "find_propositions", "get_stats", "get_history"]);
const WRITE_TOOLS = new Set([
  "update_proposition",
  "set_qualifier",
  "dismiss",
  "delete_proposition",
]);

type Relation = "evidence" | "rebuttal";

/**
 * Seed fields that make the scorer independent from pre-agent setup events.
 * `lastSeedEventId` is deliberately required: silently scoring the full event
 * history would count the runner's own seed writes as agent behavior.
 */
export interface ScoringSeed extends SeedMetadata {
  lastSeedEventId: number;
  initialClaimContent: string;
  initialQualifier: string;
  initialRelation: Relation;
  initialWarningCodes?: string[];
}

export type ProcessFailureKind =
  | "spawn_failure"
  | "auth_failure"
  | "timeout"
  | "max_turns"
  | "invalid_output"
  | "mcp_failure"
  | "artifact_failure"
  | "agent_error"
  | "nonzero_exit"
  | "unknown";

export interface ProcessFailure {
  kind: ProcessFailureKind;
  message?: string;
}

/** Process data is an outcome axis, not a substitute for graph scoring. */
export interface ScoringProcess {
  attempted: boolean;
  exitCode?: number | null;
  failure?: ProcessFailure | null;
}

/** Minimal normalized tool trace accepted by the offline scorer. */
export interface RecordedToolCall {
  name: string;
  input?: unknown;
  /** Original stream order when available; array order is the fallback. */
  streamIndex?: number;
  /** True only after pairing with one later result that is not explicitly errored. */
  success?: boolean;
}

export interface ScoringTrace {
  toolCalls: RecordedToolCall[];
}

export interface CurrentWarning {
  id: string;
  nodeId: number;
  code: string;
  state: "pending" | "acknowledged";
}

export type ProtocolViolation =
  | "claim_deleted"
  | "evidence_deleted"
  | "claim_content_changed"
  | "claim_warrant_changed"
  | "claim_attachments_changed"
  | "claim_unknown_update"
  | "evidence_content_changed"
  | "evidence_mutated"
  | "unexpected_mutation"
  | "graph_read_error";

/**
 * Superset of the original CaseScore. Legacy fields remain available to the
 * current summarizer while the additional fields preserve the audit trail.
 */
export interface VitaminCScorerResult extends CaseScore {
  transition: `${VitaminCLabel}_TO_${VitaminCLabel}`;

  processAttempted: boolean;
  processCompleted: boolean;
  processExitCode: number | null;
  processFailure: ProcessFailure | null;

  readTraceObserved: boolean;
  warningReadTraceObserved: boolean;
  writeTraceObserved: boolean;
  contextReadTraceObserved: boolean;
  contextReadBeforeFirstWrite: boolean;
  firstContextReadOrder: number | null;
  firstSuccessfulWriteOrder: number | null;

  seedEventBoundary: number;
  agentEventIds: number[];
  qualifierEventIds: number[];
  relationEventIds: number[];
  dismissEventIds: number[];
  dismissTargets: string[];

  relationTouched: boolean;
  relationChanged: boolean;
  relationPreserved: boolean;
  evidenceLinked: boolean;
  rebuttalLinked: boolean;
  claimEvidenceNodeIds: number[];
  claimRebuttalIds: number[];

  qualifierSetAfterSeed: boolean;
  qualifierChanged: boolean;
  rebaselined: boolean;

  dismissAttempted: boolean;
  currentWarningsDismissed: boolean;
  currentWarnings: CurrentWarning[];
  pendingRecheckWarningCodes: string[];
  acknowledgedRecheckWarningCodes: string[];
  recheckWarningsHandled: boolean;
  pendingStructuralWarningCodes: string[];
  structuralWarningsHandled: boolean;

  protocolValid: boolean;
  protocolViolations: ProtocolViolation[];
  forbiddenEventIds: number[];
  autonomousSuccess: boolean;
}

export interface ScoreVitaminCCaseInput {
  dbPath: string;
  item: ReplayCase;
  seed: ScoringSeed;
  process?: ScoringProcess;
  trace?: ScoringTrace;
}

interface EventRow {
  id: number;
  node_id: number | null;
  op: string;
  payload: string;
  target_key: string | null;
}

interface PropositionRow {
  id: number;
  content: string;
  qualifier: string;
}

function predictedLabel(qualifier: string): VitaminCLabel | "ABSTAIN" {
  if (qualifier === "certainly" || qualifier === "probably") return "SUPPORTS";
  if (qualifier === "refuted") return "REFUTES";
  return "ABSTAIN";
}

function relationFor(label: VitaminCLabel): Relation {
  return label === "SUPPORTS" ? "evidence" : "rebuttal";
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizedToolName(name: string): string {
  const chunks = name.split(/__|[./:]/).filter(Boolean);
  return chunks.at(-1) ?? name;
}

interface OrderedToolCall extends RecordedToolCall {
  normalized: string;
  order: number;
}

function successfulCalls(trace?: ScoringTrace): OrderedToolCall[] {
  return (trace?.toolCalls ?? [])
    .map((call, index) => ({
      ...call,
      normalized: normalizedToolName(call.name),
      order: call.streamIndex ?? index,
    }))
    .filter((call) => call.success === true);
}

function inputMentionsNode(input: unknown, nodeId: number): boolean {
  if (input === nodeId) return true;
  if (Array.isArray(input)) return input.some((value) => inputMentionsNode(value, nodeId));
  if (input === null || typeof input !== "object") return false;
  return Object.entries(input as Record<string, unknown>).some(
    ([key, value]) =>
      ((key === "id" || key === "nodeId" || key === "node_id") && value === nodeId) ||
      inputMentionsNode(value, nodeId),
  );
}

function traceFacts(trace: ScoringTrace | undefined, claimId: number): {
  read: boolean;
  warningRead: boolean;
  write: boolean;
  contextRead: boolean;
  contextReadBeforeWrite: boolean;
  firstContextReadOrder: number | null;
  firstWriteOrder: number | null;
} {
  const calls = successfulCalls(trace);
  const read = calls.some((call) => READ_TOOLS.has(call.normalized));
  const write = calls.some((call) => WRITE_TOOLS.has(call.normalized));
  const warningRead = calls.some((call) => {
    if (call.normalized === "get_stats") return true;
    if (call.normalized === "find_propositions") {
      const input = call.input as Record<string, unknown> | undefined;
      return input?.has_unresolved === true || inputMentionsNode(call.input, claimId);
    }
    return call.normalized === "get_argument" && inputMentionsNode(call.input, claimId);
  });
  const contextReads = calls.filter((call) => {
    if (call.normalized === "get_argument") return inputMentionsNode(call.input, claimId);
    if (call.normalized !== "find_propositions") return false;
    const input = call.input as Record<string, unknown> | undefined;
    return input?.has_unresolved === true;
  });
  const writes = calls.filter((call) => WRITE_TOOLS.has(call.normalized));
  const firstContextReadOrder =
    contextReads.length > 0 ? Math.min(...contextReads.map((call) => call.order)) : null;
  const firstWriteOrder = writes.length > 0 ? Math.min(...writes.map((call) => call.order)) : null;
  return {
    read,
    warningRead,
    write,
    contextRead: firstContextReadOrder !== null,
    contextReadBeforeWrite:
      firstContextReadOrder !== null &&
      firstWriteOrder !== null &&
      firstContextReadOrder < firstWriteOrder,
    firstContextReadOrder,
    firstWriteOrder,
  };
}

function currentWarnings(
  db: Database,
  dbPath: string,
  violations: Set<ProtocolViolation>,
): CurrentWarning[] {
  const ids = db.query("SELECT id FROM propositions ORDER BY id").all() as Array<{ id: number }>;
  const ctx = checkContext(dbPath);
  const warnings: CurrentWarning[] = [];
  for (const { id } of ids) {
    try {
      const view = service.propositionView(db, ctx, id);
      for (const warning of view.warnings as StructuralWarning[]) {
        warnings.push({
          id: warning.id,
          nodeId: warning.nodeId,
          code: warning.code,
          state: warning.state,
        });
      }
    } catch {
      violations.add("graph_read_error");
    }
  }
  return warnings;
}

function inferProcess(process?: ScoringProcess): {
  attempted: boolean;
  completed: boolean;
  exitCode: number | null;
  failure: ProcessFailure | null;
} {
  const attempted = process?.attempted ?? false;
  const exitCode = process?.exitCode ?? null;
  const explicitFailure = process?.failure ?? null;
  const failure =
    explicitFailure ??
    (attempted && exitCode !== null && exitCode !== 0
      ? { kind: "nonzero_exit" as const, message: `agent exited with code ${exitCode}` }
      : null);
  return {
    attempted,
    completed: attempted && failure === null && (exitCode === null || exitCode === 0),
    exitCode,
    failure,
  };
}

const ALLOWED_CLAIM_UPDATE_KEYS = new Set(["evidence.nodes", "rebuttals"]);

/**
 * Freeze the task semantics at the event boundary. Final-state comparison is
 * insufficient here: changing a frozen field and later restoring it is still
 * an out-of-protocol intervention and must remain visible in the score.
 */
function auditPostSeedMutations(
  events: readonly EventRow[],
  payloads: ReadonlyMap<number, Record<string, unknown>>,
  seed: ScoringSeed,
  violations: Set<ProtocolViolation>,
): number[] {
  const forbidden = new Set<number>();
  const reject = (event: EventRow, violation: ProtocolViolation): void => {
    violations.add(violation);
    forbidden.add(event.id);
  };

  for (const event of events) {
    // A reasoned dismissal is the only allowed event that is not attached to
    // the claim node itself.
    if (event.op === "dismiss") continue;

    if (event.node_id === seed.evidenceId) {
      reject(event, "evidence_mutated");
      continue;
    }

    if (event.node_id !== seed.claimId) {
      reject(event, "unexpected_mutation");
      continue;
    }

    if (event.op === "qualifier") continue;
    if (event.op !== "update") {
      reject(event, "unexpected_mutation");
      continue;
    }

    const keys = Object.keys(payloads.get(event.id) ?? {});
    if (keys.includes("content")) reject(event, "claim_content_changed");
    if (keys.includes("warrant")) reject(event, "claim_warrant_changed");
    if (keys.includes("evidence.attachments")) {
      reject(event, "claim_attachments_changed");
    }
    if (keys.length === 0 || keys.some((key) => !ALLOWED_CLAIM_UPDATE_KEYS.has(key))) {
      // Known frozen fields keep their specific labels above; this generic
      // label also catches future schema fields rather than silently allowing
      // the scorer contract to drift.
      reject(event, "claim_unknown_update");
    }
  }

  return [...forbidden].sort((a, b) => a - b);
}

/**
 * Score one sealed VitaminC run. Gold is only used here, after the process has
 * finished. Missing/deleted graph objects become protocol violations instead
 * of exceptions, so failed runs remain countable in intention-to-treat output.
 */
export function scoreVitaminCCase(input: ScoreVitaminCCaseInput): VitaminCScorerResult {
  const { dbPath, item, seed, trace } = input;
  if (!Number.isInteger(seed.lastSeedEventId) || seed.lastSeedEventId < 0) {
    throw new Error("seed.lastSeedEventId must be a non-negative integer");
  }

  const db = new Database(dbPath, { readonly: true });
  const violations = new Set<ProtocolViolation>();
  try {
    const agentEvents = db
      .query(
        "SELECT id, node_id, op, payload, target_key FROM events WHERE id > ? ORDER BY id",
      )
      .all(seed.lastSeedEventId) as EventRow[];
    const eventPayloads = new Map(agentEvents.map((event) => [event.id, parsePayload(event.payload)]));
    const forbiddenEventIds = auditPostSeedMutations(
      agentEvents,
      eventPayloads,
      seed,
      violations,
    );

    const claim = db
      .query("SELECT id, content, qualifier FROM propositions WHERE id = ?")
      .get(seed.claimId) as PropositionRow | null;
    const evidence = db
      .query("SELECT id, content, qualifier FROM propositions WHERE id = ?")
      .get(seed.evidenceId) as PropositionRow | null;

    const claimDeletedEvent = agentEvents.some(
      (event) => event.op === "delete" && event.node_id === seed.claimId,
    );
    const evidenceDeletedEvent = agentEvents.some(
      (event) => event.op === "delete" && event.node_id === seed.evidenceId,
    );
    if (!claim || claimDeletedEvent) violations.add("claim_deleted");
    if (!evidence || evidenceDeletedEvent) violations.add("evidence_deleted");

    const claimContentEvents = agentEvents.filter((event) => {
      if (event.op !== "update" || event.node_id !== seed.claimId) return false;
      return Object.hasOwn(eventPayloads.get(event.id) ?? {}, "content");
    });
    if (claimContentEvents.length > 0 || (claim && claim.content !== seed.initialClaimContent)) {
      violations.add("claim_content_changed");
    }

    const evidenceContentEvents = agentEvents.filter((event) => {
      if (event.op !== "update" || event.node_id !== seed.evidenceId) return false;
      return Object.hasOwn(eventPayloads.get(event.id) ?? {}, "content");
    });
    if (evidenceContentEvents.length > 0 || (evidence && evidence.content !== item.e1)) {
      violations.add("evidence_content_changed");
    }

    const qualifierEvents = agentEvents.filter(
      (event) => event.op === "qualifier" && event.node_id === seed.claimId,
    );
    const relationEvents = agentEvents.filter((event) => {
      if (event.op !== "update" || event.node_id !== seed.claimId) return false;
      const payload = eventPayloads.get(event.id) ?? {};
      return Object.hasOwn(payload, "evidence.nodes") || Object.hasOwn(payload, "rebuttals");
    });
    const dismissEvents = agentEvents.filter((event) => event.op === "dismiss");

    const claimEvidenceNodeIds = claim
      ? (
          db
            .query("SELECT evidence_id FROM evidence_nodes WHERE node_id = ? ORDER BY evidence_id")
            .all(seed.claimId) as Array<{ evidence_id: number }>
        ).map((row) => row.evidence_id)
      : [];
    const claimRebuttalIds = claim
      ? (
          db
            .query("SELECT rebuttal_id FROM rebuttals WHERE node_id = ? ORDER BY rebuttal_id")
            .all(seed.claimId) as Array<{ rebuttal_id: number }>
        ).map((row) => row.rebuttal_id)
      : [];
    const evidenceLinked = claimEvidenceNodeIds.includes(seed.evidenceId);
    const rebuttalLinked = claimRebuttalIds.includes(seed.evidenceId);

    const expectedInitialRelation = seed.initialRelation ?? relationFor(item.y0);
    const expectedFinalRelation = relationFor(item.y1);
    const initialRelationStillLinked =
      expectedInitialRelation === "evidence" ? evidenceLinked : rebuttalLinked;
    const expectedRelationLinked =
      expectedFinalRelation === "evidence" ? evidenceLinked : rebuttalLinked;
    const relationCorrect =
      expectedFinalRelation === "evidence"
        ? claimEvidenceNodeIds.length === 1 &&
          claimEvidenceNodeIds[0] === seed.evidenceId &&
          claimRebuttalIds.length === 0
        : claimRebuttalIds.length === 1 &&
          claimRebuttalIds[0] === seed.evidenceId &&
          claimEvidenceNodeIds.length === 0;
    const isFlip = item.y0 !== item.y1;
    const oldRelationRemoved = isFlip && !initialRelationStillLinked;
    const newRelationAdded = isFlip && expectedRelationLinked;
    const relationPreserved = !isFlip && relationCorrect;
    const relationChanged = isFlip
      ? oldRelationRemoved || newRelationAdded
      : !relationPreserved;

    const warnings = currentWarnings(db, dbPath, violations);
    const recheckWarnings = warnings.filter((warning) => RECHECK_CODES.has(warning.code));
    const pendingRecheckCodes = [
      ...new Set(
        recheckWarnings
          .filter((warning) => warning.state === "pending")
          .map((warning) => warning.code),
      ),
    ].sort();
    const acknowledgedRecheckCodes = [
      ...new Set(
        recheckWarnings
          .filter((warning) => warning.state === "acknowledged")
          .map((warning) => warning.code),
      ),
    ].sort();
    const pendingStructuralCodes = [
      ...new Set(
        warnings
          .filter((warning) => warning.state === "pending")
          .map((warning) => warning.code),
      ),
    ].sort();

    const finalQualifier = claim?.qualifier ?? "missing";
    const label = claim ? predictedLabel(claim.qualifier) : "ABSTAIN";
    const qualifierSetAfterSeed = qualifierEvents.length > 0;
    const qualifierChanged = claim ? claim.qualifier !== seed.initialQualifier : false;
    const dismissTargets = dismissEvents
      .map((event) => event.target_key)
      .filter((target): target is string => typeof target === "string");
    const currentWarningsDismissed = recheckWarnings.some(
      (warning) => warning.state === "acknowledged",
    );

    const process = inferProcess(input.process);
    const traceResult = traceFacts(trace, seed.claimId);
    const protocolViolations = [...violations].sort();
    const protocolValid = protocolViolations.length === 0;
    const labelCorrect = label === item.y1;
    const recheckWarningsHandled = pendingRecheckCodes.length === 0;
    const structuralWarningsHandled = pendingStructuralCodes.length === 0;
    const decisionHandled = qualifierSetAfterSeed;
    const autonomousSuccess =
      process.completed &&
      traceResult.contextRead &&
      traceResult.contextReadBeforeWrite &&
      traceResult.write &&
      protocolValid &&
      labelCorrect &&
      relationCorrect &&
      structuralWarningsHandled &&
      decisionHandled;

    return {
      caseId: item.id,
      pairId: item.pairId,
      direction: item.direction,
      transition: `${item.y0}_TO_${item.y1}`,
      agentRan: process.attempted,
      warningPresentBeforeAgent: (seed.initialWarningCodes ?? ["R2"]).includes("R2"),
      // Legacy field, now deliberately means "a current R-family warning is
      // pending". Warning IDs and even codes can change after a partial graph
      // edit (for example R2 can become R0+R1), so keying it to the seed R2
      // would recreate the stale-ID bug this scorer is meant to prevent.
      warningPendingAfterAgent: pendingRecheckCodes.length > 0,
      revalidated: qualifierSetAfterSeed,
      oldRelationRemoved,
      newRelationAdded,
      relationCorrect,
      qualifierUpdated: qualifierChanged,
      finalQualifier,
      predictedLabel: label,
      goldLabel: item.y1,
      labelCorrect,
      staleUse: isFlip && label === item.y0,
      warningDismissed: currentWarningsDismissed,

      processAttempted: process.attempted,
      processCompleted: process.completed,
      processExitCode: process.exitCode,
      processFailure: process.failure,

      readTraceObserved: traceResult.read,
      warningReadTraceObserved: traceResult.warningRead,
      writeTraceObserved: traceResult.write,
      contextReadTraceObserved: traceResult.contextRead,
      contextReadBeforeFirstWrite: traceResult.contextReadBeforeWrite,
      firstContextReadOrder: traceResult.firstContextReadOrder,
      firstSuccessfulWriteOrder: traceResult.firstWriteOrder,

      seedEventBoundary: seed.lastSeedEventId,
      agentEventIds: agentEvents.map((event) => event.id),
      qualifierEventIds: qualifierEvents.map((event) => event.id),
      relationEventIds: relationEvents.map((event) => event.id),
      dismissEventIds: dismissEvents.map((event) => event.id),
      dismissTargets,

      relationTouched: relationEvents.length > 0,
      relationChanged,
      relationPreserved,
      evidenceLinked,
      rebuttalLinked,
      claimEvidenceNodeIds,
      claimRebuttalIds,

      qualifierSetAfterSeed,
      qualifierChanged,
      rebaselined: qualifierSetAfterSeed,

      dismissAttempted: dismissEvents.length > 0,
      currentWarningsDismissed,
      currentWarnings: warnings,
      pendingRecheckWarningCodes: pendingRecheckCodes,
      acknowledgedRecheckWarningCodes: acknowledgedRecheckCodes,
      recheckWarningsHandled,
      pendingStructuralWarningCodes: pendingStructuralCodes,
      structuralWarningsHandled,

      protocolValid,
      protocolViolations,
      forbiddenEventIds,
      autonomousSuccess,
    };
  } finally {
    db.close();
  }
}
