export type CapabilityStatus = "ready" | "syncing" | "action_required" | "unavailable";

/** What a connection provides, in the vocabulary of SweatStack's account status. */
export interface CapabilityMap {
  activities: CapabilityStatus;
  activity_history: CapabilityStatus;
  wellness: CapabilityStatus;
  workouts: CapabilityStatus;
}

export type Capability = keyof CapabilityMap;

export interface ConnectionState {
  /** What the platform granted. Null means unknown, not none. */
  permissions: readonly string[] | null;
  needsReconnect: boolean;
  backfillDone: boolean;
}

/** One file a platform says is ready. */
export interface FileReady {
  type: "file";
  platformUserId: string;
  /** The platform's own id for the activity: what SweatStack dedupes on. */
  externalId: string;
  /** What the provider needs to download it again later. */
  reference: unknown;
}

/** What a platform's webhook says happened. Nothing else in the body is believed. */
export type WebhookEvent =
  | FileReady
  | { type: "permissions_changed"; platformUserId: string }
  | { type: "deregistered"; platformUserId: string };

/** Where asking for history stands after one request. */
export type HistoryProgress =
  /** There's more to ask for, from here. */
  | { cursor: string }
  /** That was the last request, and whether the platform accepted any of them. */
  | { cursor: null; anyAccepted: boolean };

export interface DownloadedFile {
  bytes: ArrayBuffer;
  filename: string;
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

  constructor(
    readonly status?: number,
    /** The OAuth error, when the token endpoint gave one. */
    readonly code?: string,
  ) {
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
  /** What's wrong with this platform's settings, beyond what's missing. */
  settingProblems(): string[];
  /** What the owner says their app on this platform is approved for. */
  offeredCapabilities(): ReadonlySet<Capability>;

  /** Where to send the browser for the platform's consent. */
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<PlatformTokens>;
  /** The platform's own id for the account. It's only ever used to derive the subject. */
  identify(accessToken: string): Promise<string>;
  /** Null when the platform won't say yet, which is normal right after a consent. A refused token throws. */
  fetchPermissions(accessToken: string): Promise<string[] | null>;
  capabilityMap(state: ConnectionState): CapabilityMap;
  refresh(refreshToken: string): Promise<PlatformTokens>;
  /** Tells the platform to stop sending this account's data. */
  deregister(accessToken: string): Promise<void>;

  /** Whether this app may ask for this account's history. Unknown permissions don't count as allowed. */
  mayBackfill(permissions: readonly string[] | null): boolean;
  /**
   * Asks for the next stretch of history, which the platform delivers through its webhook.
   *
   * @param cursor what the last request returned, or null to start.
   * @returns null when the platform isn't ready for this account yet.
   */
  requestHistory(accessToken: string, cursor: string | null, days: number): Promise<HistoryProgress | null>;

  /** The webhook path segments this platform sends to. */
  readonly webhookKinds: readonly string[];
  parseWebhook(kind: string, body: unknown): WebhookEvent[];
  mayRelayFiles(permissions: readonly string[] | null): boolean;
  /** Whether a bearer token may be sent to this file's address. A forged ping must never get one. */
  isDownloadAllowed(reference: unknown): boolean;
  downloadFile(accessToken: string, reference: unknown): Promise<DownloadedFile>;
}
