import { ethers } from "hardhat";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });
dotenv.config();

async function main(): Promise<void> {
  const factory = await ethers.getContractFactory("CurvanceTargetAdapter");
  const adapter = await factory.deploy();
  await adapter.waitForDeployment();

  console.log(`CurvanceTargetAdapter deployed at: ${await adapter.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
