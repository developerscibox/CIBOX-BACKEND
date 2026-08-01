import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";
import {
  createCustomBoxSchema,
  updateCustomBoxSchema,
  customBoxParamsSchema,
  customBoxItemParamsSchema,
  addItemSchema,
  updateItemSchema,
  listCustomBoxesQuerySchema,
} from "../validators/customBoxValidators.js";
import {
  createCustomBox,
  getMyCustomBoxes,
  getCustomBoxById,
  updateCustomBox,
  deleteCustomBox,
  addItem,
  updateItem,
  removeItem,
} from "../controllers/customBoxController.js";

const router = Router();

router.use(optionalAuth);

router.get("/", validate({ query: listCustomBoxesQuerySchema }), getMyCustomBoxes);
router.post("/", validate({ body: createCustomBoxSchema }), createCustomBox);
router.get(
  "/:id",
  validate({ params: customBoxParamsSchema }),
  getCustomBoxById
);
router.patch(
  "/:id",
  validate({ params: customBoxParamsSchema, body: updateCustomBoxSchema }),
  updateCustomBox
);
router.delete(
  "/:id",
  validate({ params: customBoxParamsSchema }),
  deleteCustomBox
);

router.post(
  "/:id/items",
  validate({ params: customBoxParamsSchema, body: addItemSchema }),
  addItem
);
router.patch(
  "/:id/items/:productId",
  validate({ params: customBoxItemParamsSchema, body: updateItemSchema }),
  updateItem
);
router.delete(
  "/:id/items/:productId",
  validate({ params: customBoxItemParamsSchema }),
  removeItem
);

export default router;
