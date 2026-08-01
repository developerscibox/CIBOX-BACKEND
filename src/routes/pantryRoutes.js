import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import {
  addPantryItemSchema,
  updatePantryItemSchema,
  pantryItemParamsSchema,
  checkoutPantrySchema,
} from "../validators/pantryValidators.js";
import {
  getMyPantry,
  addItem,
  updateItem,
  removeItem,
  checkoutPantry,
} from "../controllers/pantryController.js";

const router = Router();

router.use(protect);

router.get("/", getMyPantry);
router.post("/items", validate({ body: addPantryItemSchema }), addItem);
router.patch(
  "/items/:productId",
  validate({ params: pantryItemParamsSchema, body: updatePantryItemSchema }),
  updateItem
);
router.delete(
  "/items/:productId",
  validate({ params: pantryItemParamsSchema }),
  removeItem
);
router.post(
  "/checkout",
  validate({ body: checkoutPantrySchema }),
  checkoutPantry
);

export default router;
