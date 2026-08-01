import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { BadRequestError } from "../utils/errors.js";
import { v2 as cloudinary } from "cloudinary";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const extFromMime = (mime) => {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
};
const configureCloudinary = () => {
  if (
    !env.CLOUDINARY_CLOUD_NAME ||
    !env.CLOUDINARY_API_KEY ||
    !env.CLOUDINARY_API_SECRET
  ) {
    throw new BadRequestError("Cloudinary no está configurado");
  }

  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
};

const uploadToCloudinary = async ({ buffer, key, mimetype }) => {
  configureCloudinary();

  const base64 = buffer.toString("base64");
  const dataUri = `data:${mimetype};base64,${base64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder: env.CLOUDINARY_FOLDER,
    public_id: path.parse(key).name,
    resource_type: "image",
    overwrite: false,
    transformation: [{ quality: "auto", fetch_format: "auto" }],
  });

  return {
    url: result.secure_url,
    key: result.public_id,
    publicId: result.public_id,
    size: buffer.length,
    mime: mimetype,
  };
};
const generateKey = (originalname, mimetype) => {
  const safeExt =
    extFromMime(mimetype) || path.extname(originalname || "").slice(0, 8);
  return `${crypto.randomUUID()}${safeExt}`;
};

const validateFile = ({ buffer, mimetype }) => {
  if (!buffer || !buffer.length) throw new BadRequestError("Archivo vacío");
  if (!ALLOWED_MIME.has(mimetype)) {
    throw new BadRequestError(`MIME no permitido: ${mimetype}`);
  }
  if (buffer.length > MAX_BYTES) {
    throw new BadRequestError("Archivo excede tamaño máximo (5MB)");
  }
};

let _s3Client = null;
const getS3Client = async () => {
  if (_s3Client) return _s3Client;
  const { S3Client } = await import("@aws-sdk/client-s3");
  const cfg = {
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
  };
  if (env.S3_ENDPOINT) {
    cfg.endpoint = env.S3_ENDPOINT;
    cfg.forcePathStyle = true;
  }
  _s3Client = new S3Client(cfg);
  return _s3Client;
};

const uploadToDisk = async ({ buffer, key, mimetype }) => {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DISK_PATH);
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, key);
  await fs.writeFile(fullPath, buffer);
  return {
    url: `/uploads/${key}`,
    key,
    size: buffer.length,
    mime: mimetype,
  };
};

const uploadToS3 = async ({ buffer, key, mimetype }) => {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }),
  );
  const base = env.S3_PUBLIC_URL.replace(/\/$/, "");
  return {
    url: `${base}/${key}`,
    key,
    size: buffer.length,
    mime: mimetype,
  };
};

export const uploadImage = async ({ buffer, originalname, mimetype }) => {
  validateFile({ buffer, mimetype });
  const key = generateKey(originalname, mimetype);

  let result;
  if (env.UPLOAD_DRIVER === "cloudinary") {
    result = await uploadToCloudinary({ buffer, key, mimetype });
  } else if (env.UPLOAD_DRIVER === "s3") {
    result = await uploadToS3({ buffer, key, mimetype });
  } else {
    result = await uploadToDisk({ buffer, key, mimetype });
  }
  logger.info(
    { driver: env.UPLOAD_DRIVER, key, size: result.size, mime: mimetype },
    "upload.success",
  );
  return result;
};

const deleteFromDisk = async (key) => {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DISK_PATH);
  const fullPath = path.join(dir, path.basename(key));
  if (!fullPath.startsWith(dir)) {
    throw new BadRequestError("Path inválido");
  }
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
};

const deleteFromCloudinary = async (key) => {
  configureCloudinary();
  // Defensa en profundidad: solo permitir borrar DENTRO de la carpeta de la app
  // (env.CLOUDINARY_FOLDER), nunca un public_id arbitrario de la cuenta.
  const folder = String(env.CLOUDINARY_FOLDER || "").replace(/\/$/, "");
  if (folder && !String(key).startsWith(`${folder}/`)) {
    throw new BadRequestError("Key fuera de la carpeta permitida");
  }
  // key === public_id completo, incluye carpeta (ej. cibox/products/<uuid>)
  const result = await cloudinary.uploader.destroy(key, {
    resource_type: "image",
    invalidate: true,
  });
  // "ok" = borrado, "not found" = ya no existía (idempotente). Otro valor = error.
  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error(`Cloudinary destroy: ${result.result}`);
  }
  return result;
};

const deleteFromS3 = async (key) => {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
    }),
  );
};

export const deleteImage = async (key) => {
  if (!key) throw new BadRequestError("Key requerido");
  if (env.UPLOAD_DRIVER === "cloudinary") {
    await deleteFromCloudinary(key);
  } else if (env.UPLOAD_DRIVER === "s3") {
    await deleteFromS3(key);
  } else {
    await deleteFromDisk(key);
  }
  logger.info({ driver: env.UPLOAD_DRIVER, key }, "upload.deleted");
  return true;
};
