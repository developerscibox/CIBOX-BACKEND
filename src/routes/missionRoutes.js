import { Router } from "express";
import { protect } from "../middlewares/authMiddleware.js";
import { listMissions, verifyMission, claimReward } from "../controllers/missionController.js";

const router = Router();

router.use(protect);

router.get("/", listMissions);
router.post("/:key/verify", verifyMission);
router.post("/:key/claim", claimReward);

export default router;