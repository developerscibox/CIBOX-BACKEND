import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/Product.js";

dotenv.config();

const BOX_ID = "69dc6bd2445e8ee3ec089d07";

const items = [
  { product_id: "69e7d5c9c2c1367658e878ca", quantity: 1 },
  { product_id: "69f2d8babae8516c530ee70f", quantity: 1 },
  { product_id: "69e7d946c2c1367658e87906", quantity: 2 },
  { product_id: "69e7d94ac2c1367658e87915", quantity: 2 },
  { product_id: "69f2d8b4bae8516c530ee6f2", quantity: 1 },
  { product_id: "69f2d490bae8516c530ee619", quantity: 1 },
  { product_id: "69e7d948c2c1367658e8790b", quantity: 2 },
  { product_id: "69f2d654bae8516c530ee68b", quantity: 2 },
  { product_id: "69f2d222bae8516c530ee5b0", quantity: 1 },
  { product_id: "69f2d5cfbae8516c530ee662", quantity: 1 },
  { product_id: "69f2d105bae8516c530ee57c", quantity: 1 },
  { product_id: "69f2d105bae8516c530ee57d", quantity: 1 },
  { product_id: "69f2d107bae8516c530ee587", quantity: 2 },
  { product_id: "69e7de5bc2c1367658e8794a", quantity: 1 },
  { product_id: "69f2d755bae8516c530ee6c3", quantity: 2 },
  { product_id: "69f2d352bae8516c530ee5b9", quantity: 2 },
  { product_id: "69f2d479bae8516c530ee5f1", quantity: 1 },
  { product_id: "69e7de56c2c1367658e87934", quantity: 1 },
  { product_id: "69f2d6f5bae8516c530ee6b6", quantity: 2 },
  { product_id: "69e7d943c2c1367658e878f5", quantity: 1 },
  { product_id: "69f2d270bae8516c530ee5b7", quantity: 1 },
];

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ DB conectada");

    const boxItems = items.map((item) => ({
      product_id: new mongoose.Types.ObjectId(item.product_id),
      quantity: item.quantity,
    }));

    const result = await Product.findByIdAndUpdate(
      BOX_ID,
      {
        $set: {
          product_type: "box",
          box_items: boxItems,
        },
      },
      { new: true }
    );

    console.log("✅ Caja actualizada:");
    console.log(result);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
};

run();