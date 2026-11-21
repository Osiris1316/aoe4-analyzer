/**
 * Shared environment handling for the harvest scripts (discovery, retrieval,
 * verification). Node-side only.
 */

/**
 * v1 production database (aoe4-analyzer-db), as bound in
 * packages/jobs/wrangler.jsonc. Full at the free-plan ceiling and read by the
 * live site. The harvest must never write to it.
 */
export const V1_DATABASE_ID = 'a505c4e3-62ee-41fe-8875-79e8d241b745';

export interface D1Env {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

/** D1 credentials from the environment, or null if any are missing. */
export function readD1Env(): D1Env | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (!apiToken || !accountId || !databaseId) return null;
  return { apiToken, accountId, databaseId };
}

export function missingD1Vars(): string[] {
  return ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID'].filter(
    (k) => !process.env[k],
  );
}

/** Exit before touching anything if the database id is v1. */
export function refuseV1(databaseId: string): void {
  if (databaseId.trim().toLowerCase() === V1_DATABASE_ID) {
    console.error(
      'CLOUDFLARE_D1_DATABASE_ID is the v1 production database. The harvest only runs against v2.\n' +
        'Set it to the v2 id (67a5ef0e-…) and run again.',
    );
    process.exit(1);
  }
}

/** Value of `--name value`, or undefined. */
export function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} needs a value.`);
    process.exit(1);
  }
  return v;
}

/** Parse a positive whole-number flag, exiting with a clear message if invalid. */
export function intArg(args: string[], name: string, fallback: number, max: number): number {
  const v = argValue(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    console.error(`${name} must be a whole number from 1 to ${max}, got "${v}".`);
    process.exit(1);
  }
  return n;
}
