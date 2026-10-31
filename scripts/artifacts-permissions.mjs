import { spawnSync } from "node:child_process";

function fail() {
  console.error("Artifacts repair refused. Stop the Compose app and check its project-managed local artifacts volume and image.");
  process.exit(1);
}
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) fail();
  return result.stdout.trim();
}

try {
  const container = docker(["compose", "ps", "--all", "-q", "app"]);
  if (!/^[a-f0-9]{12,64}$/.test(container)) fail();
  const project = docker(["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}', container]);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail();
  if (docker(["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.service" }}', container]) !== "app" ||
      docker(["inspect", "--format", "{{.State.Running}}", container]) !== "false") fail();
  const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", container]));
  const artifacts = mounts.filter((mount) => mount.Destination === "/var/eclipse/artifacts");
  if (artifacts.length !== 1 || artifacts[0].Type !== "volume" || !artifacts[0].RW) fail();
  const name = artifacts[0].Name;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) fail();
  const [volume] = JSON.parse(docker(["volume", "inspect", name]));
  if (volume.Name !== name || volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length ||
      volume.Labels?.["com.docker.compose.project"] !== project ||
      volume.Labels?.["com.docker.compose.volume"] !== "artifacts") fail();
  const image = docker(["inspect", "--format", "{{.Image}}", container]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image) ||
      docker(["image", "inspect", "--format", "{{.Config.User}}", image]) !== "node") fail();
  docker(["run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL",
    "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges:true",
    "--mount", `type=volume,src=${name},dst=/var/eclipse/artifacts`, "--entrypoint", "find", image,
    "/var/eclipse/artifacts", "-xdev", "-exec", "chown", "-h", "1000:1000", "{}", ";"]);
  console.log("Artifacts ownership repaired; file contents and permission modes preserved.");
} catch { fail(); }
