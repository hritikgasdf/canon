function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * True when `current` (the latest approved procedure version) is newer than
 * `bound` (the version the Jira issue is bound to).
 */
export function isNewerVersion(current: number, bound: number): boolean {
  assertPositiveInteger('current', current);
  assertPositiveInteger('bound', bound);
  return current > bound;
}
