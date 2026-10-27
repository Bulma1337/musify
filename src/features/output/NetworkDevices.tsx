import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Speaker, Tv, type LucideProps } from "lucide-react";
import type { ComponentType } from "react";
import { connectNetworkDevice } from "@/player/bridge";
import { networkApi, useNetwork, type NetworkDevice, type NetworkDeviceKind } from "@/player/network";
import { DeviceRow } from "./DeviceRow";

/** How often the open panel looks for devices again. */
const RESCAN_MS = 15_000;

/** Neutral protocol names (not translated). */
const PROTOCOL_LABEL = { upnp: "UPnP/DLNA", cast: "Cast" } as const;

const KIND_ICON: Record<NetworkDeviceKind, ComponentType<LucideProps>> = {
  speaker: Speaker,
  tv: Tv,
  group: Speaker,
};

/** "Speaker · UPnP/DLNA". The device's model name stays out: it is often a brand name. */
function deviceDetail(device: NetworkDevice, kindLabel: string): string {
  return `${kindLabel} · ${PROTOCOL_LABEL[device.protocol]}`;
}

/** Looks for devices while the panel is open: now, and again every few seconds. */
function useNetworkScan() {
  useEffect(() => {
    const scan = () => void networkApi.scan().catch(() => {});
    scan();
    const timer = window.setInterval(scan, RESCAN_MS);
    return () => window.clearInterval(timer);
  }, []);
}

/** Speakers and TVs on the local network, next to this computer's outputs. */
export function NetworkDevices() {
  const { t } = useTranslation();
  const devices = useNetwork((s) => s.devices);
  const scanning = useNetwork((s) => s.scanning);
  const connecting = useNetwork((s) => s.connecting);
  const activeId = useNetwork((s) => s.active?.device.id ?? null);
  useNetworkScan();

  return (
    <section aria-label={t("output.network.title")}>
      <h3 className="flex items-center gap-2 px-2 pb-1 text-sm font-bold text-subdued">
        {t("output.network.title")}
        {scanning && (
          <Loader2 size={14} className="animate-spin" aria-label={t("output.network.searching")} />
        )}
      </h3>
      {devices.length > 0 && (
        <div role="radiogroup" aria-label={t("output.network.title")} className="flex flex-col">
          {devices.map((device) => {
            const Icon = KIND_ICON[device.kind];
            return (
              <DeviceRow
                key={device.id}
                selected={activeId === device.id}
                busy={connecting === device.id}
                name={device.name}
                detail={deviceDetail(device, t(`output.network.kinds.${device.kind}`))}
                icon={(className) => <Icon size={22} className={className} aria-hidden="true" />}
                onSelect={() => void connectNetworkDevice(device.id)}
              />
            );
          })}
        </div>
      )}
      {devices.length === 0 && (
        <p className="px-2 pt-1 text-[13px] text-subdued">
          {scanning ? t("output.network.searching") : t("output.network.none")}
        </p>
      )}
    </section>
  );
}
