#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";

import { setBedrockProviderModule } from "@gsd/pi-ai";
import { bedrockProviderModule } from "@gsd/pi-ai/bedrock-provider";
import { EnvHttpProxyAgent, Agent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

const hasProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY ||
                 process.env.http_proxy || process.env.https_proxy;
if (hasProxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent({ connect: { autoSelectFamily: true } }));
} else {
  setGlobalDispatcher(new Agent({ connect: { autoSelectFamily: true } }));
}
setBedrockProviderModule(bedrockProviderModule);

main(process.argv.slice(2));
