import { asyncHandler } from "../middlewares/errorHandler.js";
import { Product } from "../models/Product.js";
import { User } from "../models/User.js";
import { NotFoundError } from "../utils/errors.js";
import { calculateItemPricing } from "../services/pricingService.js";

export const calculateItemPricingHandler = asyncHandler(async (req, res) => {
  const { productId, quantity } = req.query;
  const fromPantry =
    req.query.fromPantry === true || req.query.fromPantry === "true";

  const product = await Product.findById(productId);
  if (!product || product.is_active === false) {
    throw new NotFoundError("Producto no encontrado o inactivo");
  }

  const user = req.user?.id ? await User.findById(req.user.id).lean() : null;

  const pricing = calculateItemPricing({
    tiers: product.pricing.tiers,
    quantity: Number(quantity),
    product,
    user,
    fromPantry,
  });

  return res.status(200).json({
    success: true,
    data: {
      product: {
        id: String(product._id),
        name: product.name,
        cibox_plus_enabled: product.cibox_plus?.enabled || false,
      },
      pricing,
    },
  });
});
