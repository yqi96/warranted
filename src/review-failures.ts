/** Advisory only: failed execution never locks a proposition or consumes a node budget. */
export class ReviewFailureTracker {
  private failures = new Map<number, { at: number; reason: string; fingerprint?: string }[]>();
  constructor(private readonly windowMs = 30 * 60_000, private readonly threshold = 3) {}

  completed(nodeId: number): void {
    // A completed review with findings is still a successful execution.
    this.failures.delete(nodeId);
  }

  failed(nodeId: number, reason: string, fingerprint?: string, now = Date.now()): string | undefined {
    for (const [id, events] of this.failures) {
      const recent = events.filter((event) => now - event.at <= this.windowMs);
      if (recent.length) this.failures.set(id, recent);
      else this.failures.delete(id);
    }
    const recent = this.failures.get(nodeId) ?? [];
    const previousCount = recent.length;
    recent.push({ at: now, reason: reason.slice(0, 240), fingerprint });
    this.failures.set(nodeId, recent);
    if (previousCount >= this.threshold || recent.length < this.threshold) return;
    const inputs = new Set(recent.map((event) => event.fingerprint).filter(Boolean));
    return `Review of #${nodeId} has failed to complete ${recent.length} consecutive times within ` +
      `${this.windowMs / 60_000} minutes. ${inputs.size > 1 ? "Inputs changed between attempts." : "No input change was observed (or identity was unavailable)."} ` +
      `Recent causes: ${recent.map((event) => event.reason).join(" | ")}. ` +
      "The review service, configuration or evidence input may need attention. Decide whether to adjust inputs, retry later, or proceed with your own evidence-based judgment. Further reviews remain available; this is not a scientific verdict.";
  }
}
