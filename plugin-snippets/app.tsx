import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { bridge, ComposerBridge } from "./src/ui/bridge.js";
import { SnippetsPage } from "./src/ui/SnippetsPage.js";
import "./app.css";

// No host popup, composer command or `insert`: all three failed the live
// spike on Cloudroom v152 (see docs/superpowers/specs/…-prompt-snippets-plugin-design.md,
// "Spike results"). The picker is this page; text goes in through `updateText`.
export default definePluginApp((app) => {
  app.slots.navPanel({ id: "snippets", title: "Snippets", icon: "file-text", path: "snippets", component: SnippetsPage });
  app.composer.customize({
    id: "snippets",
    // A queued-message editor's key lasts one editing session, so a queued insert could never land there.
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "insert-snippet",
        label: "Insert snippet…",
        description: "Pick a Prompt Snippet and add it to this message. Nothing is sent.",
        run: ({ composer }) => bridge.requestPicker(composer),
      },
    ],
    banners: [{ id: "bridge", chrome: "bare", component: ComposerBridge }],
  });
});
