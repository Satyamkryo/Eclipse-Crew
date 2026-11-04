import { redirect } from "next/navigation";

// Account lives at /profile now; this path stays as a redirect for bookmarks.
export default async function AccountPage() {
  redirect("/profile");
}
