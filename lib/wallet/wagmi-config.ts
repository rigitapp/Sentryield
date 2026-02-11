"use client";

import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { monadMainnet } from "@/lib/wallet/monad-chain";

const rpcUrl = process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://rpc.monad.xyz";
const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

const connectors = [
  injected(),
  coinbaseWallet({
    appName: "Monad Yield Agent",
    appLogoUrl: "/icon.svg"
  }),
  ...(walletConnectProjectId
    ? [
        walletConnect({
          projectId: walletConnectProjectId,
          showQrModal: true,
          metadata: {
            name: "Monad Yield Agent",
            description: "Sentryield dashboard and automation controls",
            url: "http://localhost:3000",
            icons: ["http://localhost:3000/icon-light-32x32.png"]
          }
        })
      ]
    : [])
];

export const wagmiConfig = createConfig({
  chains: [monadMainnet],
  connectors,
  transports: {
    [monadMainnet.id]: http(rpcUrl)
  }
});
