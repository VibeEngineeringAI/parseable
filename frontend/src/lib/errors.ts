export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `error` is a page's code or styles failing to load, as when a deploy
 * has removed the files an open tab still refers to. A missing module rejects
 * with a TypeError ("Failed to fetch dynamically imported module" in Chromium,
 * "error loading dynamically imported module" in Firefox, "Importing a module
 * script failed" in Safari). In a build, Vite loads a page's stylesheet before
 * its module and rejects with a plain Error, "Unable to preload CSS for …".
 */
export function isStaleChunkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|Unable to preload CSS for /i.test(
      error.message,
    )
  );
}
