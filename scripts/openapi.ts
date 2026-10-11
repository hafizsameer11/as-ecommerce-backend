/** Writes the OpenAPI document to docs/openapi.json (for frontend code generation). */
import { writeFileSync } from "node:fs";
import { createApp } from "@/app";
import { buildOpenApiDocument } from "@/core/http/openapi";

createApp(); // registers every module's routes in the OpenAPI registry
writeFileSync("docs/openapi.json", JSON.stringify(buildOpenApiDocument(), null, 2));
console.log("docs/openapi.json written");
process.exit(0);
