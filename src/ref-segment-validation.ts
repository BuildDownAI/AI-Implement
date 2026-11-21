export const REF_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates that a slash-separated value is safe to use as git ref path segments.
 *
 * The rules, in the order they are checked:
 * - the whole value must not contain '..' or '//'
 * - each '/'-separated segment must start with a letter or digit and otherwise
 *   contain only letters, digits, '.', '_', '-'
 * - no segment may end with '.' or '.lock'
 *
 * The leading-alphanumeric rule is the security-relevant one: it is what stops a
 * value beginning with '-' from being read as an option by the git plumbing that
 * later consumes it (`--upload-pack=`-style argument injection).
 *
 * Deliberately does NOT check overall length, nor reject `refs/heads/` /
 * `refs/remotes/` forms — callers differ on both, so those stay caller-side.
 *
 * `label` names the value as the caller's reader knows it (the admin UI's label for a save,
 * a body key such as "branchPrefix" in a log), so the thrown message opens with it.
 * Keeping the rules in one place is what stops them drifting between call sites.
 */
export function validateRefSegments(value: string, label: string): void {
  if (value.includes("..") || value.includes("//")) {
    throw new Error(`${label} must not contain '..' or '//'.`);
  }
  for (const segment of value.split("/")) {
    if (!REF_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `${label} may contain only letters, digits, '.', '_' and '-' between its slashes, and each part must start with a letter or digit.`,
      );
    }
    if (segment.endsWith(".") || segment.endsWith(".lock")) {
      throw new Error(`${label} must not have a part that ends with '.' or '.lock'.`);
    }
  }
}
