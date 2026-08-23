import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { User } from "../models/User.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from "../utils/errors.js";
import { BCRYPT_ROUNDS } from "../utils/constants.js";
import { sendEmail } from "./emailService.js";
import {
  buildVerificationTemplate,
  buildResetPasswordTemplate,
} from "../utils/emailTemplates.js";

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d (default; el JWT lleva su propio exp)
const MAX_REFRESH_HASHES_PER_USER = 10;

// ---------- helpers de criptografía y tokens ----------

export const hashPassword = (plain) => bcrypt.hash(String(plain), BCRYPT_ROUNDS);

export const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

export const generateSecureToken = () =>
  crypto.randomBytes(32).toString("hex");

export const signAccessToken = (user) =>
  jwt.sign(
    { id: String(user._id), email: user.email, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES }
  );

export const signRefreshToken = (user) =>
  jwt.sign(
    { id: String(user._id), type: "refresh" },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES }
  );

export const verifyRefreshToken = (token) => {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] });
    if (decoded.type !== "refresh") {
      throw new UnauthorizedError("Refresh token inválido");
    }
    return decoded;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Refresh token inválido o expirado");
  }
};

// ---------- sanitización ----------

const sanitizeUser = (user) => {
  if (!user) return null;
  const obj = typeof user.toObject === "function" ? user.toObject() : { ...user };
  delete obj.password_hash;
  delete obj.refresh_token_hashes;
  delete obj.email_verification_token_hash;
  delete obj.email_verification_expires;
  delete obj.reset_password_token_hash;
  delete obj.reset_password_expires;
  delete obj.__v;
  return obj;
};

// ---------- registro ----------

export const registerUser = async ({ name, email, password, phone = null, rut = null }) => {
  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await User.findOne({ email: normalizedEmail }).select("_id").lean();
  if (existing) {
    throw new ConflictError("El correo ya está registrado");
  }

  const password_hash = await hashPassword(password);
  const verificationToken = generateSecureToken();
  const verificationHash = hashToken(verificationToken);

  const user = await User.create({
    name: String(name).trim(),
    email: normalizedEmail,
    password_hash,
    phone: phone ? String(phone).trim() : null,
    rut: rut ? String(rut).trim() : null,
    email_verified: false,
    email_verification_token_hash: verificationHash,
    email_verification_expires: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
  });

  const verifyUrl = `${env.FRONTEND_URL.replace(/\/+$/, "")}/auth/verify-email?token=${verificationToken}`;
  const tpl = buildVerificationTemplate({ name: user.name, verifyUrl });

  // No bloquea el registro si el email falla; emailService loguea el error.
  await sendEmail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });

  return sanitizeUser(user);
};

// ---------- refresh tokens (helpers internos) ----------

const persistRefreshHash = async (userId, refreshToken, device = null) => {
  const decoded = jwt.decode(refreshToken);
  const expSeconds = decoded?.exp;
  const expires_at = expSeconds
    ? new Date(expSeconds * 1000)
    : new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const hash = hashToken(refreshToken);

  await User.updateOne(
    { _id: userId },
    {
      $push: {
        refresh_token_hashes: {
          $each: [{ hash, created_at: new Date(), expires_at, device, revoked: false }],
          $slice: -MAX_REFRESH_HASHES_PER_USER,
        },
      },
    }
  );
};

const findActiveRefreshHash = (user, refreshToken) => {
  const hash = hashToken(refreshToken);
  const entry = (user.refresh_token_hashes || []).find(
    (e) => e.hash === hash && !e.revoked && (!e.expires_at || e.expires_at > new Date())
  );
  return entry || null;
};

// ---------- login ----------

