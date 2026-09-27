import { homedir } from 'node:os';
import { join } from 'node:path';

// Per-user data lives outside the app folder so removing or replacing the app keeps records.
export function defaultDataRoot(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ChallengeMaster');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ChallengeMaster');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'ChallengeMaster');
}

export function browserCommand(platform, url) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}
