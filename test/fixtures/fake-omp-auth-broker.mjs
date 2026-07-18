import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
writeFileSync(
  join(process.cwd(), "fake-auth-broker-invocation.json"),
  JSON.stringify({
    args,
    cwd: process.cwd(),
    environment: {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      OMP_AUTH_BROKER_URL: process.env.OMP_AUTH_BROKER_URL,
      OMP_AUTH_BROKER_TOKEN: process.env.OMP_AUTH_BROKER_TOKEN,
      NEURALWATT_API_KEY: process.env.NEURALWATT_API_KEY,
      PI_AUTH_NO_BORROW: process.env.PI_AUTH_NO_BORROW,
    },
  }),
  "utf8",
);

if (args[0] !== "auth-broker" || !["login", "logout"].includes(args[1]) || !args[2]) process.exitCode = 64;
