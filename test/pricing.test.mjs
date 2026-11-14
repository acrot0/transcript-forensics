
/**
 * The pricing policy is a promise, so it gets a test.
 *
 * Two failure modes this prevents: a listing priced below the platform's $5 card
 * minimum (which the checkout will simply refuse, after someone has written the
 * listing), and the policy document and the listing plan drifting apart until the
 * README claims something the JSON does not.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('pricing policy', () => {
  const plan = JSON.parse(read('marketplace/agensi/listings.json'));
  const policy = read('docs/pricing.md');

  it('should never price a listing below the platform card minimum', () => {
    // $5 is the floor the checkout enforces; a $1 listing is not "cheap", it is
    // impossible, and the failure arrives after the listing is written.
    for (const l of plan.listings) {
      if (l.priceUSD === 0) continue;
      expect(l.priceUSD, `${l.skill} is below the card minimum`).toBeGreaterThanOrEqual(plan.minimumCardPriceUSD);
    }
  });

  it('should only require a payout method for a priced listing', () => {
    for (const l of plan.listings) {
      expect(l.payoutMethodRequired, `${l.skill} payout flag disagrees with its price`).toBe(l.priceUSD > 0);
    }
  });

  it('should keep the majority of listings free', () => {
    // The whole point of the project: the headline skills must not be gated.
    const free = plan.listings.filter((l) => l.priceUSD === 0);
    expect(free.length).toBeGreaterThan(plan.listings.length / 2);
    expect(free.map((l) => l.skill)).toEqual(expect.arrayContaining(['read-sessions', 'audit-install', 'triage-failure']));
  });

  it('should point every listing at a zip that exists', () => {
    // The zips are build artifacts (dist/ is gitignored), so this only runs after
    // a pack; skip rather than fail a clean checkout.
    const missing = plan.listings.filter((l) => !fs.existsSync(path.join(ROOT, l.zip)));
    if (missing.length === plan.listings.length) return;
    expect(missing.map((l) => l.skill)).toEqual([]);
  });

  it('should keep the policy and the plan on the same minimum', () => {
    expect(policy).toContain(`$${plan.minimumCardPriceUSD}`);
    expect(policy).toMatch(/free/i);
  });

  it('should state the free-forever rule explicitly', () => {
    expect(policy).toMatch(/stay free/i);
    expect(policy).toMatch(/MIT/);
  });
});
