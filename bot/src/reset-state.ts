import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { DbState } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_PATH = join(DATA_DIR, "state.json");

const EMPTY_STATE: DbState = {
  position: null,
  snapshots: [],
  decisions: [],
  tweets: []
};

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  let hadExistingState = false;
  try {
    await readFile(STATE_PATH, "utf8");
    hadExistingState = true;
  } catch {
    hadExistingState = false;
  }

  if (hadExistingState) {
    const backupPath = join(DATA_DIR, `state.backup.${Date.now()}.json`);
    await copyFile(STATE_PATH, backupPath);
    console.log(`Backed up existing state to: ${backupPath}`);
  }

  await writeFile(STATE_PATH, JSON.stringify(EMPTY_STATE, null, 2), "utf8");
  console.log(`Reset state file: ${STATE_PATH}`);
}

void main();
