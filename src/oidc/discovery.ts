import type { PlatformContext } from "../context";

export function discovery(c: PlatformContext): Response {
  const { issuer } = c.var;
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    registration_endpoint: `${issuer}/register`,
    sweatstack_disconnect_endpoint: `${issuer}/disconnect`,
    scopes_supported: ["openid"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  });
}
