import { z } from "zod";

const nullableCoordinate = (minimum: number, maximum: number) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    z.coerce.number().min(minimum).max(maximum).nullable(),
  );

/**
 * A location write always contains both coordinates. Both may be null when
 * the user explicitly clears the saved location, but a half-cleared location
 * is rejected so distance queries never receive an invalid pair.
 */
export const locationUpdateSchema = z
  .object({
    latitude: nullableCoordinate(-90, 90),
    longitude: nullableCoordinate(-180, 180),
    // Keep this extensible for mobile clients; only "shop" has special
    // persistence behavior and every other context updates the user location.
    context: z.string().trim().min(1).default("user"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const latitudeIsNull = value.latitude === null;
    const longitudeIsNull = value.longitude === null;
    if (latitudeIsNull !== longitudeIsNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [latitudeIsNull ? "longitude" : "latitude"],
        message: "Latitude and longitude must be provided together",
      });
    }
  });

export type LocationUpdate = z.infer<typeof locationUpdateSchema>;
