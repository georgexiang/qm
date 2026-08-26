export interface NodeDesktopBrowserConformanceDepsOptions {
  platform?: string;
  arch?: string;
  processVersion?: string;
  env?: NodeJS.ProcessEnv;
  makeTempDirectoryImpl?: (prefix: string) => Promise<string>;
}

export interface NodeDesktopBrowserConformanceDeps {
  platform: string;
  arch: string;
  processVersion: string;
  env: NodeJS.ProcessEnv;
  makeTempDirectory(prefix: string): Promise<string>;
}

export function createNodeDesktopBrowserConformanceDeps(
  options?: NodeDesktopBrowserConformanceDepsOptions,
): NodeDesktopBrowserConformanceDeps;
