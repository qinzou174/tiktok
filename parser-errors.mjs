const INFRASTRUCTURE_ERROR_PATTERN = /failed to connect|failed to connecting|connection.*(?:timed out|refused|reset)|timeout|timed out|upstream|bad gateway|service unavailable|automated traffic|identity (?:has been )?cooled down|no identity is available|identity pool/i;

export function isParserInfrastructureFailure(message) {
  return INFRASTRUCTURE_ERROR_PATTERN.test(String(message || ""));
}
