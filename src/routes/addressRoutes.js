import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/authMiddleware.js";
import {
  createAddressSchema,
  updateAddressSchema,
  addressIdParamsSchema,
} from "../validators/addressValidators.js";
import {
  listMyAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefault,
  getDefault,
} from "../controllers/addressController.js";

const router = Router();

router.use(protect);

router.get("/", listMyAddresses);
router.get("/default", getDefault);

router.post("/", validate({ body: createAddressSchema }), createAddress);

router.patch(
  "/:id",
  validate({ params: addressIdParamsSchema, body: updateAddressSchema }),
  updateAddress
);
router.delete("/:id", validate({ params: addressIdParamsSchema }), deleteAddress);
router.post("/:id/default", validate({ params: addressIdParamsSchema }), setDefault);

export default router;
