type Field = string | number | boolean | null;

/**
 * The one way to log, so a secret can't arrive inside an object or an error message. Never pass a
 * token, a platform's file URL or a request URL: the webhook path holds a secret.
 */
export function log(event: string, fields: Record<string, Field> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
