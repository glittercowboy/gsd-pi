// FIXTURE — .mjs harness that imports .ts. Must be paired with an invocation
// that includes --experimental-strip-types; without the flag, Node throws.
import { doSomething } from "../../some-module.ts";
await doSomething();
