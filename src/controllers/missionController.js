import { asyncHandler } from "../middlewares/errorHandler.js";
import { UserMission } from "../models/UserMission.js";
import { Order } from "../models/Order.js";
import { Favorite } from "../models/Favorite.js";
import { Review } from "../models/Review.js";
import { User } from "../models/User.js";
import { Coupon } from "../models/Coupon.js";
import { MISSIONS } from "../config/missions.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

async function checkCondition(key, userId) {
  switch (key) {
    case "first_purchase":
      return (await Order.countDocuments({ user_id: userId })) > 0;

    case "complete_profile": {
      const user = await User.findById(userId).select("name phone rut").lean();
      return !!(user?.name && user?.phone && user?.rut);
    }

    case "five_favorites":
      return (await Favorite.countDocuments({ user_id: userId })) >= 5;

    case "leave_review":
      return (await Review.countDocuments({ user_id: userId })) > 0;

    case "share_app":
      // Auto-aprobada cuando el usuario usa el botón compartir en la app
      return true;

    default:
      return false;
  }
}

// GET /api/missions
export const listMissions = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const userMissions = await UserMission.find({ user_id: userId }).lean();
  const umMap = {};
  for (const um of userMissions) umMap[um.mission_key] = um;

  const missions = MISSIONS.map((m) => {
    const um = umMap[m.key];
    return {
      ...m,
      is_completed: !!um?.completed_at,
      completed_at: um?.completed_at || null,
      reward_claimed: !!um?.reward_claimed,
      reward_code: um?.reward_code || null,
    };
  });

  const completed = missions.filter((m) => m.is_completed).length;

  return res.status(200).json({
    success: true,
    data: { missions, stats: { completed, total: MISSIONS.length } },
  });
});

// POST /api/missions/:key/verify
export const verifyMission = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { key } = req.params;

  const mission = MISSIONS.find((m) => m.key === key);
  if (!mission) throw new NotFoundError("Misión no encontrada");

  const existing = await UserMission.findOne({ user_id: userId, mission_key: key }).lean();
  if (existing?.completed_at) {
    return res.status(200).json({
      success: true,
      data: { completed: true, already_done: true },
      message: "¡Misión ya completada!",
    });
  }

  const isComplete = await checkCondition(key, userId);

  if (!isComplete) {
    return res.status(200).json({
      success: true,
      data: { completed: false },
      message: "Misión aún no completada",
    });
  }

  await UserMission.findOneAndUpdate(
    { user_id: userId, mission_key: key },
    { $set: { completed_at: new Date() } },
    { upsert: true, new: true }
  );

  logger.info({ user_id: userId, mission_key: key }, "mission.completed");

  return res.status(200).json({
    success: true,
    data: { completed: true },
    message: `¡Misión "${mission.title}" completada! Ahora reclama tu recompensa.`,
  });
});

// POST /api/missions/:key/claim
export const claimReward = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { key } = req.params;

  const mission = MISSIONS.find((m) => m.key === key);
  if (!mission) throw new NotFoundError("Misión no encontrada");

  const um = await UserMission.findOne({ user_id: userId, mission_key: key });
  if (!um?.completed_at) throw new BadRequestError("Debes completar la misión primero");

  if (um.reward_claimed) {
    return res.status(200).json({
      success: true,
      data: { reward_code: um.reward_code },
      message: "Recompensa ya reclamada anteriormente",
    });
  }

  // Código único: MISION + clave corta + últimos 5 chars del userId
  const suffix = String(userId).slice(-5).toUpperCase();
  const code = `MISION${key.replace(/_/g, "").toUpperCase().slice(0, 6)}${suffix}`;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  // Upsert idempotente: si el cupón ya existe (reintento), lo reutiliza en vez de lanzar 409
  const coupon = await Coupon.findOneAndUpdate(
    { code },
    {
      $setOnInsert: {
        code,
        discount_type: mission.discount_type,
        discount_value: mission.discount_value,
        max_uses: 1,
        max_uses_per_user: 1,
        expires_at: expiresAt,
        is_active: true,
        allowed_user_id: userId,
      },
    },
    { upsert: true, new: true },
  );

  um.reward_claimed = true;
  um.reward_code = code;
  um.reward_coupon_id = coupon._id;
  await um.save();

  logger.info({ user_id: userId, mission_key: key, code }, "mission.reward_claimed");

  return res.status(200).json({
    success: true,
    data: { reward_code: code, expires_at: expiresAt },
    message: `¡Recompensa desbloqueada! Usa el código ${code} en tu próxima compra.`,
  });
});