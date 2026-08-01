import { asyncHandler } from "../middlewares/errorHandler.js";
import { issueGuestId } from "../utils/guestId.js";
import { logger } from "../utils/logger.js";

export const issueId = asyncHandler(async (req, res) => {
  const guest_id = issueGuestId();
  logger.debug({ req_id: req.id }, "guest.id.issued");
  res.status(200).json({
    success: true,
    data: { guest_id },
    message: "Guest ID emitido",
  });
});
