// Campaign Brief + Compliance evaluation. DO/DON'T rules are hard constraints:
// a DON'T violation with severity "block" prevents approval downstream.
import { z } from 'zod';

export const RuleSeverity = z.enum(['block', 'warn']);
export type RuleSeverity = z.infer<typeof RuleSeverity>;

export const ConstraintRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['DO', 'DONT']),
  // text rules are matched against transcript/visual descriptions via keyword+LLM check
  text: z.string().min(3).max(2000),
  // optional deterministic keyword list (lowercase) used before semantic checks
  keywords: z.array(z.string().min(1).max(100)).default([]),
  severity: RuleSeverity.default('block'),
});
export type ConstraintRule = z.infer<typeof ConstraintRuleSchema>;

export const CampaignBriefSchema = z.object({
  id: z.string().uuid().optional(),
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  objective: z.string().max(4000).default(''),
  audience: z.string().max(2000).default(''),
  tone: z.string().max(500).default(''),
  cta: z.string().max(500).default(''),
  targetPlatforms: z.array(z.enum(['tiktok', 'reels', 'shorts', 'youtube', 'web'])).default(['shorts']),
  minDurationS: z.number().min(1).max(600).default(15),
  maxDurationS: z.number().min(2).max(600).default(60),
  aspectRatios: z.array(z.enum(['9:16', '1:1', '16:9'])).default(['9:16']),
  rules: z.array(ConstraintRuleSchema).default([]),
  language: z.string().min(2).max(10).default('en'),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

export const ViolationSchema = z.object({
  ruleId: z.string(),
  kind: z.enum(['DO', 'DONT']),
  severity: RuleSeverity,
  excerpt: z.string(),
  startS: z.number().optional(),
  endS: z.number().optional(),
  evidence: z.enum(['keyword', 'transcript-semantic', 'visual', 'manual']),
});
export type Violation = z.infer<typeof ViolationSchema>;

export interface ComplianceReport {
  passed: boolean;          // false when any 'block' violation exists
  violations: Violation[];
  unmetDoRules: string[];   // rule ids for DO rules with zero evidence
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD');

/** Deterministic keyword pass over transcript segments. Semantic/LLM pass layers on top. */
export function evaluateKeywordCompliance(
  brief: CampaignBrief,
  segments: { text: string; start: number; end: number }[],
): ComplianceReport {
  const violations: Violation[] = [];
  const hitDo = new Set<string>();
  const haystack = segments.map((s) => norm(s.text));

  for (const rule of brief.rules) {
    if (rule.keywords.length === 0) continue;
    for (let i = 0; i < segments.length; i++) {
      const kw = rule.keywords.find((k) => haystack[i].includes(norm(k)));
      if (!kw) continue;
      if (rule.kind === 'DONT') {
        violations.push({
          ruleId: rule.id,
          kind: 'DONT',
          severity: rule.severity,
          excerpt: segments[i].text.slice(0, 300),
          startS: segments[i].start,
          endS: segments[i].end,
          evidence: 'keyword',
        });
      } else {
        hitDo.add(rule.id);
      }
    }
  }
  const unmetDoRules = brief.rules
    .filter((r) => r.kind === 'DO' && r.keywords.length > 0 && !hitDo.has(r.id))
    .map((r) => r.id);

  return {
    passed: !violations.some((v) => v.severity === 'block'),
    violations,
    unmetDoRules,
  };
}
