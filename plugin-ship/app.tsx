import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PublishConfirmCard } from "./src/ui/PublishConfirmCard.js";
import { ShipPage } from "./src/ui/ShipPage.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "ship",
    title: "Ship",
    icon: "git-pull-request",
    path: "ship",
    component: ShipPage,
  });

  app.slots.pendingInteraction({
    id: "ship-publish-confirm",
    component: PublishConfirmCard,
  });
});
