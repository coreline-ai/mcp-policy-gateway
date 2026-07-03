// SSRF egress guard for HTTP targets (ADR-006 / T10 / Q14).
//
// Two layers:
//   - validateUrlShape: synchronous — scheme allowlist, host allowlist, and
//     literal private/loopback/link-local IP block. Used at registration.
//   - assertEgressAllowed: async — resolves the hostname and requires EVERY
//     resolved address to be public. Runs both before connect and (via a guarded
//     fetch) on each request, shrinking the DNS-rebinding window.
import net from "node:net";
import dns from "node:dns/promises";

export interface EgressPolicy {
  allowedSchemes: string[];
  allowedHosts?: string[];
  allowPrivate: boolean; // true only for local dev/testing
}

export const DEFAULT_EGRESS: EgressPolicy = { allowedSchemes: ["https"], allowPrivate: false };

export class EgressBlockedError extends Error {}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return true; // IETF assignments and TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true; // loopback, unspecified
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true; // link-local fe80::/10
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique local fc00::/7
    if (s.startsWith("ff")) return true; // multicast ff00::/8
    if (s === "2001:db8" || s.startsWith("2001:db8:")) return true; // documentation 2001:db8::/32
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped && mapped[1]) return isPrivateV4(mapped[1]);
    const mappedHex = ipv4MappedHexToV4(s);
    if (mappedHex) return isPrivateV4(mappedHex);
    return false;
  }
  return true; // not a valid IP literal -> treat as unsafe
}

/** Synchronous shape validation (scheme + host allowlist + literal private IP). */
export function validateUrlShape(rawUrl: string, policy: EgressPolicy): { host: string; scheme: string } {
  const u = new URL(rawUrl); // throws on malformed URL
  const scheme = u.protocol.replace(/:$/, "");
  if (!policy.allowedSchemes.includes(scheme)) throw new EgressBlockedError(`scheme not allowed: ${scheme}`);
  const host = normalizeHost(u.hostname);
  if (policy.allowedHosts && !policy.allowedHosts.map(normalizeHost).includes(host)) throw new EgressBlockedError(`host not allowlisted: ${host}`);
  if (net.isIP(host) && !policy.allowPrivate && isPrivateIp(host)) throw new EgressBlockedError(`private/loopback IP blocked: ${host}`);
  return { host, scheme };
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Full check: shape + every resolved address must be public. `resolver` is injectable for tests. */
export async function assertEgressAllowed(
  rawUrl: string,
  policy: EgressPolicy = DEFAULT_EGRESS,
  resolver: Resolver = defaultResolver,
): Promise<{ host: string; addresses: string[] }> {
  const { host } = validateUrlShape(rawUrl, policy);
  if (net.isIP(host)) return { host, addresses: [host] }; // literal IP already validated
  const addresses = await resolver(host);
  if (addresses.length === 0) throw new EgressBlockedError(`no DNS resolution for host: ${host}`);
  if (!policy.allowPrivate) {
    for (const ip of addresses) {
      if (isPrivateIp(ip)) throw new EgressBlockedError(`host resolves to private IP (SSRF): ${host} -> ${ip}`);
    }
  }
  return { host, addresses };
}

function normalizeHost(host: string): string {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return h.toLowerCase();
}

function ipv4MappedHexToV4(ip: string): string | undefined {
  const m = ip.match(/^(?:0:0:0:0:0:ffff|::ffff):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return undefined;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  if (hi > 0xffff || lo > 0xffff) return undefined;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
}
