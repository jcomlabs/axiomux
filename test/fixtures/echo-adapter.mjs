let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.argv.includes("overflow")) {
  process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
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
