import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { logger } from "../utils/logger.js";

export const deleteEmptyCategories = async () => {
  logger.info("delete.empty_categories.started");

  const categories = await Category.find({}).lean();

  let deleted = 0;
  let kept = 0;

  for (const category of categories) {
    const productCount = await Product.countDocuments({
      "category.id": category._id.toString(),
    });

    if (productCount > 0) {
      kept += 1;
      continue;
    }

    await Category.deleteOne({ _id: category._id });
    deleted += 1;

    logger.debug(
      { name: category.name, id: category._id.toString() },
      "delete.empty_categories.deleted",
    );
  }

  logger.info(
    {
      total: categories.length,
      deleted,
      kept,
    },
    "delete.empty_categories.completed",
  );

  return {
    total: categories.length,
    deleted,
    kept,
  };
};

export default deleteEmptyCategories;