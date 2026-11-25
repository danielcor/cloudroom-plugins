import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PublishConfirmCard } from "./src/ui/PublishConfirmCard.js";
import { ShipPage } from "./src/ui/ShipPage.js";
import { ThreadBar } from "./src/ui/ThreadBar.js";

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

  app.slots.experimental_threadHeaderRow({
    id: "ship-thread-bar",
    order: 20,
    component: ThreadBar,
  });

  app.slots.experimental_threadAction({
    id: "ship-open-panel",
    title: "Open Ship Dashboard",
    icon: "git-pull-request",
    group: "ship",
    order: 10,
    item: ({ navigate }) => ({
      label: "Open Ship Dashboard",
      icon: "git-pull-request",
      run: () => {
        navigate.toPluginPanel("ship");
      },
    }),
  });

  app.composer.customize({
    id: "ship-actions",
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "ship-branch",
        label: "Ship this branch…",
        icon: "git-pull-request",
        description: "Insert /ship to run preflight, container gates, review, and PR confirm.",
        run: ({ composer }) => {
          composer.insert("/ship ", { at: "cursor" });
          composer.focus();
        },
      },
      {
        id: "ship-steward",
        label: "Watch PR with Steward…",
        icon: "shield",
        description: "Insert /steward to start autonomous background PR watching.",
        run: ({ composer }) => {
          composer.insert("/steward ", { at: "cursor" });
          composer.focus();
        },
      },
      {
        id: "ship-approvals",
        label: "Check PR approvals…",
        icon: "check-circle",
        description: "Insert /ship-approvals to evaluate default-branch approvals policy.",
        run: ({ composer }) => {
          composer.insert("/ship-approvals ", { at: "cursor" });
          composer.focus();
        },
      },
    ],
  });
});
