import { Router } from "express";
import { issueId } from "../controllers/guestController.js";

const router = Router();

router.get("/id", issueId);

export default router;