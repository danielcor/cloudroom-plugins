// The bb.host artifact: the SDK's generic ACP bridge, unchanged. It launches Qoder with the
// launch spec from src/declaration.ts (absolute command, so no PATH resolution is needed here).
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
