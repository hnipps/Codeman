/**
 * The deploy role machine (src/deploy-role.ts): which transitions exist, what each role
 * may do, and how the start role is read from CODEMAN_DEPLOY_ROLE.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  deployRole,
  parseStartRole,
  planRoleChange,
  roleAllows,
  type DeployCapability,
  type DeployRole,
} from '../src/deploy-role.js';

const ROLES: DeployRole[] = ['candidate', 'live', 'retired'];
const CAPABILITIES: DeployCapability[] = ['persist', 'automate'];

afterEach(() => {
  deployRole.initFromEnv({});
});

describe('planRoleChange', () => {
  it('allows exactly promote, retire and reinstate', () => {
    const allowed: string[] = [];
    for (const from of ROLES) {
      for (const to of ROLES) {
        const change = planRoleChange(from, to);
        if (change.kind === 'transition') allowed.push(`${from}->${to}:${change.transition}`);
      }
    }
    expect(allowed.sort()).toEqual(['candidate->live:promote', 'live->retired:retire', 'retired->live:reinstate']);
  });

  it('treats asking for the current role as unchanged, never refused', () => {
    for (const role of ROLES) expect(planRoleChange(role, role)).toEqual({ kind: 'unchanged' });
  });

  it.each([
    ['candidate', 'retired'],
    ['live', 'candidate'],
    ['retired', 'candidate'],
  ] as const)('refuses %s -> %s and says why', (from, to) => {
    expect(planRoleChange(from, to)).toEqual({ kind: 'refused', reason: `a ${from} colour cannot become ${to}` });
  });
});

describe('roleAllows', () => {
  it('lets only the live colour persist or automate', () => {
    for (const capability of CAPABILITIES) {
      expect(roleAllows('live', capability)).toBe(true);
      expect(roleAllows('candidate', capability)).toBe(false);
      expect(roleAllows('retired', capability)).toBe(false);
    }
  });
});

describe('parseStartRole', () => {
  it('reads unset and empty as live, which is how Codeman ran before colours', () => {
    expect(parseStartRole(undefined)).toBe('live');
    expect(parseStartRole('')).toBe('live');
    expect(parseStartRole('  ')).toBe('live');
  });

  it('accepts candidate and live', () => {
    expect(parseStartRole('candidate')).toBe('candidate');
    expect(parseStartRole(' live ')).toBe('live');
  });

  it.each(['retired', 'blue', 'LIVE'])('refuses %j rather than guess a writer', (value) => {
    expect(() => parseStartRole(value)).toThrow(/CODEMAN_DEPLOY_ROLE must be "candidate" or "live"/);
  });
});

describe('deployRole', () => {
  it('starts from the environment and answers capabilities for that role', () => {
    expect(deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' })).toBe('candidate');
    expect(deployRole.allows('persist')).toBe(false);
    deployRole.enter('live');
    expect(deployRole.current).toBe('live');
    expect(deployRole.allows('persist')).toBe(true);
  });

  it('refuses to enter a role no transition leads to, and stays where it was', () => {
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    expect(() => deployRole.enter('retired')).toThrow('a candidate colour cannot become retired');
    expect(deployRole.current).toBe('candidate');
  });
});
