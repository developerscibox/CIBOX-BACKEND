import { Product } from "../models/Product.js";
import { Vendor } from "../models/Vendor.js";
import { Category } from "../models/Category.js";
import { normalizeText } from "../utils/normalizeText.js";
import { logger } from "../utils/logger.js";

const products = [
    { sku: "14103", name: "CARNE DE SOJA 300G", weightKg: 0.3, length: 10, width: 10, height: 10, price: 2759, categoryPath: "Productos veganos", images: ["https://cibox.cl/wp-content/uploads/2026/01/CARNE-DE-SOJA-300G.jpg"], brand: "ABASTO", unitLabel: "unidad" },
];
const buildDescription = (name, brand, categoryName) => {
  return `${name}${brand ? ` de marca ${brand}` : ""}${
    categoryName ? ` en categoría ${categoryName}` : ""
  }.`;
};

const findApprovedVendor = async () => {
  const vendor = await Vendor.findOne({
    is_active: true,
  }).lean();

  if (!vendor) {
    throw new Error("No existe un vendor activo para asignar a los productos");
  }

  const vendorName =
    vendor.name ||
    vendor.store_name ||
    vendor.business_name ||
    vendor.shop_name ||
    vendor.company_name ||
    "Aletheia Fit";

  return {
    id: String(vendor._id),
    name: vendorName,
  };
};
const resolveCategoryByPath = async (categoryPath) => {
  if (!categoryPath) {
    throw new Error("Falta categoryPath en un producto");
  }

  const parts = categoryPath
    .split(">")
    .map((item) => item.trim())
    .filter(Boolean);

  let parent = null;
  let found = null;

  for (const part of parts) {
    found = await Category.findOne({
      name: part,
      parent_id: parent ? parent._id : null,
      is_active: true,
    });

    if (!found) {
      throw new Error(
        `No se encontró la categoría/subcategoría: ${categoryPath}`,
      );
    }

    parent = found;
  }

  return found;
};

const upsertProduct = async (rawProduct, vendorData) => {
  const category = await resolveCategoryByPath(rawProduct.categoryPath);

  const images = Array.isArray(rawProduct.images) ? rawProduct.images : [];
  const thumbnail = images[0] || "";

  const payload = {
    vendor: vendorData,
    product_type: "simple",
    name: rawProduct.name,
    images,
    thumbnail,
    search_name: normalizeText(rawProduct.name),
    description: buildDescription(
      rawProduct.name,
      rawProduct.brand,
      category.name,
    ),
    category: {
      id: category._id.toString(),
      name: category.name,
    },
    pricing: {
      tiers: [
        {
          min_qty: 1,
          price: Number(rawProduct.price),
          label: rawProduct.unitLabel || "unidad",
        },
      ],
    },
    box_items: [],
    stock: 25,
    is_active: true,
    cibox_plus: {
      enabled: false,
    },
    sku: rawProduct.sku || "",
    brand: rawProduct.brand || "",
    weight: {
      value: Math.round(Number(rawProduct.weightKg || 0) * 1000),
      unit: "g",
    },
    dimensions: {
      length: Number(rawProduct.length || 0),
      width: Number(rawProduct.width || 0),
      height: Number(rawProduct.height || 0),
      unit: "cm",
    },
  };

  const product = await Product.findOneAndUpdate(
    {
      name: rawProduct.name,
      "vendor.id": vendorData.id,
    },
    payload,
    {
      returnDocument: "after",
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    },
  );

  return product;
};

/**
 * Sembrado de productos. Asume conexión a Mongo abierta y vendor aprobado.
 * NO se invoca automáticamente al importar.
 */
export const seedProducts = async () => {
  const vendorData = await findApprovedVendor();
  logger.info({ vendor: vendorData }, "seed.products.vendor_resolved");

  let ok = 0;
  let failed = 0;

  for (const item of products) {
    try {
      const product = await upsertProduct(item, vendorData);
      logger.debug({ name: product.name }, "seed.products.upsert_ok");
      ok += 1;
    } catch (err) {
      logger.error(
        { err: { message: err.message }, name: item.name },
        "seed.products.upsert_failed",
      );
      failed += 1;
    }
  }

  logger.info(
    { ok, failed, total: products.length },
    "seed.products.completed",
  );
  return { ok, failed, total: products.length };
};

export default seedProducts;
