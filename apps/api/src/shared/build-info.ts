import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type BuildInfo = {
  version: string;
  commit: string;
  buildTime: string;
};

export function readBuildInfo(): BuildInfo {
  try {
    const value = JSON.parse(readFileSync(resolve(process.cwd(), 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    if (value.version && value.commit && value.buildTime) {
      return { version: value.version, commit: value.commit, buildTime: value.buildTime };
    }
  } catch {}
  return { version: 'unknown', commit: 'unknown', buildTime: 'unknown' };
}
