import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DbState } from "../types.js";

export interface BotRuntimeStatus {
  service: "sentryield-bot";
  startedAt: string;
  runMode: "once" | "loop";
  scanIntervalSeconds: number;
  staleAfterSeconds: number;
  inFlight: boolean;
  totalTicks: number;
  successfulTicks: number;
  failedTicks: number;
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastSuccessfulTickAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

interface BotStatusServerConfig {
  host: string;
  port: number;
  authToken: string;
  statusProvider: () => BotRuntimeStatus;
  stateProvider: () => Promise<DbState>;
}

export type OperatorActionType = "EXIT_TO_USDC" | "ROTATE";

export interface OperatorAction {
  type: OperatorActionType;
  requestedAt: string;
  requestedBy: string;
  poolId?: string;
}

export interface OperatorState {
  paused: boolean;
  pendingAction: OperatorAction | null;
  lastAppliedAction: OperatorAction | null;
  updatedAt: string;
}

interface HealthEvaluation {
  healthy: boolean;
  ready: boolean;
  reason: string;
}

export class BotStatusServer {
  private readonly server: Server;
  private operatorState: OperatorState = {
    paused: false,
    pendingAction: null,
    lastAppliedAction: null,
    updatedAt: new Date().toISOString()
  };

  constructor(private readonly config: BotStatusServerConfig) {
    this.server = createServer(async (req, res) => {
      await this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  isPaused(): boolean {
    return this.operatorState.paused;
  }

  getOperatorState(): OperatorState {
    return {
      ...this.operatorState
    };
  }

  setPaused(paused: boolean, requestedBy = "api"): OperatorState {
    void requestedBy;
    this.operatorState = {
      ...this.operatorState,
      paused,
      updatedAt: new Date().toISOString()
    };
    return this.getOperatorState();
  }

  queueAction(action: OperatorAction): OperatorState {
    this.operatorState = {
      ...this.operatorState,
      pendingAction: action,
      updatedAt: new Date().toISOString()
    };
    return this.getOperatorState();
  }

  consumePendingAction(): OperatorAction | null {
    const next = this.operatorState.pendingAction;
    if (!next) return null;
    this.operatorState = {
      ...this.operatorState,
      pendingAction: null,
      lastAppliedAction: next,
      updatedAt: new Date().toISOString()
    };
    return next;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const requiresAuth =
      url.pathname === "/state" || url.pathname.startsWith("/controls");
    if (requiresAuth && !this.isAuthorized(req, url)) {
      this.respond(res, 401, { error: "Unauthorized" });
      return;
    }

    const status = this.config.statusProvider();
    const health = evaluateHealth(status);

    if (url.pathname === "/healthz") {
      this.respond(res, health.healthy ? 200 : 503, {
        service: status.service,
        healthy: health.healthy,
        ready: health.ready,
        reason: health.reason,
        runtime: status
      });
      return;
    }

    if (url.pathname === "/readyz") {
      this.respond(res, health.ready ? 200 : 503, {
        service: status.service,
        healthy: health.healthy,
        ready: health.ready,
        reason: health.reason,
        runtime: status
      });
      return;
    }

    if (url.pathname === "/state") {
      const state = await this.config.stateProvider();
      this.respond(res, health.healthy ? 200 : 503, {
        service: status.service,
        healthy: health.healthy,
        ready: health.ready,
        reason: health.reason,
        runtime: status,
        controls: this.operatorState,
        state
      });
      return;
    }

    if (url.pathname === "/controls" && req.method === "GET") {
      this.respond(res, 200, this.getOperatorState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/controls/pause") {
      this.setPaused(true, this.requesterName(req));
      this.respond(res, 200, this.getOperatorState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/controls/resume") {
      this.setPaused(false, this.requesterName(req));
      this.respond(res, 200, this.getOperatorState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/controls/exit") {
      this.queueAction({
        type: "EXIT_TO_USDC",
        requestedAt: new Date().toISOString(),
        requestedBy: this.requesterName(req)
      });
      this.respond(res, 200, this.getOperatorState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/controls/rotate") {
      const body = await this.readJson(req);
      const poolId = typeof body.poolId === "string" ? body.poolId.trim() : "";
      if (!poolId) {
        this.respond(res, 400, { error: "poolId is required for rotate command." });
        return;
      }
      this.queueAction({
        type: "ROTATE",
        poolId,
        requestedAt: new Date().toISOString(),
        requestedBy: this.requesterName(req)
      });
      this.respond(res, 200, this.getOperatorState());
      return;
    }

    this.respond(res, 200, {
      service: status.service,
      routes: [
        "/healthz",
        "/readyz",
        "/state",
        "/controls",
        "/controls/pause",
        "/controls/resume",
        "/controls/exit",
        "/controls/rotate"
      ]
    });
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    if (!this.config.authToken) return true;
    const headerToken = req.headers["x-bot-status-token"];
    if (typeof headerToken === "string" && headerToken === this.config.authToken) {
      return true;
    }
    const queryToken = url.searchParams.get("token");
    return queryToken === this.config.authToken;
  }

  private respond(res: ServerResponse, code: number, payload: unknown): void {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.end(JSON.stringify(payload));
  }

  private requesterName(req: IncomingMessage): string {
    const forwardedFor = req.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.trim()) return forwardedFor.trim();
    return req.socket.remoteAddress ?? "unknown";
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve());
      req.on("error", reject);
    });
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function evaluateHealth(status: BotRuntimeStatus): HealthEvaluation {
  const now = Date.now();
  const staleMs = status.staleAfterSeconds * 1_000;

  if (!status.lastTickStartedAt) {
    const startupAgeMs = now - Date.parse(status.startedAt);
    return {
      healthy: startupAgeMs <= staleMs,
      ready: false,
      reason: startupAgeMs <= staleMs ? "starting" : "tick_not_started"
    };
  }

  if (status.inFlight && status.lastTickStartedAt) {
    const ageMs = now - Date.parse(status.lastTickStartedAt);
    if (ageMs <= staleMs) {
      return {
        healthy: true,
        ready: Boolean(status.lastSuccessfulTickAt),
        reason: "tick_in_progress"
      };
    }
    return {
      healthy: false,
      ready: Boolean(status.lastSuccessfulTickAt),
      reason: "tick_stuck"
    };
  }

  if (!status.lastSuccessfulTickAt) {
    const lastActivityAt = status.lastTickFinishedAt ?? status.lastTickStartedAt;
    const activityAgeMs = now - Date.parse(lastActivityAt);
    if (activityAgeMs > staleMs) {
      return {
        healthy: false,
        ready: false,
        reason: "heartbeat_stale"
      };
    }
    return {
      // Liveness should stay green while ticks are still progressing,
      // even if they have not produced a successful cycle yet.
      healthy: true,
      ready: false,
      reason: "no_successful_tick"
    };
  }

  const ageMs = now - Date.parse(status.lastSuccessfulTickAt);
  if (ageMs > staleMs) {
    return {
      healthy: false,
      ready: true,
      reason: "heartbeat_stale"
    };
  }

  return {
    healthy: true,
    ready: true,
    reason: "ok"
  };
}
