const AUDIT_ENV_KEY = "GSD_UOK_AUDIT_UNIFIED";

export function setUnifiedAuditEnabled(enabled: boolean): void {
  process.env[AUDIT_ENV_KEY] = enabled ? "1" : "0";
}

export function isUnifiedAuditEnabled(): boolean {
  return process.env[AUDIT_ENV_KEY] === "1";
}
