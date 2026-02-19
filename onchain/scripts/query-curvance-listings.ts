import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });
dotenv.config();

const DEFAULT_RPC_URL = "https://rpc.monad.xyz";
const DEFAULT_CHAIN_ID = 143;
const DEFAULT_PROTOCOL_READER = "0x878cDfc2F3D96a49A5CbD805FAF4F3080768a6d2";
const DEFAULT_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

const PROTOCOL_READER_ABI = parseAbi([
  "function getDynamicMarketData() view returns ((address _address,(address _address,uint256 totalSupply,uint256 collateral,uint256 debt,uint256 sharePrice,uint256 assetPrice,uint256 sharePriceLower,uint256 assetPriceLower,uint256 borrowRate,uint256 predictedBorrowRate,uint256 utilizationRate,uint256 supplyRate,uint256 liquidity)[] tokens)[] data)"
]);

const MARKET_MANAGER_ABI = parseAbi([
  "function actionsPaused(address cToken) external view returns (bool mintPaused, bool collateralizationPaused, bool borrowPaused)"
]);

const CTOKEN_ABI = parseAbi([
  "function asset() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)"
]);

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)"
]);

interface ListingRow {
  marketManager: Address;
  cToken: Address;
  cTokenSymbol: string;
  cTokenName: string;
  asset: Address;
  assetSymbol: string;
  mintPaused: boolean;
  collateralizationPaused: boolean;
  borrowPaused: boolean;
}

interface DynamicMarketDataToken {
  _address: Address;
}

interface DynamicMarketDataRow {
  _address: Address;
  tokens: DynamicMarketDataToken[];
}

function readEnvAddress(name: string, fallback: string): Address {
  const raw = (process.env[name] ?? fallback).trim();
  return getAddress(raw);
}

async function main(): Promise<void> {
  const rpcUrl = (process.env.MONAD_RPC_URL ?? DEFAULT_RPC_URL).trim();
  const chainId = Number(process.env.MONAD_CHAIN_ID ?? DEFAULT_CHAIN_ID);
  const protocolReader = readEnvAddress("CURVANCE_PROTOCOL_READER_ADDRESS", DEFAULT_PROTOCOL_READER);
  const usdc = readEnvAddress("USDC_TOKEN_ADDRESS", DEFAULT_USDC);

  const client = createPublicClient({
    transport: http(rpcUrl)
  });

  const dynamicMarkets = (await client.readContract({
    address: protocolReader,
    abi: PROTOCOL_READER_ABI,
    functionName: "getDynamicMarketData"
  })) as DynamicMarketDataRow[];

  const listings: ListingRow[] = [];
  for (const market of dynamicMarkets) {
    for (const token of market.tokens) {
      const [asset, cTokenSymbol, cTokenName, pauses] = await Promise.all([
        client.readContract({
          address: token._address,
          abi: CTOKEN_ABI,
          functionName: "asset"
        }),
        client.readContract({
          address: token._address,
          abi: CTOKEN_ABI,
          functionName: "symbol"
        }),
        client.readContract({
          address: token._address,
          abi: CTOKEN_ABI,
          functionName: "name"
        }),
        client.readContract({
          address: market._address,
          abi: MARKET_MANAGER_ABI,
          functionName: "actionsPaused",
          args: [token._address]
        })
      ]);
      const assetSymbol = await client.readContract({
        address: asset,
        abi: ERC20_ABI,
        functionName: "symbol"
      });

      listings.push({
        marketManager: market._address,
        cToken: token._address,
        cTokenSymbol,
        cTokenName,
        asset,
        assetSymbol,
        mintPaused: pauses[0],
        collateralizationPaused: pauses[1],
        borrowPaused: pauses[2]
      });
    }
  }

  const usdcRows = listings.filter((row) => row.asset.toLowerCase() === usdc.toLowerCase());
  const usdcActive = usdcRows.filter((row) => !row.mintPaused);

  const summary = {
    chainId,
    protocolReader,
    totalListedTokens: listings.length,
    totalUsdcMarkets: usdcRows.length,
    activeUsdcMarkets: usdcActive.length,
    activeUsdcCTokens: usdcActive.map((row) => row.cToken)
  };

  console.log("CURVANCE_LISTINGS_SUMMARY_START");
  console.log(JSON.stringify(summary, null, 2));
  console.log("CURVANCE_LISTINGS_SUMMARY_END");
  console.log("CURVANCE_LISTINGS_START");
  console.log(JSON.stringify(listings, null, 2));
  console.log("CURVANCE_LISTINGS_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
