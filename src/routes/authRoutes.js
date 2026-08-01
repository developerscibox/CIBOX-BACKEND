import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import { authLimiter, emailLimiter } from "../middlewares/rateLimiters.js";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  refreshTokenSchema,
  updateProfileSchema,
  changePasswordSchema,
} from "../validators/authValidators.js";
import {
  register,
  login,
  logout,
  refresh,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  me,
  updateProfile,
  changePassword,
} from "../controllers/authController.js";

const router = Router();

router.post("/register", authLimiter, validate({ body: registerSchema }), register);
router.post("/login", authLimiter, validate({ body: loginSchema }), login);

router.post("/logout", protect, validate({ body: refreshTokenSchema }), logout);
// authLimiter (salta los exitosos): acota reintentos de refresh con token robado/inválido.
router.post("/refresh", authLimiter, validate({ body: refreshTokenSchema }), refresh);

router.get("/verify-email", validate({ query: verifyEmailSchema }), verifyEmail);
router.post(
  "/resend-verification",
  emailLimiter,
  validate({ body: resendVerificationSchema }),
  resendVerification
);

router.post(
  "/forgot-password",
  emailLimiter,
  validate({ body: forgotPasswordSchema }),
  forgotPassword
);
router.post(
  "/reset-password",
  authLimiter,
  validate({ body: resetPasswordSchema }),
  resetPassword
);

router.get("/me", protect, me);
router.patch("/me", protect, validate({ body: updateProfileSchema }), updateProfile);
router.post(
  "/change-password",
  protect,
  validate({ body: changePasswordSchema }),
  changePassword
);

export default router;
