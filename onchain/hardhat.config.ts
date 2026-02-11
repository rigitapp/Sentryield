import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";

dotenv.config({ path: "../.env" });
dotenv.config();

interface CurvanceMainnetConfig {
  chainId: number;
  rpcUrl: string;
}

const configPath = join(__dirname, "config", "curvance.monad.mainnet.json");
const mainnetConfig = JSON.parse(
  readFileSync(configPath, "utf8")
) as CurvanceMainnetConfig;
const forkingEnabled = process.env.FORK_MONAD === "true";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: forkingEnabled
        ? {
            url: process.env.MONAD_RPC_URL ?? mainnetConfig.rpcUrl
          }
        : undefined
    },
    monad: {
      url: process.env.MONAD_RPC_URL ?? mainnetConfig.rpcUrl,
      chainId: Number(process.env.MONAD_CHAIN_ID ?? String(mainnetConfig.chainId)),
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
};

export default config;
