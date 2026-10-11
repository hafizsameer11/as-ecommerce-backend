import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "customerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
registry.registerComponent("securitySchemes", "adminAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });

export function buildOpenApiDocument() {
  const gen = new OpenApiGeneratorV3(registry.definitions);
  return gen.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "ASL ORIGINALS API",
      version: "1.0.0",
      description:
        "One API for asl-web, asl-mobile (`/api/v1/store`) and asl-admin (`/api/v1/admin`). " +
        "Money is integer kobo. Errors: `{ error: { code, message, details, requestId } }`.",
    },
    servers: [{ url: "/api/v1" }],
  });
}
