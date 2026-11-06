import { describe, expect, it, vi } from "vitest";
import { createPairJobs } from "../../../src/backend/moonlight/pairing.js";

function pending() {
  let settle: (paired: boolean) => void = () => {};
  const result = new Promise<boolean>((done) => {
    settle = done;
  });
  return { result, settle };
}

const flush = () => new Promise((done) => setImmediate(done));

describe("Moonlight pair jobs", () => {
  it("gives the PIN at once and tracks the result", async () => {
    const run = pending();
    const jobs = createPairJobs({
      pair: async () => ({ pin: "1234", result: run.result }),
    });

    const job = await jobs.start("user-1", 5);
    expect(job.pin).toBe("1234");
    expect(jobs.state(job.id, "user-1")).toBe("waiting");

    run.settle(true);
    await flush();
    expect(jobs.state(job.id, "user-1")).toBe("paired");
    jobs.stopAll();
  });

  it("reports a refused PIN", async () => {
    const jobs = createPairJobs({
      pair: async () => ({ pin: "1234", result: Promise.resolve(false) }),
    });

    const job = await jobs.start("user-1", 5);
    await flush();

    expect(jobs.state(job.id, "user-1")).toBe("failed");
    jobs.stopAll();
  });

  it("hides a job from other users", async () => {
    const jobs = createPairJobs({
      pair: async () => ({ pin: "1234", result: pending().result }),
    });

    const job = await jobs.start("user-1", 5);

    expect(jobs.state(job.id, "user-2")).toBeNull();
    jobs.stopAll();
  });

  it("gives up and stops waiting after the time limit", async () => {
    let signal: AbortSignal | null = null;
    const jobs = createPairJobs(
      {
        pair: async (_id, abort) => {
          signal = abort;
          return { pin: "1234", result: pending().result };
        },
      },
      { waitMs: 10 },
    );

    const job = await jobs.start("user-1", 5);
    await vi.waitFor(() =>
      expect(jobs.state(job.id, "user-1")).toBe("expired"),
    );

    expect(signal!.aborted).toBe(true);
    jobs.stopAll();
  });

  it("replaces an older try for the same PC", async () => {
    const jobs = createPairJobs({
      pair: async () => ({ pin: "1234", result: pending().result }),
    });

    const first = await jobs.start("user-1", 5);
    const second = await jobs.start("user-1", 5);

    expect(jobs.state(first.id, "user-1")).toBe("expired");
    expect(jobs.state(second.id, "user-1")).toBe("waiting");
    jobs.stopAll();
  });
});
