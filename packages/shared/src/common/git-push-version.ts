/** Minimum Git family qualified by the bounded v1 publication suite. */
export const MINIMUM_GIT_PUSH_VERSION = Object.freeze({ major: 2, minor: 39 });

/**
 * Return the exact semantic version only for the bounded Git family exercised by v1.
 * A future major is withheld until its publication behavior is explicitly qualified.
 */
export function supportedGitPushVersion(raw: string): string | undefined {
  const match = /^git version (\d{1,3})\.(\d{1,3})\.(\d{1,3})(?=\s|$)/u.exec(raw.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== MINIMUM_GIT_PUSH_VERSION.major || minor < MINIMUM_GIT_PUSH_VERSION.minor) {
    return undefined;
  }
  return `${major}.${minor}.${Number(match[3])}`;
}
