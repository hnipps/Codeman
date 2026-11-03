/**
 * @fileoverview The deploy colour this process runs as, and what each colour may do.
 *
 * A blue-green deploy runs two Codeman processes on ONE data dir and ONE tmux socket
 * while it switches: the new release starts idle beside the old one, is health-checked,
 * then takes over. Both attach to the same panes, so the rule that keeps their records
 * correct is that only one of them writes: the LIVE colour. The other serves reads and
 * keeps its terminals attached, but never flushes the files it holds in memory and never
 * acts on a pane by itself.
 *
 * - `candidate`: started idle by the supervisor (`CODEMAN_DEPLOY_ROLE=candidate`).
 * - `live`: how Codeman ran before deploys had colours, and the role when the variable is unset.
 * - `retired`: the old colour after the handoff, until the supervisor stops it.
 *
 * {@link POLICY} is the whole policy. Writers and actors ask {@link deployRole.allows} at
 * the moment they would write or act, never compare roles themselves, so a role change
 * needs no disarming or re-arming anywhere: the next tick simply asks again.
 *
 * The transitions are `candidate -> live` (promote), `live -> retired` (retire) and
 * `retired -> live` (reinstate, the undo of a retire when the deploy is rejected). What
 * each one does to the process (re-reading the disk, flushing) is the server's job.
 */

export type DeployRole = 'candidate' | 'live' | 'retired';

export type DeployCapability =
  /**
   * Write the shared files this process holds in memory and flushes whole (state.json,
   * mux-sessions.json and the like), and create panes, which it would then have to record.
   */
  | 'persist'
  /** Run the timers and controllers that write the data dir or act on panes unasked. */
  | 'automate'
  /** Ask the supervisor to roll back. A rollback stops the colour that asked, so only the colour users are on may. */
  | 'requestDeploy';

export type DeployTransition = 'promote' | 'retire' | 'reinstate';

const POLICY: Readonly<Record<DeployRole, Readonly<Record<DeployCapability, boolean>>>> = {
  candidate: { persist: false, automate: false, requestDeploy: false },
  live: { persist: true, automate: true, requestDeploy: true },
  retired: { persist: false, automate: false, requestDeploy: false },
};

const TRANSITIONS: Readonly<Record<DeployRole, Partial<Record<DeployRole, DeployTransition>>>> = {
  candidate: { live: 'promote' },
  live: { retired: 'retire' },
  retired: { live: 'reinstate' },
};

export type RoleChange =
  | { kind: 'unchanged' }
  | { kind: 'transition'; transition: DeployTransition }
  | { kind: 'refused'; reason: string };

/** What asking a process to change role came to. Asking for the role it has is accepted. */
export type DeployRoleOutcome =
  | { kind: 'accepted'; role: DeployRole; previous: DeployRole }
  | { kind: 'refused'; role: DeployRole; reason: string };

export function roleAllows(role: DeployRole, capability: DeployCapability): boolean {
  return POLICY[role][capability];
}

/** What asking a `from` colour to become `to` means. Asking for the current role is not an error. */
export function planRoleChange(from: DeployRole, to: DeployRole): RoleChange {
  if (from === to) return { kind: 'unchanged' };
  const transition = TRANSITIONS[from][to];
  return transition
    ? { kind: 'transition', transition }
    : { kind: 'refused', reason: `a ${from} colour cannot become ${to}` };
}

/**
 * The role `CODEMAN_DEPLOY_ROLE` starts this process as. Unset or empty is `live`. A process
 * can only start as `candidate` or `live`; anything else is refused rather than guessed,
 * since guessing `live` would put two writers on one data dir.
 */
export function parseStartRole(value: string | undefined): DeployRole {
  const role = (value ?? '').trim();
  if (role === '') return 'live';
  if (role === 'candidate' || role === 'live') return role;
  throw new Error(`CODEMAN_DEPLOY_ROLE must be "candidate" or "live", got ${JSON.stringify(value)}`);
}

/**
 * Thrown where a colour that is not live is asked to do what only the live colour may,
 * such as creating a pane. Callers that would otherwise fall back to doing it some other
 * way rethrow it, so the refusal reaches whoever asked.
 */
export class DeployRoleRefusal extends Error {
  constructor(role: DeployRole, what: string) {
    super(`This Codeman is the ${role} deploy colour; only the live colour ${what}`);
    this.name = 'DeployRoleRefusal';
  }
}

let current: DeployRole = 'live';

/** The role of THIS process. Process-wide, like the data dir and tmux socket it governs. */
export const deployRole = {
  get current(): DeployRole {
    return current;
  },

  allows(capability: DeployCapability): boolean {
    return roleAllows(current, capability);
  },

  /** Set the role this process starts as, from its environment. */
  initFromEnv(env: NodeJS.ProcessEnv = process.env): DeployRole {
    current = parseStartRole(env.CODEMAN_DEPLOY_ROLE);
    return current;
  },

  /** Enter `role` through a transition {@link planRoleChange} allows; anything else throws. */
  enter(role: DeployRole): void {
    const change = planRoleChange(current, role);
    if (change.kind === 'refused') throw new Error(change.reason);
    current = role;
  },
};
