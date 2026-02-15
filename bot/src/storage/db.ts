import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DbState,
  Decision,
  PoolSnapshot,
  Position,
  StoredDecision,
  TweetRecord
} from "../types.js";

function cloneDefaultState(): DbState {
  return {
    position: null,
    snapshots: [],
    decisions: [],
    tweets: []
  };
}

export class JsonDb {
  private opQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxSnapshots = 5_000,
    private readonly maxDecisions = 2_000,
    private readonly maxTweets = 2_000
  ) {}

  async init(): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      try {
        await readFile(this.filePath, "utf8");
      } catch {
        await this.writeState(cloneDefaultState());
      }
    });
  }

  async getState(): Promise<DbState> {
    await this.opQueue;
    return this.readState();
  }

  async setPosition(position: Position | null): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readState();
      state.position = position;
      await this.writeState(state);
    });
  }

  async addSnapshots(snapshots: PoolSnapshot[]): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readState();
      state.snapshots.push(...snapshots);
      state.snapshots = state.snapshots.slice(-this.maxSnapshots);
      await this.writeState(state);
    });
  }

  async addDecision(decision: Decision): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readState();
      const record: StoredDecision = {
        timestamp: decision.timestamp,
        chosenPoolId: decision.chosenPoolId,
        reason: decision.reason,
        action: decision.action,
        reasonCode: decision.reasonCode
      };
      state.decisions.push(record);
      state.decisions = state.decisions.slice(-this.maxDecisions);
      await this.writeState(state);
    });
  }

  async addTweet(tweet: TweetRecord): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readState();
      state.tweets.push(tweet);
      state.tweets = state.tweets.slice(-this.maxTweets);
      await this.writeState(state);
    });
  }

  private async readState(): Promise<DbState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DbState>;
      return {
        position: parsed.position ?? null,
        snapshots: parsed.snapshots ?? [],
        decisions: parsed.decisions ?? [],
        tweets: parsed.tweets ?? []
      };
    } catch {
      return cloneDefaultState();
    }
  }

  private async writeState(state: DbState): Promise<void> {
    const tempPath = `${this.filePath}.${Date.now().toString(36)}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.opQueue.then(operation, operation);
    this.opQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
}
