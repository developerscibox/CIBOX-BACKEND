import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { connectDB } from "../config/db.js";
import Product from "../models/Product.js";
import { env } from "../config/env.js";

dotenv.config();

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

const isWpImage = (url = "") =>
  typeof url === "string" && url.includes("cibox.cl/wp-content/uploads");

const uploadRemoteToCloudinary = async (url, productId, index = 0) => {
  const result = await cloudinary.uploader.upload(url, {
    folder: env.CLOUDINARY_FOLDER || "cibox/products",
    public_id: `${productId}_${index}`,
    resource_type: "image",
    overwrite: false,
    transformation: [{ quality: "auto", fetch_format: "auto" }],
  });

  return result.secure_url;
};

const run = async () => {
  await connectDB();

  const products = await Product.collection
    .find({
      $or: [
        { thumbnail: /cibox\.cl\/wp-content\/uploads/i },
        { images: /cibox\.cl\/wp-content\/uploads/i },
      ],
    })
    .toArray();

  console.log(`Productos encontrados: ${products.length}`);

  for (const product of products) {
    try {
      const currentImages = Array.isArray(product.images) ? product.images : [];

      const newImages = [];

      for (let i = 0; i < currentImages.length; i += 1) {
        const imageUrl = currentImages[i];

        if (isWpImage(imageUrl)) {
          console.log(`Subiendo imagen: ${imageUrl}`);
          const newUrl = await uploadRemoteToCloudinary(
            imageUrl,
            product._id,
            i,
          );
          newImages.push(newUrl);
        } else {
          newImages.push(imageUrl);
        }
      }

      let newThumbnail = product.thumbnail;

      if (isWpImage(product.thumbnail)) {
        console.log(`Subiendo thumbnail: ${product.thumbnail}`);
        newThumbnail = await uploadRemoteToCloudinary(
          product.thumbnail,
          product._id,
          "thumb",
        );
      }

      await Product.collection.updateOne(
        { _id: product._id },
        {
          $set: {
            images: newImages,
            thumbnail: newThumbnail || newImages[0] || "",
          },
        },
      );

      console.log(`✅ Actualizado: ${product.name}`);
    } catch (error) {
      console.log(`❌ Error en ${product.name}:`, error.message);
    }
  }

  console.log("Migración terminada");
  process.exit(0);
};

run();
