/** PEP 503 project name normalisation. Kept apart from pypi.ts so the lockfile rewriters can use it without importing the adapter. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}
