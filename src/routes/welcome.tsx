// The welcome page module that `router.tsx` points at (GRV-25).

import { Title } from "@solidjs/meta";
import { ASSISTANT_NAME, pageTitle } from "../../site.config.mjs";
import { AuthProvider } from "../auth/AuthProvider";
import SignedInOnly from "../auth/SignedInOnly";
import TapeLoader from "../components/TapeLoader";
import Welcome from "../onboarding/Welcome";

export default function WelcomePage() {
  return (
    <>
      <Title>{pageTitle(`Meet ${ASSISTANT_NAME}`)}</Title>
      <AuthProvider>
        <SignedInOnly fallback={<TapeLoader label="Loading" />}>
          <Welcome />
        </SignedInOnly>
      </AuthProvider>
    </>
  );
}
