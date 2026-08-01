import { Category } from "../models/Category.js";
import { generateSlug } from "../utils/review.js";
import { logger } from "../utils/logger.js";

const categories = [
  { name: "Cajas cibox", is_featured: true, children: [] },
  { name: "Chocolates y Galletas", is_featured: true, children: [] },
  { name: "Cuidado personal", is_featured: false, children: [] },
  {
    name: "Despensa",
    is_featured: false,
    children: [
      "Aceites y grasas",
      "Acetos, sucedáneos y vinagres",
      "Ajíes",
      "Arroces y pastas",
      "Azúcar y endulzantes",
      "Cereales",
      "Condimentos y especias",
      "Conservas",
      "Cremas dulces",
      "Embalaje",
      "Encurtidos",
      "Harinas y repostería",
      "Legumbres",
      "Listos para consumir",
      "Postres",
      "Productos orgánicos",
      "Salsas, aderezos y snacks",
      "Té y café",
    ],
  },
  {
    name: "Frutas y Verduras",
    is_featured: false,
    children: [
      "Frutas",
      "Frutas confitadas",
      "Frutas deshidratadas",
      "Frutos secos",
      "Verduras",
    ],
  },
  {
    name: "Lácteos, Huevos",
    is_featured: false,
    children: [
      "Cremas",
      "Helados",
      "Huevos",
      "Lácteos sin lactosa",
      "Lácteos vegetales",
      "Leche",
      "Mantequilla, margarina y manteca",
      "Quesos",
    ],
  },
  {
    name: "Licores, Bebidas y Aguas",
    is_featured: false,
    children: [
      "Aguas",
      "Bebidas",
      "Cervezas",
      "Destilados",
      "Jugos",
      "Licores",
      "Vinos",
    ],
  },
  {
    name: "Limpieza",
    is_featured: false,
    children: [
      "Accesorios de limpieza",
      "Ambientadores",
      "Desinfectantes",
      "Detergentes",
      "Limpieza de baños",
      "Limpieza de cocina",
      "Limpieza de pisos",
      "Logía",
    ],
  },
  { name: "Pollo", is_featured: false, children: [] },
  { name: "Productos artesanales", is_featured: false, children: [] },
  { name: "Productos de cocina", is_featured: false, children: [] },
  { name: "Productos veganos", is_featured: false, children: [] },
  { name: "Supermercado", is_featured: false, children: [] },
];

const upsertCategory = async ({
  name,
  image_url = null,
  is_featured = false,
  is_active = true,
  parent_id = null,
}) => {
  const slug = generateSlug(name);
  return Category.findOneAndUpdate(
    { slug },
    {
      $set: {
        name,
        image_url,
        is_featured,
        is_active,
        parent_id,
      },
      $setOnInsert: { slug },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

/**
 * Seed de categorías. Asume conexión a Mongo abierta.
 * NO se invoca automáticamente al importar.
 */
export const seedCategories = async () => {
  let ok = 0;
  let failed = 0;

  for (const item of categories) {
    try {
      const parent = await upsertCategory({
        name: item.name,
        image_url: item.image_url || null,
        is_featured: item.is_featured ?? false,
        is_active: true,
        parent_id: null,
      });
      logger.debug({ name: parent.name }, "seed.categories.parent_ok");
      ok += 1;

      if (Array.isArray(item.children) && item.children.length) {
        for (const childName of item.children) {
          try {
            const child = await upsertCategory({
              name: childName,
              parent_id: parent._id,
              is_featured: false,
              is_active: true,
            });
            logger.debug(
              { name: child.name, parent: parent.name },
              "seed.categories.child_ok"
            );
            ok += 1;
          } catch (err) {
            logger.error(
              { err: { message: err.message }, child: childName, parent: item.name },
              "seed.categories.child_failed"
            );
            failed += 1;
          }
        }
      }
    } catch (err) {
      logger.error(
        { err: { message: err.message }, name: item.name },
        "seed.categories.parent_failed"
      );
      failed += 1;
    }
  }

  logger.info({ ok, failed }, "seed.categories.completed");
  return { ok, failed };
};

export default seedCategories;
