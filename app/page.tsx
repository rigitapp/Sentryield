import { DashboardLive } from "@/components/dashboard/dashboard-live";
import { getDashboardData } from "@/lib/server/dashboard-data";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const initialData = await getDashboardData();
  const refreshIntervalMs = Number(process.env.DASHBOARD_REFRESH_MS ?? "10000");
  const safeRefreshIntervalMs =
    Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0
      ? refreshIntervalMs
      : 10_000;

  return (
    <DashboardLive
      initialData={initialData}
      refreshIntervalMs={safeRefreshIntervalMs}
    />
  );
}
