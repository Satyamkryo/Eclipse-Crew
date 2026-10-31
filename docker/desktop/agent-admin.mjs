import { createAgent, inspectAgent, executeAgent, restoreAccounts, AgentError, requireAdmin } from "./agent-store.mjs";
import { checkTools } from "./check-tools.mjs";
import { requestSession } from "./session-manager.mjs";

try {
  const [command, ownerId, agentId, ...argv] = process.argv.slice(2);
  if (command === "--restore" && process.argv.length === 3) {
    const restored = await restoreAccounts(); console.log(JSON.stringify({ restored }));
  } else if (command === "health" && process.argv.length === 3) {
    await requireAdmin(); await checkTools({ supervisor: true });
    console.log(JSON.stringify({ outcome: "healthy" }));
  } else if (["session-start", "session-status", "session-stop"].includes(command) && argv.length === 0) {
    console.log(JSON.stringify(await requestSession(command, ownerId, agentId)));
  } else if (["create", "inspect", "exec"].includes(command) && (command === "exec" ? argv.length > 0 : argv.length === 0)) {
    if (command === "exec") process.exitCode = await executeAgent(ownerId, agentId, argv);
    else console.log(JSON.stringify(await (command === "create" ? createAgent : inspectAgent)(ownerId, agentId)));
  } else throw new AgentError("invalid_arguments");
} catch (error) {
  console.error(JSON.stringify({ outcome: "refused", reason: error instanceof AgentError ? error.code : "filesystem_refused",
    ...(["EPERM", "EACCES", "ENOENT", "EEXIST", "EINVAL"].includes(error.code) ? { filesystemCode: error.code } : {}),
    ...(["chmod", "chown", "lchown", "open", "mkdir", "rename", "write", "symlink"].includes(error.syscall) ? { operation: error.syscall } : {}) })); process.exitCode = 1;
}
