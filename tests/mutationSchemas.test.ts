import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { locationUpdateSchema } from "../server/utils/location.js";
import {
  productCreateSchema,
  productUpdateSchema,
  serviceCreateSchema,
  serviceUpdateSchema,
} from "../server/utils/mutationSchemas.js";

describe("location writes", () => {
  it("accepts an explicit clear", () => {
    assert.deepStrictEqual(
      locationUpdateSchema.parse({ latitude: null, longitude: null }),
      { latitude: null, longitude: null, context: "user" },
    );
  });

  it("rejects a half-cleared location", () => {
    assert.throws(() =>
      locationUpdateSchema.parse({ latitude: null, longitude: 80 }),
    );
  });

  it("accepts numeric strings and preserves context", () => {
    assert.deepStrictEqual(
      locationUpdateSchema.parse({
        latitude: "12.9716",
        longitude: "77.5946",
        context: "shop",
      }),
      { latitude: 12.9716, longitude: 77.5946, context: "shop" },
    );
  });
});

describe("listing mutation schemas", () => {
  const product = {
    name: "Rice",
    description: "Five kilogram bag",
    price: "500",
    mrp: "550",
    category: "groceries",
  };

  const service = {
    name: "Plumbing",
    description: "Home plumbing repair",
    price: "800",
    duration: 60,
    category: "home-repair",
  };

  it("does not allow product ownership or lifecycle fields", () => {
    assert.doesNotThrow(() => productCreateSchema.parse(product));
    assert.throws(() =>
      productCreateSchema.parse({ ...product, shopId: 999 }),
    );
    assert.throws(() =>
      productUpdateSchema.parse({ isDeleted: true }),
    );
    assert.deepStrictEqual(productUpdateSchema.parse({ stock: 4 }), {
      stock: 4,
    });
  });

  it("does not allow service ownership or lifecycle fields", () => {
    assert.doesNotThrow(() => serviceCreateSchema.parse(service));
    assert.throws(() =>
      serviceCreateSchema.parse({ ...service, providerId: 999 }),
    );
    assert.throws(() =>
      serviceUpdateSchema.parse({ isDeleted: true }),
    );
    assert.deepStrictEqual(serviceUpdateSchema.parse({ isAvailableNow: false }), {
      isAvailableNow: false,
    });
  });
});
