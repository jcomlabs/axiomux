import { writeSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.argv.includes("overflow")) {
  const output = Buffer.alloc(2 * 1024 * 1024 + 1, "x");
  let offset = 0;
  while (offset < output.length) offset += writeSync(1, output, offset, output.length - offset);
  process.exit(0);
}
const value = JSON.parse(input);
process.stdout.write(
  JSON.stringify({
    received: value,
    argv: process.argv.slice(2),
    environment: {
      browserUseKey: process.env.BROWSER_USE_API_KEY ? "present" : "absent",
      openAiKey: process.env.OPENAI_API_KEY ? "present" : "absent",
    },
  }),
);
