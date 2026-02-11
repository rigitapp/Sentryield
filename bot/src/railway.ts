// Railway entrypoint: force long-running loop mode and align status port
// with Railway's dynamic PORT when provided.
process.env.RUN_ONCE = "false";
process.env.BOT_STATUS_SERVER_ENABLED = process.env.BOT_STATUS_SERVER_ENABLED || "true";
process.env.BOT_STATUS_SERVER_REQUIRED = process.env.BOT_STATUS_SERVER_REQUIRED || "true";
process.env.BOT_STATUS_HOST = process.env.BOT_STATUS_HOST || "0.0.0.0";
process.env.BOT_STATUS_PORT = process.env.BOT_STATUS_PORT || process.env.PORT || "8787";

console.log(
  `[railway] RUN_ONCE=${process.env.RUN_ONCE} BOT_STATUS_HOST=${process.env.BOT_STATUS_HOST} BOT_STATUS_PORT=${process.env.BOT_STATUS_PORT}`
);

void import("./index.js");
