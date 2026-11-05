export type CapabilityStatus = "ready" | "syncing" | "action_required" | "unavailable";

/** What a connection provides, in the vocabulary of SweatStack's account status. */
export interface CapabilityMap {
  activities: CapabilityStatus;
  activity_history: CapabilityStatus;
  wellness: CapabilityStatus;
  workouts: CapabilityStatus;
}

export interface ConnectionState {
  /** What the platform granted. Null means unknown, not none. */
  permissions: readonly string[] | null;
  needsReconnect: boolean;
  backfillDone: boolean;
}

export interface PlatformTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/** A call to the platform failed. The status is absent when it never answered. */
export class PlatformError extends Error {
  override readonly name = "PlatformError";

  constructor(readonly status?: number) {
    super(status === undefined ? "The platform didn't answer" : `The platform answered ${status}`);
  }
}

/** Everything core code knows about a platform. It grows with the milestones that use it. */
export interface Provider {
  /** The name SweatStack knows the platform by, and the path segment of its routes. */
  readonly name: string;
  readonly label: string;
  /** The settings this platform can't run without: their names, for telling the owner what's missing. */
  readonly requiredSettings: readonly string[];

  /** Where to send the browser for the platform's consent. */
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<PlatformTokens>;
  /** The platform's own id for the account. It's only ever used to derive the subject. */
  identify(accessToken: string): Promise<string>;
  /** Null when the platform won't say yet, which is normal right after a consent. */
  fetchPermissions(accessToken: string): Promise<string[] | null>;
  capabilityMap(state: ConnectionState): CapabilityMap;
}
