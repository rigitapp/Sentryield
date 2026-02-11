"use client";

import { Twitter, Clock, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { Tweet } from "@/lib/types";

interface TweetFeedProps {
  tweets: Tweet[];
  previewTweet: Tweet;
}

function TweetCard({ tweet, isPreview = false }: { tweet: Tweet; isPreview?: boolean }) {
  const formatDate = (dateString: string) => {
    if (!dateString) return "Scheduled";
    return new Date(dateString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getTypeColor = (type: Tweet["type"]) => {
    switch (type) {
      case "DEPLOYED":
        return "bg-primary/20 text-primary";
      case "ROTATED":
        return "bg-chart-2/20 text-chart-2";
      case "ALERT":
        return "bg-warning/20 text-warning";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div
      className={`rounded-lg p-3 ${
        isPreview
          ? "border-2 border-dashed border-primary/30 bg-primary/5"
          : "bg-secondary/50"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <Badge variant="outline" className={`text-xs ${getTypeColor(tweet.type)}`}>
          {tweet.type}
        </Badge>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {isPreview ? (
            <>
              <Eye className="h-3 w-3" />
              Preview
            </>
          ) : (
            <>
              <Clock className="h-3 w-3" />
              {formatDate(tweet.timestamp)}
            </>
          )}
        </div>
      </div>
      <p className="whitespace-pre-line text-sm text-foreground leading-relaxed">
        {tweet.content}
      </p>
    </div>
  );
}

export function TweetFeed({ tweets, previewTweet }: TweetFeedProps) {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Twitter className="h-5 w-5 text-primary" />
          Tweet Feed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Next Tweet Preview
          </p>
          <TweetCard tweet={previewTweet} isPreview />
        </div>

        <Separator />

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent Tweets
          </p>
          <div className="space-y-3">
            {tweets.map((tweet) => (
              <TweetCard key={tweet.id} tweet={tweet} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
