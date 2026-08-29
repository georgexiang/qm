export function parseDesktopBrowserPhaseFArgs(argv: string[], names: readonly string[]): Record<string, string> {
  if (argv.length % 2 !== 0) throw new Error(`invalid argument ${argv.at(-1) ?? ""}`);
  const allowed = new Set(names);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const rawName = argv[index]!;
    const value = argv[index + 1]!;
    if (!rawName.startsWith("--")) throw new Error(`invalid argument ${rawName}`);
    const name = rawName.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown argument --${name}`);
    if (parsed[name] !== undefined) throw new Error(`duplicate argument --${name}`);
    if (!value) throw new Error(`empty argument --${name}`);
    parsed[name] = value;
  }
  for (const name of names) {
    if (!parsed[name]) throw new Error(`missing --${name}`);
  }
  return parsed;
}
