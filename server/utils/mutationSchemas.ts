import { insertProductSchema, insertServiceSchema } from "@shared/schema";

// Client writes may change listing data only. Identity, ownership, deletion,
// search, and timestamps are always controlled by the server.
const productWriteFields = {
  name: true,
  description: true,
  price: true,
  mrp: true,
  stock: true,
  category: true,
  images: true,
  isAvailable: true,
  sku: true,
  barcode: true,
  weight: true,
  dimensions: true,
  specifications: true,
  tags: true,
  minOrderQuantity: true,
  maxOrderQuantity: true,
  lowStockThreshold: true,
} as const;

export const productCreateSchema = insertProductSchema
  .pick(productWriteFields)
  .strict();
export const productUpdateSchema = productCreateSchema.partial().strict();

const serviceWriteFields = {
  name: true,
  description: true,
  price: true,
  duration: true,
  isAvailable: true,
  category: true,
  images: true,
  addressStreet: true,
  addressCity: true,
  addressState: true,
  addressPostalCode: true,
  addressCountry: true,
  bufferTime: true,
  workingHours: true,
  breakTime: true,
  maxDailyBookings: true,
  serviceLocationType: true,
  isAvailableNow: true,
  availabilityNote: true,
  allowedSlots: true,
} as const;

export const serviceCreateSchema = insertServiceSchema
  .pick(serviceWriteFields)
  .strict();
export const serviceUpdateSchema = serviceCreateSchema.partial().strict();
