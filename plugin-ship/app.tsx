import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PublishConfirmCard } from "./src/ui/PublishConfirmCard.js";

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "ship-publish-confirm",
    component: PublishConfirmCard,
  });
});
