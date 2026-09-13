import { asyncHandler } from "../middlewares/errorHandler.js";
import * as authService from "../services/authService.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from "../utils/refreshCookie.js";

// ¿Exponer el refresh token en el body de la respuesta? En producción los clientes
// WEB dependen EXCLUSIVAMENTE de la cookie httpOnly (cibox_rt): el refresh token no
// debe viajar por body porque un XSS podría leerlo/exfiltrarlo. Nativo (sin cookie
// fiable) y dev (cookie cross-origin que no viaja) sí lo reciben por body.
// En producción el refresh viaja en el body SOLO para la app nativa, que se
// identifica explícitamente (client.js manda Platform.OS: "ios" | "android").
// Todo lo demás —tienda web, panel, o una petición sin cabecera— lo recibe
// únicamente en la cookie httpOnly. La regla anterior era al revés ("todo
// salvo web/panel") y un script inyectado en la tienda podía pedir el refresh
// omitiendo la cabecera y leerlo del body: la protección dependía de una
// cabecera que controlaba el mismo cliente al que se quería proteger.
const CLIENTES_NATIVOS = new Set(["ios", "android"]);
const exposeRefreshInBody = (req) =>
  !env.isProd || CLIENTES_NATIVOS.has(String(req.headers["x-client-platform"] || ""));

export const register = asyncHandler(async (req, res) => {
  const user = await authService.registerUser(req.body);
  res.status(201).json({
    success: true,
    data: { user },
    message: "Usuario registrado. Revisa tu correo para verificar tu cuenta.",
  });
});

export const login = asyncHandler(async (req, res) => {
  const device = req.headers["user-agent"] || null;
  const { user, accessToken, refreshToken } = await authService.loginUser({
    email: req.body.email,
    password: req.body.password,
    device,
  });
  // Refresh token como cookie httpOnly (inaccesible a JS → mitiga XSS). En el body
  // solo para nativo/dev (ver exposeRefreshInBody); web de prod usa solo la cookie.
  setRefreshCookie(req, res, refreshToken);
  res.status(200).json({
    success: true,
    data: { user, accessToken, ...(exposeRefreshInBody(req) ? { refreshToken } : {}) },
    message: "Login exitoso",
  });
});

export const logout = asyncHandler(async (req, res) => {
  const rt = readRefreshCookie(req) || req.body.refreshToken;
  await authService.logoutUser(req.user.id, rt);
  clearRefreshCookie(req, res);
  res.status(200).json({
    success: true,
    message: "Sesión cerrada",
  });
});

export const refresh = asyncHandler(async (req, res) => {
  const device = req.headers["user-agent"] || null;
  // Preferir la cookie httpOnly; caer al body para clientes/dev sin cookie.
  const desdeCookie = readRefreshCookie(req);
  const rt = desdeCookie || req.body.refreshToken;
  const tokens = await authService.refreshTokens(rt, device);
  setRefreshCookie(req, res, tokens.refreshToken);
  const data = { ...tokens };
  // El refresh nuevo vuelve por donde llegó el viejo: si vino en la cookie, no
  // se devuelve en el body aunque el cliente diga ser nativo.
  if (desdeCookie || !exposeRefreshInBody(req)) delete data.refreshToken;
  res.status(200).json({
    success: true,
    data,
    message: "Tokens renovados",
  });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  await authService.verifyEmail(req.query.token);
  res.status(200).json({
    success: true,
    message: "Correo verificado correctamente",
  });
});

export const resendVerification = asyncHandler(async (req, res) => {
  await authService.resendVerification(req.body.email);
  // Siempre 200 — anti-enumeration
  res.status(200).json({
    success: true,
    message: "Si el correo existe y no está verificado, recibirás un nuevo enlace.",
  });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  logger.debug({ email: req.body?.email }, "forgotPassword request");
  await authService.requestPasswordReset(req.body.email);
  // Siempre 200 — anti-enumeration
  res.status(200).json({
    success: true,
    message: "Si el correo existe, recibirás instrucciones para restablecer tu contraseña.",
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  res.status(200).json({
    success: true,
    message: "Contraseña actualizada correctamente",
  });
});

export const me = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.user.id);
  res.status(200).json({
    success: true,
    data: { user },
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const user = await authService.updateProfile(req.user.id, req.body);
  res.status(200).json({
    success: true,
    data: { user },
    message: "Perfil actualizado",
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(
    req.user.id,
    req.body.currentPassword,
    req.body.newPassword
  );
  res.status(200).json({
    success: true,
    message: "Contraseña actualizada. Vuelve a iniciar sesión.",
  });
});
