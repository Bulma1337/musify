import { useTranslation } from "react-i18next";
import { AudioWaveform, Check, RefreshCw, Speaker, X } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { useLayout } from "@/app/layout/layoutStore";
import { useEngineStatus } from "@/player/bridge";
import type { DeviceInfo } from "@/player/engineTypes";
import { isLossless, qualityLabel } from "@/player/quality";
import { usePlayer } from "@/player/store";
import { useSettings } from "@/settings/store";
import { exclusiveSummary, formatOutputFormat, formatSampleRate } from "./signalPath";
import { QuickSound } from "./QuickSound";
import { useOutputDevices } from "./useOutputDevices";

/** The playing track's format, large, and where it goes: the top of the audio panel. */
function AudioStatus() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const output = useEngineStatus((s) => s.outputFormat);
  const label = track ? qualityLabel(track.format) : null;
  if (!track || !label) return null;
  const lossless = isLossless(track.format);
  const bitRate = track.format.bitRate ? `${track.format.bitRate} kbit/s` : null;
  const details = [lossless ? t("output.lossless") : t("output.lossy"), bitRate].filter(Boolean).join(" · ");

  return (
    <section aria-label={t("output.format")} className="flex flex-col gap-1 rounded-lg bg-elevated p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-subdued">{t("output.format")}</p>
        {output?.exclusive &&
          (output.bitPerfect ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-accent accent-fill px-2.5 py-0.5 text-xs font-bold text-on-accent"
              data-testid="bit-perfect-badge"
            >
              <AudioWaveform size={12} aria-hidden="true" />
              {t("output.bitPerfect")}
            </span>
          ) : (
            <span className="rounded-full bg-highlight px-2.5 py-0.5 text-xs text-subdued">
              {t("output.notBitPerfect")}
            </span>
          ))}
      </div>
      <p className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
        {lossless && <span aria-hidden="true" className="size-2.5 rounded-full bg-accent accent-fill" />}
        {label}
      </p>
      <p className="text-sm text-subdued">{details}</p>
      {output && (
        <p className="mt-1 text-xs break-words text-subdued" data-testid="output-line">
          {t("output.playsOn", { output: formatOutputFormat(output) })}
        </p>
      )}
      {output?.exclusiveFallback && (
        <p className="mt-1 text-xs text-warning">
          {t("output.exclusiveFailed", { reason: output.exclusiveFallback })}
        </p>
      )}
    </section>
  );
}

function DeviceRow({
  selected,
  name,
  detail,
  isDefault,
  onSelect,
}: {
  selected: boolean;
  name: string;
  detail?: string;
  isDefault?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-highlight",
        selected && "bg-highlight",
      )}
    >
      <Speaker size={22} className={selected ? "text-accent" : "text-subdued"} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", selected && "font-bold text-accent")}>{name}</span>
        {detail && <span className="block text-sm break-words text-subdued">{detail}</span>}
      </span>
      {isDefault && (
        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-subdued">
          {t("output.default")}
        </span>
      )}
      {selected && <Check size={18} className="shrink-0 text-accent" aria-hidden="true" />}
    </button>
  );
}

function deviceDetail(device: DeviceInfo): string {
  const parts = [`${formatSampleRate(device.defaultSampleRate)} · ${device.maxChannels} ch`];
  const exclusive = exclusiveSummary(device.exclusiveCaps);
  if (exclusive) parts.push(exclusive);
  return parts.join(" · ");
}

/** Right panel: choose the output device, exclusive mode and see the live signal path. */
/** Audio panel: format, quick sound settings, output device. */
export function OutputPanel() {
  const { t } = useTranslation();
  const closeRightPanel = useLayout((s) => s.closeRightPanel);
  const output = useSettings((s) => s.output);
  const set = useSettings((s) => s.set);
  const { devices, loading, refresh } = useOutputDevices();

  const defaultDevice = devices.find((d) => d.isDefault);
  const selectedDevice = output.deviceId ? devices.find((d) => d.id === output.deviceId) : defaultDevice;
  const missing = output.deviceId !== null && devices.length > 0 && !selectedDevice;
  const exclusiveUnsupported = !!selectedDevice && !selectedDevice.supportsExclusive;

  const choose = (deviceId: string | null) => set("output", { ...output, deviceId });

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <h2 className="min-w-0 flex-1 truncate font-bold">{t("output.panelTitle")}</h2>
        <IconButton label={t("output.refresh")} onClick={refresh} disabled={loading}>
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
        </IconButton>
        <IconButton label={t("window.close")} onClick={closeRightPanel}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 [&>*]:shrink-0">
        <AudioStatus />
        <QuickSound />

        <section aria-label={t("output.devices")}>
          <h3 className="px-2 pb-1 font-bold">{t("output.devices")}</h3>
          <div role="radiogroup" aria-label={t("output.devices")} className="flex flex-col">
            <DeviceRow
              selected={output.deviceId === null}
              name={t("devices.systemDefault")}
              detail={defaultDevice?.name}
              onSelect={() => choose(null)}
            />
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                selected={output.deviceId === device.id}
                name={device.name}
                detail={deviceDetail(device)}
                isDefault={device.isDefault}
                onSelect={() => choose(device.id)}
              />
            ))}
          </div>
          {missing && <p className="px-2 pt-2 text-[13px] text-warning">{t("output.deviceMissing")}</p>}
          {devices.length === 0 && !loading && (
            <p className="px-2 pt-2 text-[13px] text-subdued">{t("output.noDevices")}</p>
          )}
        </section>

        <section className="rounded-lg bg-elevated p-4">
          <div className="flex items-start gap-3">
            <Switch
              checked={output.exclusive}
              disabled={exclusiveUnsupported}
              onCheckedChange={(exclusive) => set("output", { ...output, exclusive })}
              label={t("output.exclusiveMode")}
            />
            <div className="min-w-0">
              <p className="text-sm font-bold">{t("output.exclusiveMode")}</p>
              <p className="text-[13px] text-subdued">
                {exclusiveUnsupported ? t("output.exclusiveUnsupported") : t("output.exclusiveHint")}
              </p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
