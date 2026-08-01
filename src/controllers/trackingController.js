import { asyncHandler } from "../middlewares/errorHandler.js";
import * as trackingService from "../services/trackingService.js";
import { ForbiddenError } from "../utils/errors.js";

export const getPublicTracking = asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const token = req.query.token || null;
  const userId = req.user?.id || null;

  if (!userId && !token) {
    throw new ForbiddenError("Se requiere login o token de tracking");
  }

  const data = await trackingService.getTrackingByToken({ orderId, token, userId });
  res.status(200).json({ success: true, data });
});

export const blueexpressWebhook = asyncHandler(async (req, res) => {
  const signature =
    req.headers["x-blueexpress-signature"] ||
    req.headers["x-signature"] ||
    null;

  const ok = trackingService.verifyBlueExpressSignature({
    rawBody: req.body,
    signature,
  });

  if (!ok) {
    return res
      .status(401)
      .json({ success: false, code: "INVALID_SIGNATURE", message: "Firma inválida" });
  }

  const result = await trackingService.processBlueExpressWebhook(req.body);
  res.status(200).json({ success: true, data: result });
});
