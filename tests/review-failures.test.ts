import { expect, test } from "bun:test";
import { ReviewFailureTracker } from "../src/review-failures.ts";

test("repeated execution failures advise once without rejecting changed claims", () => {
  const tracker = new ReviewFailureTracker(1000, 3);
  expect(tracker.failed(1, "timeout", "a", 0)).toBeUndefined();
  expect(tracker.failed(1, "read incomplete", "b", 10)).toBeUndefined();
  expect(tracker.failed(1, "32k", "b", 20)).toContain("Inputs changed");
  expect(tracker.failed(1, "timeout", "c", 30)).toBeUndefined();
  expect(tracker.failed(2, "timeout", "a", 30)).toBeUndefined();
});

test("completed reviews, including scientific failures, reset the warning streak", () => {
  const tracker = new ReviewFailureTracker(1000, 2);
  tracker.failed(1, "timeout", "a", 0);
  tracker.completed(1);
  expect(tracker.failed(1, "timeout", "b", 10)).toBeUndefined();
  expect(tracker.failed(1, "timeout", "b", 20)).toContain("Further reviews remain available");
  expect(tracker.failed(1, "timeout", "b", 2000)).toBeUndefined();
});
