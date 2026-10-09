import { TRANSPORT_ENVIRONMENT_KEYS } from '../transport-environment';
import { delimiter, dirname } from 'node:path';

export function codexEnvironment(cliPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...TRANSPORT_ENVIRONMENT_KEYS, 'PATH', 'HOME', 'CODEX_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // The npm launcher needs node beside the configured CLI, even in a desktop PATH.
  env.PATH = [dirname(cliPath), ...(env.PATH?.split(delimiter).filter(Boolean) ?? [])].join(delimiter);
  return env;
}
