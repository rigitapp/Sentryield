import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DbState,
  Decision,
  PoolSnapshot,
  Position,
  StoredDecision,
  TweetRecord
} from "../types.js";

const DEFAULT_STATE: DbState = {
  position: null,
  snapshots: [],
  decisions: [],
  tweets: []
};

export class JsonDb {
  constructor(
    private readonly filePath: string,
    private readonly maxSnapshots = 5_000,
    private readonly maxDecisions = 2_000,
    private readonly maxTweets = 2_000
  ) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.writeState(DEFAULT_STATE);
    }
  }

  async getState(): Promise<DbState> {
    return this.readState();
  }

  async setPosition(position: Position | null): Promise<void> {
    const state = await this.readState();
    state.position = position;
    await this.writeState(state);
  }

  async addSnapshots(snapshots: PoolSnapshot[]): Promise<void> {
    const state = await this.readState();
    state.snapshots.push(...snapshots);
    state.snapshots = state.snapshots.slice(-this.maxSnapshots);
    await this.writeState(state);
  }

  async addDecision(decision: Decision): Promise<void> {
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
  }

  async addTweet(tweet: TweetRecord): Promise<void> {
    const state = await this.readState();
    state.tweets.push(tweet);
    state.tweets = state.tweets.slice(-this.maxTweets);
    await this.writeState(state);
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
      return DEFAULT_STATE;
    }
  }

  private async writeState(state: DbState): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
