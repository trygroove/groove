// The Memory page module that `router.tsx` points at (GRV-25).

import { Title } from "@solidjs/meta";
import { pageTitle } from "../../site.config.mjs";
import { AuthProvider } from "../auth/AuthProvider";
import SignedInOnly from "../auth/SignedInOnly";
import TapeLoader from "../components/TapeLoader";
import MemoryPage from "../memory/MemoryPage";
import "./dashboard.css";

export default function MemoryRoute() {
  return (
    <main class="dashboard">
      <Title>{pageTitle("Memory")}</Title>
      <h1 class="dashboard-title">Memory</h1>
      <AuthProvider>
        <SignedInOnly fallback={<TapeLoader label="Loading memory" />}>
          <MemoryPage />
        </SignedInOnly>
      </AuthProvider>
    </main>
  );
}
