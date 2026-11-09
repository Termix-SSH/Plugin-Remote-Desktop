import crypto from "node:crypto";
import type { MoonlightClient } from "./client.js";

export type PairState = "waiting" | "paired" | "failed" | "expired";

interface PairJob {
  id: string;
  userId: string;
  hostId: number;
  pin: string;
  state: PairState;
  abort: AbortController;
}

const WAIT_MS = 3 * 60_000;
const KEEP_RESULT_MS = 5 * 60_000;

export interface PairJobs {
  start(userId: string, hostId: number): Promise<{ id: string; pin: string }>;
  state(id: string, userId: string): PairState | null;
  stopAll(): void;
}

export function createPairJobs(
  client: Pick<MoonlightClient, "pair">,
  options: { waitMs?: number; keepResultMs?: number } = {},
): PairJobs {
  const waitMs = options.waitMs ?? WAIT_MS;
  const keepResultMs = options.keepResultMs ?? KEEP_RESULT_MS;
  const jobs = new Map<string, PairJob>();

  const finish = (job: PairJob, state: PairState) => {
    if (job.state !== "waiting") return;
    job.state = state;
    job.abort.abort();
    setTimeout(() => jobs.delete(job.id), keepResultMs).unref();
  };

  return {
    start: async (userId, hostId) => {
      // Sunshine keeps one request per client, so a new try replaces the old.
      for (const job of jobs.values()) {
        if (job.hostId === hostId) finish(job, "expired");
      }
      const abort = new AbortController();
      const pairing = await client.pair(hostId, abort.signal);
      const job: PairJob = {
        id: crypto.randomUUID(),
        userId,
        hostId,
        pin: pairing.pin,
        state: "waiting",
        abort,
      };
      jobs.set(job.id, job);
      const timer = setTimeout(() => finish(job, "expired"), waitMs);
      timer.unref();
      void pairing.result.then((paired) => {
        clearTimeout(timer);
        finish(job, paired ? "paired" : "failed");
      });
      return { id: job.id, pin: job.pin };
    },

    state: (id, userId) => {
      const job = jobs.get(id);
      return job && job.userId === userId ? job.state : null;
    },

    stopAll: () => {
      for (const job of jobs.values()) finish(job, "expired");
      jobs.clear();
    },
  };
}
