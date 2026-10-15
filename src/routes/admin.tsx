import { Title } from "@solidjs/meta";
import { pageTitle } from "../../site.config.mjs";
import { AuthProvider } from "../auth/AuthProvider";
import AdminGate from "../components/admin/AdminGate";
import AllowlistAdmin from "../components/admin/AllowlistAdmin";
import TranscriptAdmin from "../components/admin/TranscriptAdmin";
import "./dashboard.css";

/**
 * `/admin` (#854): the alpha allowlist, and the assistant's kept transcripts
 * (GRV-98), for accounts with the `admin` claim.
 * Anyone else gets the 404 page from `AdminGate`, title included.
 */
export default function AdminPage() {
  return (
    <AuthProvider>
      <AdminGate>
        <main class="dashboard">
          <Title>{pageTitle("Admin")}</Title>
          <h1 class="dashboard-title">Alpha access</h1>
          <AllowlistAdmin />
          <TranscriptAdmin />
        </main>
      </AdminGate>
    </AuthProvider>
  );
}
