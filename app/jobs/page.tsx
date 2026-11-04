import { redirect } from "next/navigation";

// Jobs merged into Mission Control (Runs section). Run detail pages stay put.
export default async function JobsPage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const { range } = await searchParams;
  const query = range ? `?range=${encodeURIComponent(Array.isArray(range) ? range[0] ?? "" : range)}` : "";
  redirect(`/mission-control${query}`);
}
