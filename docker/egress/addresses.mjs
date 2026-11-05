import net from "node:net";

// Shared by the provider forwarder and the desktop browser proxy. Every outbound target is checked
// against these ranges before a connection is made (TASK-045/046).

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(network, prefix, "ipv6");

// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are refused outright. They are not listed in the BlockList because
// Node checks IPv4 addresses against IPv6 rules in their mapped form, which would block every IPv4 address.
export function isBlockedAddress(address) {
  const version = net.isIP(address);
  if (!version) return true;
  if (version === 6) {
    let normalized;
    try { normalized = new URL(`http://[${address}]/`).hostname.toLowerCase(); } catch { return true; }
    if (normalized.startsWith("[::ffff:")) return true;
  }
  return blocked.check(address, version === 4 ? "ipv4" : "ipv6");
}

// Local model route (Ollama, LM Studio, llama.cpp, vLLM, self-hosted SAM). The owner's own computer, LAN or
// Tailscale network only: RFC 1918, CGNAT (Tailscale 100.64/10) and IPv6 unique-local. Never loopback (the proxy
// itself), link-local/metadata, multicast, the public internet, or any subnet the proxy is attached to (the app,
// desktop and other Compose services). host.docker.internal resolves to the host gateway, outside those subnets.
const localModel = new net.BlockList();
for (const [network, prefix] of [["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16]]) {
  localModel.addSubnet(network, prefix, "ipv4");
}
localModel.addSubnet("fc00::", 7, "ipv6");

export function ownSubnets(interfaces) {
  const own = new net.BlockList();
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.internal || typeof entry.cidr !== "string") continue;
      const [network, prefix] = entry.cidr.split("/");
      const family = net.isIP(network) === 6 ? "ipv6" : "ipv4";
      try { own.addSubnet(network, Number(prefix), family); } catch { /* skip malformed entries */ }
    }
  }
  return own;
}

export function isLocalModelAddress(address, own) {
  const version = net.isIP(address);
  if (!version) return false;
  if (version === 6) {
    let normalized;
    try { normalized = new URL(`http://[${address}]/`).hostname.toLowerCase(); } catch { return false; }
    if (normalized.startsWith("[::ffff:")) return false;
  }
  const family = version === 4 ? "ipv4" : "ipv6";
  if (!localModel.check(address, family)) return false;
  return !own?.check(address, family);
}
