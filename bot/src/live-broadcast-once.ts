process.env.DRY_RUN = "false";
process.env.LIVE_MODE_ARMED = "true";
process.env.RUN_ONCE = "true";

console.log("Starting one-shot live broadcast run (DRY_RUN=false, LIVE_MODE_ARMED=true).");

void import("./index.js");
