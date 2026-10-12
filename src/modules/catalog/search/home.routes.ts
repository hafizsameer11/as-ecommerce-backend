import { ModuleRouter } from "@/core/http/router";
import { homeController as c } from "./home.controller";

/** Home screen in ONE request (fast first paint on web + app). */
export const homeStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/home", tag: "Home", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Home: hero slots, categories, best sellers, trending, new arrivals, collection rows" }, c.home);
