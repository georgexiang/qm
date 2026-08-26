import { main } from "./run-browser-skill-conformance.ts";

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await main(process.argv.slice(2));
}
