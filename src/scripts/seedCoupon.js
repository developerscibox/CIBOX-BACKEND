import mongoose from "mongoose";
import dotenv from "dotenv";
import Coupon from "../models/Coupon.js"; // ajusta ruta si es necesario

dotenv.config();

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ DB conectada");

    await Coupon.updateOne(
      { code: "BIENVENIDA10" },
      {
        $set: {
          code: "BIENVENIDA10",
          discount_type: "percent",
          discount_value: 10,
          min_subtotal: 0,
          max_discount: 5000,
          max_uses: null,
          max_uses_per_user: 1,
          used_count: 0,
          first_purchase_only: true,
          is_active: true,
        },
      },
      { upsert: true }
    );

    console.log("🎉 Cupón creado/actualizado correctamente");

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
};

run();