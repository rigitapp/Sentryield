import type { Hex, TweetRecord, TweetType } from "../types.js";

export interface XClient {
  postTweet(text: string): Promise<string>;
}

export class ConsoleXClient implements XClient {
  async postTweet(text: string): Promise<string> {
    // TODO: Replace with official X API client (v2) and auth flow.
    console.log("[X placeholder]", text);
    return `mock-${Date.now()}`;
  }
}

interface TweeterConfig {
  enabled: boolean;
  explorerTxBaseUrl: string;
  minHoldHours: number;
  rotateDeltaPct: number;
  maxPaybackHours: number;
}

interface DeployedTweetInput {
  protocol: string;
  pair: string;
  netApyBps: number;
  txHash: Hex;
}

interface RotatedTweetInput {
  fromPair: string;
  toPair: string;
  oldApyBps: number;
  newApyBps: number;
  reason: string;
  txHash: Hex;
}

export class TweeterService {
  constructor(
    private readonly config: TweeterConfig,
    private readonly client: XClient
  ) {}

  async tweetDeployed(input: DeployedTweetInput): Promise<TweetRecord> {
    const body = [
      "DEPLOYED",
      `Pool: ${input.protocol} ${input.pair}`,
      `Net APY: ${(input.netApyBps / 100).toFixed(2)}%`,
      `Min hold: ${this.config.minHoldHours}h`,
      `Rotate rule: delta >= ${this.config.rotateDeltaPct.toFixed(1)}%, payback <= ${this.config.maxPaybackHours}h`,
      `Tx: ${this.txUrl(input.txHash)}`
    ].join(" | ");

    return this.send("DEPLOYED", body, input.txHash);
  }

  async tweetRotated(input: RotatedTweetInput): Promise<TweetRecord> {
    const body = [
      "ROTATED",
      `${input.fromPair} -> ${input.toPair}`,
      `APY: ${(input.oldApyBps / 100).toFixed(2)}% -> ${(input.newApyBps / 100).toFixed(2)}%`,
      `Reason: ${input.reason}`,
      `Tx: ${this.txUrl(input.txHash)}`
    ].join(" | ");

    return this.send("ROTATED", body, input.txHash);
  }

  async tweetEmergencyExit(reason: string, txHash: Hex): Promise<TweetRecord> {
    const body = [
      "EMERGENCY_EXIT",
      `Action: exited and parked in USDC`,
      `Reason: ${reason}`,
      `Tx: ${this.txUrl(txHash)}`
    ].join(" | ");

    return this.send("EMERGENCY_EXIT", body, txHash);
  }

  private async send(type: TweetType, body: string, txHash: Hex): Promise<TweetRecord> {
    if (this.config.enabled) {
      await this.client.postTweet(body);
    } else {
      console.log("[tweet disabled]", body);
    }

    return {
      timestamp: Math.floor(Date.now() / 1000),
      type,
      txHash,
      body
    };
  }

  private txUrl(txHash: Hex): string {
    return `${this.config.explorerTxBaseUrl}${txHash}`;
  }
}
