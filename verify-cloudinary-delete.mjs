// Verificación real del borrado en Cloudinary (round-trip upload -> delete -> confirmar).
// Uso (PowerShell):
//   $env:CLOUDINARY_CLOUD_NAME="<tu-cloud-name>"; $env:CLOUDINARY_API_KEY="..."; $env:CLOUDINARY_API_SECRET="..."; node verify-cloudinary-delete.mjs
// Uso (bash):
//   CLOUDINARY_CLOUD_NAME=<tu-cloud-name> CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... node verify-cloudinary-delete.mjs
import { v2 as cloudinary } from "cloudinary";

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
const FOLDER = process.env.CLOUDINARY_FOLDER || "cibox/products";

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error("Faltan CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET");
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

// PNG 1x1 transparente
const onePxPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const dataUri = `data:image/png;base64,${onePxPng}`;
const localKey = `verify-${Date.now()}`; // emula generateKey (sin ext, path.parse(key).name)

(async () => {
  const up = await cloudinary.uploader.upload(dataUri, {
    folder: FOLDER,
    public_id: localKey,
    resource_type: "image",
    overwrite: false,
  });
  const key = up.public_id; // incluye carpeta -> ej. cibox/products/verify-...
  console.log("UPLOAD ok -> public_id:", key);

  const del = await cloudinary.uploader.destroy(key, { resource_type: "image", invalidate: true });
  console.log("DELETE result:", del.result); // esperado: "ok"

  const exists = await cloudinary.api
    .resource(key, { resource_type: "image" })
    .then(() => true)
    .catch((e) => (e?.error?.http_code === 404 ? false : Promise.reject(e)));
  console.log("¿Sigue existiendo en Cloudinary?:", exists);

  if (del.result === "ok" && exists === false) {
    console.log("\n✅ VERIFICADO: el asset se borró de Cloudinary.");
    process.exit(0);
  }
  console.error("\n❌ FALLÓ: el asset no se borró como se esperaba.");
  process.exit(2);
})().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
