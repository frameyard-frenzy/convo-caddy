export const SECRET_ROLES = [
  "recall-api-key",
  "recall-webhook-verification-secret",
  "ngrok-authtoken",
  "hermes-api-key",
] as const;

export type SecretRole = (typeof SECRET_ROLES)[number];

export type SecretStoreErrorCode =
  | "invalid_request"
  | "missing"
  | "access_denied"
  | "unavailable"
  | "malformed"
  | "write_failed"
  | "delete_failed";

export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;

  constructor(code: SecretStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

export interface SecretStore {
  write(role: SecretRole, generation: string, secret: string): Promise<void>;
  read(role: SecretRole, generation: string): Promise<string>;
  delete(role: SecretRole, generation: string): Promise<"deleted" | "missing">;
}
