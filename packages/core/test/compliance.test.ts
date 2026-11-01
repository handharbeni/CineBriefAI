import { describe, it, expect } from 'vitest';
import { evaluateKeywordCompliance, CampaignBriefSchema } from '../src/campaign';

const brief = CampaignBriefSchema.parse({
  projectId: '00000000-0000-4000-8000-000000000001',
  name: 'Q3 Launch',
  rules: [
    { id: 'r1', kind: 'DONT', text: 'Never mention competitor PriceCo', keywords: ['priceco', 'price co'], severity: 'block' },
    { id: 'r2', kind: 'DO', text: 'Say the brand name Acme', keywords: ['acme'], severity: 'warn' },
    { id: 'r3', kind: 'DONT', text: 'No medical claims', keywords: [], severity: 'block' },
  ],
});
const segs = [
  { text: 'Welcome back to the show', start: 0, end: 2 },
  { text: 'This beats PriceCo on every metric', start: 2, end: 5 },
  { text: 'Acme is our sponsor today', start: 5, end: 8 },
];

describe('campaign compliance', () => {
  it('flags DON\'T keyword violations as blocking', () => {
    const rep = evaluateKeywordCompliance(brief, segs);
    expect(rep.passed).toBe(false);
    expect(rep.violations).toHaveLength(1);
    expect(rep.violations[0].ruleId).toBe('r1');
    expect(rep.violations[0].startS).toBe(2);
  });
  it('records satisfied DO rules and unmet ones', () => {
    const rep = evaluateKeywordCompliance(brief, [{ text: 'no brands here at all', start: 0, end: 1 }]);
    expect(rep.unmetDoRules).toEqual(['r2']);
    expect(rep.passed).toBe(true); // no block violations
  });
  it('rules without keywords are skipped by deterministic pass (LLM handles them)', () => {
    const rep = evaluateKeywordCompliance(brief, segs);
    expect(rep.violations.every((v) => v.ruleId !== 'r3')).toBe(true);
  });
});
