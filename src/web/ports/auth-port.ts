/**
 * @fileoverview Auth port — capabilities for authentication state.
 * Route modules that need access to auth sessions or QR rate limiting depend on this port.
 */

import type { StaleExpirationMap } from '../../utils/index.js';
import type { AuthSessionStore } from '../auth-session-store.js';

/** Enhanced session record with device context for audit logging */
export interface AuthSessionRecord {
  ip: string;
  ua: string;
  createdAt: number;
  method: 'qr' | 'basic';
  /**
   * Multi-user identity carried by the cookie (single-user leaves these unset).
   * Snapshotted at mint time. Authorization-relevant admin changes (password reset,
   * disable, delete, role change, bypass-grant change) revoke the user's sessions so
   * a stale snapshot can't outlive the change; additionally the cookie fast-path
   * re-reads role/disabled/mustChangePassword live from the store each request, so an
   * out-of-band CLI mutation also takes effect promptly. See docs/multi-user-plan.md
   * section 5.
   */
  username?: string;
  role?: 'admin' | 'user';
  /** Whether this user must change their password before other actions are allowed. */
  mustChangePassword?: boolean;
  /**
   * Multi-user: `passwordStamp()` of the user's password when the cookie was minted. The
   * cookie path refuses the session once the user's password has changed, which also
   * covers a change made by the CLI or while a release without this check was live.
   */
  passwordStamp?: string;
}

export interface AuthPort {
  /** Keyed by `authSessionKey(cookie)`, never by the raw cookie value. */
  readonly authSessions: AuthSessionStore | null;
  readonly qrAuthFailures: StaleExpirationMap<string, number> | null;
  readonly https: boolean;
}
