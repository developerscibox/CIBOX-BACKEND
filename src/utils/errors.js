export class AppError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", details = null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Solicitud inválida", details = null) {
    super(message, 400, "BAD_REQUEST", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "No autenticado") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "No autorizado") {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Recurso no encontrado") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicto con el estado actual") {
    super(message, 409, "CONFLICT");
  }
}

export class UnprocessableError extends AppError {
  constructor(message = "Datos inválidos", details = null) {
    super(message, 422, "UNPROCESSABLE", details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Demasiadas solicitudes") {
    super(message, 429, "TOO_MANY_REQUESTS");
  }
}
