/** Everything core code knows about a platform. It grows with the milestones that use it. */
export interface Provider {
  /** The name SweatStack knows the platform by, and the path segment of its routes. */
  name: string;
  label: string;
  /** The settings this platform can't run without: their names, for telling the owner what's missing. */
  requiredSettings: readonly string[];
}
