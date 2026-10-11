/** Stable error codes the apps map to UI messages. */
export type ErrorCode =
  | "VALIDATION_FAILED" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED"
  | "INVALID_CREDENTIALS" | "TWO_FACTOR_REQUIRED" | "TWO_FACTOR_INVALID" | "OTP_INVALID" | "TOKEN_INVALID"
  | "ACCOUNT_BLOCKED" | "EMAIL_TAKEN" | "OUT_OF_STOCK" | "COUPON_INVALID" | "COUPON_EXPIRED" | "COUPON_MIN_SUBTOTAL"
  | "COUPON_LIMIT_REACHED" | "INSUFFICIENT_POINTS" | "INSUFFICIENT_WALLET_BALANCE" | "WALLET_FROZEN"
  | "RETURN_WINDOW_CLOSED" | "DROP_NOT_OPEN" | "ALREADY_RESERVED" | "QUOTE_EXPIRED" | "PAYMENT_FAILED"
  | "IDEMPOTENCY_IN_PROGRESS" | "MAINTENANCE_MODE" | "INVALID_STATE" | "UNSUPPORTED_FILE" | "INTERNAL";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown) {
    return new ApiError(400, code, message, details);
  }
  static unauthenticated(message = "Please sign in to continue.") {
    return new ApiError(401, "UNAUTHENTICATED", message);
  }
  static forbidden(message = "You don't have permission to do that.") {
    return new ApiError(403, "FORBIDDEN", message);
  }
  static notFound(what = "Resource") {
    return new ApiError(404, "NOT_FOUND", `${what} not found.`);
  }
  static conflict(code: ErrorCode, message: string, details?: unknown) {
    return new ApiError(409, code, message, details);
  }
  static unprocessable(code: ErrorCode, message: string, details?: unknown) {
    return new ApiError(422, code, message, details);
  }
}