export const loginUser = async ({ email, password, device = null }) => {
  const normalizedEmail = String(email).trim().toLowerCase();

  // Necesitamos password_hash y refresh_token_hashes para esta operación
  const user = await User.findOne({ email: normalizedEmail }).select(
    "+refresh_token_hashes name email password_hash role phone rut email_verified is_active created_at updated_at"
  );

  if (!user) {
    throw new UnauthorizedError("Credenciales inválidas");
  }

  if (user.is_active === false) {
    throw new ForbiddenError("Usuario desactivado");
  }

  const ok = await user.comparePassword(password);
  if (!ok) {
    throw new UnauthorizedError("Credenciales inválidas");
  }

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await persistRefreshHash(user._id, refreshToken, device);

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken,
  };
};

// ---------- refresh ----------

export const refreshTokens = async (refreshToken, device = null) => {
  const decoded = verifyRefreshToken(refreshToken);

  const user = await User.findById(decoded.id).select(
    "+refresh_token_hashes name email role is_active email_verified"
  );
  if (!user || user.is_active === false) {
    throw new UnauthorizedError("Usuario inválido");
  }

  const entry = findActiveRefreshHash(user, refreshToken);
  if (!entry) {
    // El JWT es válido y no expirado, pero su hash ya no está activo
    // (rotado/revocado) => posible reuso de token comprometido.
    // Revocar TODOS los refresh tokens del usuario y forzar re-login.
    await User.updateOne(
      { _id: user._id },
      { $set: { "refresh_token_hashes.$[].revoked": true } }
    );
    logger.warn(
      { userId: String(user._id) },
      "refresh-token reuse detected: revocando todos los refresh tokens"
    );
    throw new UnauthorizedError("Sesión comprometida: vuelve a iniciar sesión");
  }

  // Rotar: revocar el actual y emitir uno nuevo
  await User.updateOne(
    { _id: user._id, "refresh_token_hashes.hash": entry.hash },
    { $set: { "refresh_token_hashes.$.revoked": true } }
  );

  const newAccess = signAccessToken(user);
  const newRefresh = signRefreshToken(user);
  await persistRefreshHash(user._id, newRefresh, device);

  return { accessToken: newAccess, refreshToken: newRefresh };
};

// ---------- logout ----------

export const logoutUser = async (userId, refreshToken) => {
  if (!refreshToken) return { revoked: false };
  const hash = hashToken(refreshToken);
  const result = await User.updateOne(
    { _id: userId, "refresh_token_hashes.hash": hash },
    { $set: { "refresh_token_hashes.$.revoked": true } }
  );
  return { revoked: result.modifiedCount > 0 };
};

// ---------- forgot / reset ----------

export const requestPasswordReset = async (email) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return { ok: true };

  const user = await User.findOne({ email: normalizedEmail });
  if (!user || user.is_active === false) {
    // Anti-enumeration: respuesta uniforme
    logger.info({ email: normalizedEmail }, "forgot-password: usuario no encontrado/inactivo");
    return { ok: true };
  }

  const token = generateSecureToken();
await User.updateOne(
  { _id: user._id },
  {
    $set: {
      reset_password_token_hash: hashToken(token),
      reset_password_expires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  },
  { runValidators: false }
);

  const resetUrl = `${env.FRONTEND_URL.replace(/\/+$/, "")}/auth/reset-password?token=${token}`;
  const tpl = buildResetPasswordTemplate({ name: user.name, resetUrl });

  await sendEmail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });

  return { ok: true };
};

export const resetPassword = async (token, newPassword) => {
  if (!token) throw new BadRequestError("Token requerido");

  const tokenHash = hashToken(token);

  const user = await User.findOne({
    reset_password_token_hash: tokenHash,
    // Sin mongoose.trusted el sanitizeFilter global lo vuelve
    // { $eq: { $ne: false } } y castear ese objeto al Boolean is_active tira
    // CastError: restablecer la contraseña fallaba SIEMPRE con 400.
    is_active: mongoose.trusted({ $ne: false }),
  }).select(
    "+refresh_token_hashes name email role password_hash reset_password_token_hash reset_password_expires"
  );

  if (!user) {
    throw new BadRequestError("Token inválido o expirado");
  }




  if (
    !user.reset_password_expires ||
    new Date(user.reset_password_expires).getTime() <= Date.now()
  ) {
    throw new BadRequestError("Token inválido o expirado");
  }

  user.password_hash = await hashPassword(newPassword);
  user.password_changed_at = new Date();
  user.reset_password_token_hash = null;
  user.reset_password_expires = null;

  if (Array.isArray(user.refresh_token_hashes)) {
    user.refresh_token_hashes = user.refresh_token_hashes.map((e) => ({
      ...(typeof e.toObject === "function" ? e.toObject() : e),
      revoked: true,
    }));
  }

  await user.save();

  return { ok: true };
};

