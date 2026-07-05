import { defineWorkspace } from "vitest/config";
import path from "node:path";

const coreSrc = path.resolve(__dirname, "packages/core/src/index.ts");
const adapterClaudeSrc = path.resolve(__dirname, "packages/adapter-claude/src/index.ts");
const adapterOpencodeSrc = path.resolve(__dirname, "packages/adapter-opencode/src/index.ts");

const alias = {
  "@sojourn/core": coreSrc,
  "@sojourn/adapter-claude": adapterClaudeSrc,
  "@sojourn/adapter-opencode": adapterOpencodeSrc,
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "node",
      environment: "node",
      include: [
        "packages/{core,daemon,adapter-claude,adapter-opencode,cli}/test/**/*.test.ts",
      ],
      testTimeout: 20000,
    },
  },
  {
    resolve: { alias },
    test: {
      name: "web",
      environment: "jsdom",
      include: ["packages/web/test/**/*.test.{ts,tsx}"],
    },
  },
]);
