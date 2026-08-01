import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.js";

const extractToken = (req) => {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
};

// Presencia (para el tablero "Actividad en vivo"): marca last_seen con THROTTLE en
// memoria — a lo más un write por usuario cada 30s, sin castigar cada request.
const PRESENCE_THROTTLE_MS = 30_000;
const lastSeenWrite = new Map();
const touchPresence = (userId) => {
  const now = Date.now();
  const prev = lastSeenWrite.get(userId) || 0;
  if (now - prev < PRESENCE_THROTTLE_MS) return;
  lastSeenWrite.set(userId, now);
  // Fire-and-forget: la presencia jamás debe romper ni demorar el request.
  User.updateOne({ _id: userId }, { $set: { last_seen: new Date() } }).catch(() => {});
};

export const protect = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError("Token requerido");

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      throw new UnauthorizedError("Token inválido o expirado");
    }

    const user = await User.findById(decoded.id)
      .select("_id name email role is_active email_verified password_changed_at")
      .lean();
    if (!user) throw new UnauthorizedError("Usuario no encontrado");
    if (user.is_active === false)
      throw new ForbiddenError("Usuario desactivado");

    if (user.password_changed_at) {
      const tokenIssuedAt = decoded.iat * 1000; // JWT iat is in seconds
      if (tokenIssuedAt < user.password_changed_at.getTime()) {
        throw new UnauthorizedError("Sesión expirada, vuelve a iniciar sesión");
      }
    }
    req.user = {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      email_verified: user.email_verified,
    };
    touchPresence(String(user._id));
    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next();

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
      const user = await User.findById(decoded.id)
        .select("_id email role is_active email_verified")
        .lean();
      if (user && user.is_active !== false) {
        req.user = {
          id: String(user._id),
          email: user.email,
          role: user.role,
          email_verified: user.email_verified,
        };
      }
    } catch {
      // token inválido → se sigue como invitado
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * strictOptionalAuth
 *
 * Igual que optionalAuth EXCEPTO que si viene un token, lo valida estrictamente:
 * - Sin token           → continúa como invitado (guest checkout OK)
 * - Token válido        → setea req.user
 * - Token expirado      → retorna 401 → el interceptor de axios lo refresca y reintenta
 *
 * Usar en rutas que admiten invitados pero no deben silenciar tokens expirados
 * de usuarios autenticados (ej: POST /orders/from-cart).
 */
export const strictOptionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next(); // invitado genuino → OK

    // Hay token → validar estrictamente (igual que protect)
    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      return next(new UnauthorizedError("Token inválido o expirado"));
    }

    const user = await User.findById(decoded.id)
      .select("_id email role is_active email_verified password_changed_at")
      .lean();

    if (!user) return next(new UnauthorizedError("Usuario no encontrado"));
    if (user.is_active === false) return next(new ForbiddenError("Usuario desactivado"));

    if (user.password_changed_at) {
      const tokenIssuedAt = decoded.iat * 1000;
      if (tokenIssuedAt < user.password_changed_at.getTime()) {
        return next(new UnauthorizedError("Sesión expirada, vuelve a iniciar sesión"));
      }
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      email_verified: user.email_verified,
    };
    next();
  } catch (err) {
    next(err);
  }
};

export const requireEmailVerified = (req, res, next) => {
  if (!req.user?.email_verified) {
    return next(new ForbiddenError("Email no verificado"));
  }
  next();
};
