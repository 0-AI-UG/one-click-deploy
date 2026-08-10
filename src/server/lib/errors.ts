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

export class ConfirmationError extends Error {
  constructor(
    message = "Browser confirmation required",
    public readonly requirement?: {
      action: string;
      resource_type: string;
      resource_id: string;
    },
  ) {
    super(message);
  }
}
