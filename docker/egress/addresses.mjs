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
