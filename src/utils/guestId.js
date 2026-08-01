import crypto from "node:crypto";
import { env } from "../config/env.js";

const SEP = ".";

export const issueGuestId = () => {
  const raw = crypto.randomUUID();
  const sig = crypto.createHmac("sha256", env.GUEST_ID_SECRET).update(raw).digest("hex").slice(0, 24);
  return `${raw}${SEP}${sig}`;
};

export const verifyGuestId = (value) => {
  if (typeof value !== "string" || !value.includes(SEP)) return null;
  const [raw, sig] = value.split(SEP);
  if (!raw || !sig) return null;
  const expected = crypto.createHmac("sha256", env.GUEST_ID_SECRET).update(raw).digest("hex").slice(0, 24);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? raw : null;
};
