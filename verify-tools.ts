import { ToolRegistry, registerAllTools } from "./src/tools/index";

const registry = new ToolRegistry();
registerAllTools(registry);
console.log(`Registered ${registry.list().length} tools:`);
registry.list().forEach((t) => console.log(`  - ${t}`));
