import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/Product.js";

dotenv.config();

const BASE_BOX_ID = "69dc6bd2445e8ee3ec089d07";

const boxItems = [
  [1, "69e7d5cac2c1367658e878cc"],
  [1, "69e7d5cdc2c1367658e878d9"],
  [1, "69f2d100bae8516c530ee565"],
  [2, "69e7d946c2c1367658e87905"],
  [1, "69e7d946c2c1367658e87902"],
  [1, "69e7d94ac2c1367658e87918"],
  [1, "69f2d0ffbae8516c530ee562"],
  [1, "69f2d102bae8516c530ee571"],
  [1, "69f2d8b4bae8516c530ee6f0"],
  [1, "69f2d490bae8516c530ee619"],
  [1, "69f2d8b4bae8516c530ee6f1"],
  [2, "69e7de60c2c1367658e87961"],
  [3, "69e7d948c2c1367658e8790e"],
  [2, "69e7d948c2c1367658e8790c"],
  [2, "69f2d538bae8516c530ee623"],
  [1, "69f2d5cebae8516c530ee65e"],
  [2, "69f2d105bae8516c530ee57f"],
  [1, "69f2d53fbae8516c530ee63f"],
  [1, "69f2d6f5bae8516c530ee6b8"],
  [1, "69e7d943c2c1367658e878f5"],
  [1, "69f2d6f6bae8516c530ee6bb"],
  [1, "69e7d5cbc2c1367658e878d4"],
  [2, "69f2d352bae8516c530ee5b9"],
  [2, "69f2d478bae8516c530ee5ed"],
  [1, "69e7de55c2c1367658e87930"],
  [1, "69e7de57c2c1367658e87938"],
  [1, "69f2d103bae8516c530ee572"],
  [1, "69e7de56c2c1367658e87936"],
  [1, "69f2d53fbae8516c530ee642"],
  [1, "69e7d90ec2c1367658e878e6"],
  [1, "69f2d48fbae8516c530ee615"],
  [1, "69f2d537bae8516c530ee61e"],
  [1, "69e7d910c2c1367658e878ee"],
  [1, "69f2d755bae8516c530ee6c2"],
  [1, "69f2d759bae8516c530ee6d3"],
  [1, "69e7d90ec2c1367658e878e5"],
  [1, "69e7de56c2c1367658e87934"],
];

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ DB conectada");

    const baseBox = await Product.findById(BASE_BOX_ID).lean();

    if (!baseBox) {
      throw new Error("No se encontró la caja base CIBOX Esencial");
    }

    const payload = {
      ...baseBox,
      _id: undefined,
      name: "CIBOX Premium",
      search_name: "cibox premium",
      description: "Caja premium con selección completa de productos CIBOX",
      sku: "CIBOX-PREMIUM-01",
      product_type: "box",
      box_items: boxItems.map(([quantity, productId]) => ({
        product_id: new mongoose.Types.ObjectId(productId),
        quantity,
      })),
      stock: 15,
      is_active: true,
      average_rating: 0,
      reviews_count: 0,
      created_at: undefined,
      updated_at: undefined,
      __v: undefined,
    };

    const product = await Product.create(payload);

    console.log("✅ CIBOX Premium creada:");
    console.log(product._id.toString());

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
};

run();