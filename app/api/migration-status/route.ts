import { NextResponse } from "next/server";
import { getMigrationStatus, queueOldVaultExit } from "@/lib/server/migration-status";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const payload = await getMigrationStatus();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
  };

  if (body.action !== "queue_old_exit") {
    return NextResponse.json(
      {
        error: "action must be queue_old_exit"
      },
      { status: 400 }
    );
  }

  const result = await queueOldVaultExit();
  const status = await getMigrationStatus();
  return NextResponse.json(
    {
      result,
      status
    },
    {
      status: result.status,
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}
