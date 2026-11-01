import { describe, it, expect } from 'vitest';
import { canTransition, pipelineStates, allowedTransitions } from '../src/job-state';

describe('job state machine', () => {
  it('allows forward transitions in CLIP_ANALYSIS pipeline', () => {
    expect(canTransition('CLIP_ANALYSIS', 'QUEUED', 'VALIDATING')).toBe(true);
    expect(canTransition('CLIP_ANALYSIS', 'TRANSCRIBING', 'SCENING')).toBe(true);
    expect(canTransition('CLIP_ANALYSIS', 'SCORING', 'AWAITING_REVIEW')).toBe(true);
  });
  it('blocks illegal skips and regressions', () => {
    expect(canTransition('CLIP_ANALYSIS', 'QUEUED', 'RENDERING')).toBe(false);
    expect(canTransition('CLIP_ANALYSIS', 'SCENING', 'PROBING')).toBe(false);
    expect(canTransition('CLIP_RENDER', 'COMPLETED', 'RENDERING')).toBe(false);
  });
  it('idempotent same-state set is allowed (retry safety)', () => {
    expect(canTransition('CLIP_ANALYSIS', 'TRANSCRIBING', 'TRANSCRIBING')).toBe(true);
  });
  it('FAILED reachable from non-terminal; CANCELLED too', () => {
    expect(canTransition('CLIP_ANALYSIS', 'ANALYZING', 'FAILED')).toBe(true);
    expect(canTransition('CLIP_ANALYSIS', 'ANALYZING', 'CANCELLED')).toBe(true);
    expect(canTransition('CLIP_ANALYSIS', 'COMPLETED', 'FAILED')).toBe(false);
  });
  it('pipeline states ordered for UI', () => {
    const p = pipelineStates('CLIP_ANALYSIS');
    expect(p[0]).toBe('QUEUED');
    expect(p[p.length - 1]).toBe('AWAITING_REVIEW');
    expect(allowedTransitions('COMPLETED')).toEqual([]);
  });
});
