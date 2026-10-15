import { Demo } from "@/components/demo";
import { LIVE_MODEL, liveAvailable } from "@/lib/live-model";

export default function Page() {
  return <Demo liveAvailable={liveAvailable()} liveModel={LIVE_MODEL} />;
}
