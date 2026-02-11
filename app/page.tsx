import { Header } from "@/components/dashboard/header";
import { CurrentPositionCard } from "@/components/dashboard/current-position-card";
import { RiskGuardsCard } from "@/components/dashboard/risk-guards-card";
import { ApyChart } from "@/components/dashboard/apy-chart";
import { RotationsTable } from "@/components/dashboard/rotations-table";
import { TweetFeed } from "@/components/dashboard/tweet-feed";
import {
  agentStatus,
  currentPosition,
  apySnapshots,
  rotations,
  guardStatus,
  tweets,
  nextTweetPreview,
} from "@/lib/mock-data";

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-background">
      <Header status={agentStatus} />

      <main className="container mx-auto p-4 lg:p-6">
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left Column - Position & Chart */}
          <div className="space-y-6 lg:col-span-4">
            <CurrentPositionCard position={currentPosition} />
            <RiskGuardsCard guardStatus={guardStatus} />
          </div>

          {/* Right Column - Chart, Table, Tweets */}
          <div className="space-y-6 lg:col-span-8">
            <ApyChart snapshots={apySnapshots} />

            <div className="grid gap-6 xl:grid-cols-5">
              <div className="xl:col-span-3">
                <RotationsTable rotations={rotations} />
              </div>
              <div className="xl:col-span-2">
                <TweetFeed tweets={tweets} previewTweet={nextTweetPreview} />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
