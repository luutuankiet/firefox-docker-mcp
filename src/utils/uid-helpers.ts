/**
 * Shared UID error handling utilities
 */

/**
 * Transform UID resolution errors into concise messages
 */
export function handleUidError(error: Error, uid: string): Error {
  const errorMsg = error.message;

  // The snapshot layer already says which snapshot a uid came from and which
  // tab to refresh. Flattening that into one generic line throws away the only
  // part the caller can act on - it matters now that snapshots are per tab and
  // "take a fresh snapshot" is ambiguous about which page is meant.
  if (errorMsg.includes('snapshot ')) {
    return error;
  }

  if (
    errorMsg.includes('stale') ||
    errorMsg.includes('Snapshot') ||
    errorMsg.includes('UID') ||
    errorMsg.includes('not found')
  ) {
    return new Error(`${uid} stale/invalid. Call take_snapshot first.`);
  }

  return error;
}
