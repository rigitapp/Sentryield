export const DASHBOARD_PROFILES = ["usdc", "ausd", "shmon"] as const;

export type DashboardProfile = (typeof DASHBOARD_PROFILES)[number];

