export class ConversionTaskError extends Error {
  constructor(message: string, readonly code: "invalid_request" | "not_found" | "conflict") {
    super(message);
  }
}
