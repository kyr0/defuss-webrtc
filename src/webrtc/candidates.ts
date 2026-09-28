export type IceCandidateType = "host" | "srflx" | "prflx" | "relay" | string;

export interface IceCandidateSummary {
  foundation: string;
  component: number;
  protocol: string;
  priority: number;
  address: string;
  port: number;
  type: IceCandidateType;
  relatedAddress?: string;
  relatedPort?: number;
  tcpType?: string;
  raw: string;
}

export interface PublicEndpoint {
  address: string;
  port: number;
  protocol: string;
}

export function parseIceCandidate(candidate: string): IceCandidateSummary | null {
  const value = candidate.trim().replace(/^a=/, "");
  const match = /^candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)(.*)$/i.exec(value);
  if (!match) return null;

  const rest = match[8]!.trim().split(/\s+/).filter(Boolean);
  const attributes = new Map<string, string>();
  for (let i = 0; i + 1 < rest.length; i += 2) attributes.set(rest[i]!, rest[i + 1]!);

  const relatedPort = attributes.has("rport") ? Number(attributes.get("rport")) : undefined;
  const relatedAddress = attributes.get("raddr");
  const tcpType = attributes.get("tcptype");
  return {
    foundation: match[1]!,
    component: Number(match[2]),
    protocol: match[3]!.toLowerCase(),
    priority: Number(match[4]),
    address: match[5]!,
    port: Number(match[6]),
    type: match[7]!,
    ...(relatedAddress ? { relatedAddress } : {}),
    ...(Number.isFinite(relatedPort) ? { relatedPort } : {}),
    ...(tcpType ? { tcpType } : {}),
    raw: value,
  };
}

export function extractIceCandidates(sdp: string): IceCandidateSummary[] {
  const result: IceCandidateSummary[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:") && !line.startsWith("candidate:")) continue;
    const parsed = parseIceCandidate(line);
    if (parsed) result.push(parsed);
  }
  return result;
}

export function getServerReflexiveEndpoints(
  input: string | { description: RTCSessionDescriptionInit },
): PublicEndpoint[] {
  const sdp = typeof input === "string" ? input : input.description.sdp ?? "";
  const seen = new Set<string>();
  const endpoints: PublicEndpoint[] = [];
  for (const candidate of extractIceCandidates(sdp)) {
    if (candidate.type !== "srflx") continue;
    const key = `${candidate.protocol}|${candidate.address}|${candidate.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({
      address: candidate.address,
      port: candidate.port,
      protocol: candidate.protocol,
    });
  }
  return endpoints;
}
