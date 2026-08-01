import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import {
  addFavoriteSchema,
  favoriteParamsSchema,
  isFavoriteQuerySchema,
  listFavoritesQuerySchema,
} from "../validators/favoriteValidators.js";
import {
  listMyFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
} from "../controllers/favoriteController.js";

const router = Router();

router.use(protect);

router.get("/", validate({ query: listFavoritesQuerySchema }), listMyFavorites);
router.get("/check", validate({ query: isFavoriteQuerySchema }), isFavorite);
router.post("/", validate({ body: addFavoriteSchema }), addFavorite);
router.delete(
  "/:productId",
  validate({ params: favoriteParamsSchema }),
  removeFavorite
);

export default router;
