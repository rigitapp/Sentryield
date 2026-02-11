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

interface HealthEvaluation {
  healthy: boolean;
  ready: boolean;
  reason: string;
}

export class BotStatusServer {
  private readonly server: Server;

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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const requiresAuth = url.pathname === "/state";
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
        state
      });
      return;
    }

    this.respond(res, 200, {
      service: status.service,
      routes: ["/healthz", "/readyz", "/state"]
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
}

function evaluateHealth(status: BotRuntimeStatus): HealthEvaluation {
  const now = Date.now();
  const staleMs = status.staleAfterSeconds * 1_000;

  if (!status.lastTickStartedAt) {
    return {
      healthy: false,
      ready: false,
      reason: "tick_not_started"
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
    return {
      healthy: false,
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
