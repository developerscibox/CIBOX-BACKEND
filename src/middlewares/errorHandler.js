import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    code: "NOT_FOUND",
    message: `Ruta ${req.method} ${req.originalUrl} no encontrada`,
  });
};

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "Error interno del servidor";
  let details = null;

  if (err instanceof ZodError) {
    statusCode = 422;
    code = "VALIDATION_ERROR";
    message = "Datos inválidos";
    details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 422;
    code = "VALIDATION_ERROR";
    message = "Validación de base de datos falló";
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = 400;
    code = "INVALID_ID";
    message = `ID inválido para ${err.path}`;
  } else if (err?.code === 11000) {
    statusCode = 409;
    code = "DUPLICATE_KEY";
    message = "Recurso duplicado";
    details = Object.keys(err.keyValue || {}).map((k) => ({ path: k }));
  }

  const logPayload = {
    req: { method: req.method, url: req.originalUrl, id: req.id },
    err: { message: err.message, stack: err.stack, code, statusCode },
  };

  if (statusCode >= 500) logger.error(logPayload, "request failed");
  else logger.warn(logPayload, "request rejected");

  res.status(statusCode).json({
    success: false,
    code,
    message,
    details,
  });
};
