// The canary's load check: read `openclaw plugins inspect refine-cycle --runtime --json`
// output and fail when the plugin is not loaded with what it registers.
//   node scripts/canary-check.mjs <inspect output file>
import fs from "node:fs";

const text = fs.readFileSync(process.argv[2], "utf8");
const data = JSON.parse(text.slice(text.indexOf("{")));
const plugin = data.plugin ?? {};
const hooks = (data.typedHooks ?? []).map((hook) => hook.name);
const tools = (data.tools ?? []).flatMap((tool) => tool.names ?? []);
const problems = [];
if (plugin.status !== "loaded") problems.push(`status is ${plugin.status}, not loaded`);
for (const hook of ["before_prompt_build", "agent_end"]) if (!hooks.includes(hook)) problems.push(`hook ${hook} is not registered`);
if (!(plugin.commands ?? []).includes("refine")) problems.push("chat command /refine is not registered");
if (!(plugin.cliCommands ?? []).includes("refine-cycle")) problems.push("CLI command refine-cycle is not registered");
if (!tools.includes("refine_run")) problems.push("tool refine_run is not registered");
if ((data.diagnostics ?? []).length) problems.push(`diagnostics: ${JSON.stringify(data.diagnostics)}`);
if (problems.length) {
  console.error(`The plugin does not load as expected:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`loaded ${plugin.version}: hooks ${hooks.join(", ")}; /refine; refine-cycle; ${tools.join(", ")}`);
