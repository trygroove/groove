import { type Accessor, createSignal, onCleanup } from "solid-js";

/**
 * Whether the browser says it is online, following its `online` and `offline`
 * events (GRV-55). The browser can only say whether there is a network at
 * all, not whether Firestore is reachable, so this is used to explain a save
 * that is waiting, never to decide that one failed.
 */
export function useOnline(): Accessor<boolean> {
  const [online, setOnline] = createSignal(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  if (typeof window !== "undefined") {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    onCleanup(() => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    });
  }
  return online;
}
