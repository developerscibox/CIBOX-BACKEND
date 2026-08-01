// Crea/actualiza el cupón de bienvenida BODEGA10 (10%).
// Uso: node scripts/seed-bodega10.js   (desde la carpeta backend/)
import mongoose from "mongoose";
import Coupon from "../src/models/Coupon.js";

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/bodega12";

const run = async () => {
  await mongoose.connect(URI);
  await Coupon.updateOne(
    { code: "BODEGA10" },
    {
      $set: {
        code: "BODEGA10",
        discount_type: "percent",
        discount_value: 10,
        min_subtotal: 0,
        max_discount: null,
        max_uses_per_user: 1,
        first_purchase_only: false,
        is_active: true,
        expires_at: null,
      },
    },
    { upsert: true },
  );
  const c = await Coupon.findOne({ code: "BODEGA10" }).lean();
  console.log("BODEGA10 listo:", {
    code: c.code,
    type: c.discount_type,
    value: c.discount_value,
    active: c.is_active,
  });
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error("ERROR seed BODEGA10:", e.message);
  process.exit(1);
});
