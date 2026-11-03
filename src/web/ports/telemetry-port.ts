/**
 * @fileoverview Telemetry port: the build identity and the file telemetry sink.
 * Route modules that report on the running build (health, client errors) depend on this port.
 */

import type { Telemetry } from '../../telemetry.js';

export interface TelemetryPort {
  /** `CODEMAN_BUILD_ID` when well formed, else the package version. */
  readonly buildId: string;
  /** Null unless `CODEMAN_LOG_DIR` is set and usable. */
  readonly telemetry: Telemetry | null;
}
