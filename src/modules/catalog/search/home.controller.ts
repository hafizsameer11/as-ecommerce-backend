import { homeService as svc } from "./home.service";

export const homeController = {
  home: () => svc.home(),
};
