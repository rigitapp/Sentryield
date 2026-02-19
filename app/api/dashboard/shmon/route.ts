import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/server/dashboard-data";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const payload = await getDashboardData("shmon");
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

