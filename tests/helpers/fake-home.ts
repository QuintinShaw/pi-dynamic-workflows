import { parse } from "node:path";

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
type HomeEnvKey = (typeof HOME_ENV_KEYS)[number];

/**
 * Temporarily point Node's os.homedir() at a fake home directory.
 *
 * On Windows, os.homedir() prefers USERPROFILE over HOME. Tests that only set
 * HOME can still write into the real user profile, so set both and restore the
 * complete Windows home env tuple afterwards.
 */
export function withFakeHome<T>(home: string, fn: () => T): T {
  const restore = installFakeHome(home);
  try {
    return fn();
  } finally {
    restore();
  }
}

/** Async variant of withFakeHome(). */
export async function withFakeHomeAsync<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const restore = installFakeHome(home);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function installFakeHome(home: string): () => void {
  const original = new Map<HomeEnvKey, string | undefined>();
  for (const key of HOME_ENV_KEYS) original.set(key, process.env[key]);

  process.env.HOME = home;
  process.env.USERPROFILE = home;

  if (process.platform === "win32") {
    const parsed = parse(home);
    const drive = parsed.root.replace(/[\\/]$/, "");
    if (drive) {
      process.env.HOMEDRIVE = drive;
      const homePath = home.slice(drive.length);
      process.env.HOMEPATH = homePath || "\\";
    }
  }

  return () => {
    for (const key of HOME_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
