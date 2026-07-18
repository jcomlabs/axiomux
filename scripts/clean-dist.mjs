import { rmSync } from "node:fs";
import { resolve } from "node:path";

// A clean output tree prevents deleted sources or tests from surviving in dist/.
rmSync(resolve(process.cwd(), "dist"), { recursive: true, force: true });
