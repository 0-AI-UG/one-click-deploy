export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
  }
}

export class PermissionError extends Error {
  constructor(message = "Insufficient permissions") {
    super(message);
  }
}