// ---------- verificación de email ----------

export const verifyEmail = async (token) => {
  if (!token) throw new BadRequestError("Token requerido");

  const tokenHash = hashToken(token);

  const user = await User.findOne({
    email_verification_token_hash: tokenHash,
    // Mismo CastError que en resetPassword: verificar el correo nunca funcionó.
    is_active: mongoose.trusted({ $ne: false }),
  });

  if (!user) {
    throw new BadRequestError("Token inválido o expirado");
  }

  if (
    !user.email_verification_expires ||
    new Date(user.email_verification_expires).getTime() <= Date.now()
  ) {
    throw new BadRequestError("Token inválido o expirado");
  }

  user.email_verified = true;
  user.email_verification_token_hash = null;
  user.email_verification_expires = null;

  await user.save();

  return { ok: true };
};
export const resendVerification = async (email) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return { ok: true };

  const user = await User.findOne({ email: normalizedEmail });
  // Anti-enumeration: respuesta uniforme aun si no existe o ya está verificado
  if (!user || user.is_active === false) {
    logger.info({ email: normalizedEmail }, "resend-verification: usuario no encontrado/inactivo");
    return { ok: true };
  }
  if (user.email_verified) {
    logger.info({ email: normalizedEmail }, "resend-verification: ya verificado");
    return { ok: true };
  }

  const token = generateSecureToken();
  user.email_verification_token_hash = hashToken(token);
  user.email_verification_expires = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await user.save();

  const verifyUrl = `${env.FRONTEND_URL.replace(/\/+$/, "")}/auth/verify-email?token=${token}`;
  const tpl = buildVerificationTemplate({ name: user.name, verifyUrl });
  await sendEmail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });

  return { ok: true };
};

// ---------- perfil / cambio de password ----------

export const updateProfile = async (userId, { name, phone, rut }) => {
  const update = {};
  if (typeof name === "string" && name.trim()) update.name = name.trim();
  if (typeof phone === "string") update.phone = phone.trim() || null;
  if (typeof rut === "string") update.rut = rut.trim() || null;

  if (Object.keys(update).length === 0) {
    throw new BadRequestError("Nada que actualizar");
  }

  const user = await User.findByIdAndUpdate(userId, { $set: update }, {
    new: true,
    runValidators: true,
  });
  if (!user) throw new UnauthorizedError("Usuario no encontrado");
  return sanitizeUser(user);
};

export const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await User.findById(userId).select(
    "+refresh_token_hashes name email role password_hash"
  );
  if (!user) throw new UnauthorizedError("Usuario no encontrado");

  const ok = await user.comparePassword(currentPassword);
  if (!ok) throw new UnauthorizedError("Contraseña actual incorrecta");

  user.password_hash = await hashPassword(newPassword);
  user.password_changed_at = new Date();

  // Revocar todos los refresh tokens
  if (Array.isArray(user.refresh_token_hashes)) {
    user.refresh_token_hashes = user.refresh_token_hashes.map((e) => ({
      ...(typeof e.toObject === "function" ? e.toObject() : e),
      revoked: true,
    }));
  }

  await user.save();
  return { ok: true };
};

export const getProfile = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new UnauthorizedError("Usuario no encontrado");
  return sanitizeUser(user);
};
