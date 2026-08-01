// Crea el vendor "Bodega 12" (el dueño/plataforma) para que admin/gerente
// puedan crear productos desde el WMS. Usa el mismo _id que los productos
// sembrados embeben (VENDOR.id en seedBodega12.js) y lo liga al usuario admin.
// Uso: MONGO_URI="..." node scripts/seed-vendor.js   (desde backend/)
import mongoose from "mongoose";
import { User } from "../src/models/User.js";
import Vendor from "../src/models/Vendor.js";

const URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/bodega12";
const VENDOR_ID = "6a2ca4c933d4b4431ba9fbd0";

const run = async () => {
  await mongoose.connect(URI);
  const admin =
    (await User.findOne({ email: "test@bodega12.cl" }).lean()) ||
    (await User.findOne({ role: "admin" }).lean());
  if (!admin) throw new Error("No se encontró un usuario admin para ligar el vendor");

  const oid = new mongoose.Types.ObjectId(VENDOR_ID);
  await Vendor.updateOne(
    { _id: oid },
    {
      $set: {
        user_id: admin._id,
        name: "Bodega 12",
        description: "Supermercado mayorista — Lo Espejo",
        is_active: true,
        is_verified: true,
      },
    },
    { upsert: true },
  );

  const v = await Vendor.findById(oid).lean();
  console.log("Vendor listo:", {
    id: String(v._id),
    name: v.name,
    active: v.is_active,
    user: String(v.user_id),
  });
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error("ERROR seed-vendor:", e.message);
  process.exit(1);
});
