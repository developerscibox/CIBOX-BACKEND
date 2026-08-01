import { asyncHandler } from "../middlewares/errorHandler.js";
import * as uploadService from "../services/uploadService.js";
import { BadRequestError } from "../utils/errors.js";

export const uploadSingle = asyncHandler(async (req, res) => {
  if (!req.file) throw new BadRequestError("Imagen requerida (campo 'image')");
  const result = await uploadService.uploadImage({
    buffer: req.file.buffer,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
  });
  res.status(201).json({
    success: true,
    data: result,
    message: "Imagen subida",
  });
});



export const uploadMultiple = asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new BadRequestError("Imágenes requeridas (campo 'images')");

  const results = [];
  for (const file of files) {
    const r = await uploadService.uploadImage({
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    results.push(r);
  }
  res.status(201).json({
    success: true,
    data: results,
    message: `${results.length} imágenes subidas`,
  });
});

export const deleteUpload = asyncHandler(async (req, res) => {
  // Ruta wildcard "/*key": Express 5 entrega los segmentos como array.
  let { key } = req.params;
  if (Array.isArray(key)) key = key.join("/");
  if (!key) throw new BadRequestError("Key requerido");
  await uploadService.deleteImage(key);
  res.status(200).json({
    success: true,
    message: "Imagen eliminada",
  });
});
