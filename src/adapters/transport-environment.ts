/** Transport settings are not model credentials or executable hooks.
 * Preserve explicit proxy / CA configuration without accepting TLS bypasses. */
export const TRANSPORT_ENVIRONMENT_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE',
] as const;
