/**
 * Uniform 400-class for API input validation. Routes catch it and map it to
 * a plain { error } JSON response; anything else is a real 500.
 */
export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiValidationError';
  }
}
