import { verifyGuestId } from "./guestId.js";

export const getRequestIdentity = (req) => {
  const userId = req.user?.id || null;
  const rawGuest = req.headers["x-guest-id"] || null;
  const guestId = rawGuest ? verifyGuestId(rawGuest) : null;
  return { userId, guestId };
};

export const getOwnerFilter = (req) => {
  const { userId, guestId } = getRequestIdentity(req);
  if (userId) return { user_id: userId };
  if (guestId) return { guest_id: guestId };
  return null;
};

export const getOwnerAssign = (req) => {
  const { userId, guestId } = getRequestIdentity(req);
  return {
    user_id: userId,
    guest_id: userId ? null : guestId,
  };
};

export const assertOwner = (req, doc) => {
  if (!doc) return false;
  const { userId, guestId } = getRequestIdentity(req);
  if (userId && String(doc.user_id) === String(userId)) return true;
  if (guestId && doc.guest_id && String(doc.guest_id) === String(guestId)) return true;
  return false;
};
