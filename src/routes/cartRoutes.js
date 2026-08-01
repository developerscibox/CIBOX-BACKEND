import { Router } from "express";
import { optionalAuth } from "../middlewares/authMiddleware.js";
import { validate } from "../middlewares/validate.js";
import {
  addItemSchema,
  updateItemSchema,
  removeItemSchema,
} from "../validators/cartValidators.js";
import {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
} from "../controllers/cartController.js";

const router = Router();

router.use(optionalAuth);

router.get("/", getCart);
router.post("/items", validate(addItemSchema), addItem);
router.patch("/items/:productId", validate(updateItemSchema), updateItem);
router.delete("/items/:productId", validate(removeItemSchema), removeItem);
router.delete("/", clearCart);

export default router;
