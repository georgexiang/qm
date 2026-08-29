import { resolve } from "node:path";
import { installDesktopBrowserPhaseFBundle } from "./desktop-browser-phase-f-bundle.ts";
import { parseDesktopBrowserPhaseFArgs } from "./desktop-browser-phase-f-cli.ts";

const args = parseDesktopBrowserPhaseFArgs(process.argv.slice(2), ["bundle", "install-dir", "sha256"]);
const bundlePath = resolve(args.bundle!);
const installDir = resolve(args["install-dir"]!);
const home = process.env.HOME ? resolve(process.env.HOME) : null;
if (!home || (installDir !== home && !installDir.startsWith(`${home}/`))) {
  throw new Error("Phase F install directory must be inside the current user home");
}
const manifest = await installDesktopBrowserPhaseFBundle({
  bundlePath,
  installDir,
  userHome: home,
  expectedBundleSha256: args.sha256!,
});
process.stdout.write(`${manifest.hostBroker.sha256}\n`);
