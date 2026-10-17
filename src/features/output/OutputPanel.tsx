import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ArrowDown, AudioWaveform, Check, RefreshCw, Speaker, X } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { useLayout } from "@/app/layout/layoutStore";
import { useEngineStatus } from "@/player/bridge";
import type { DeviceInfo } from "@/player/engineTypes";
import { usePlayer } from "@/player/store";
import { useSettings } from "@/settings/store";
import {
  activeProcessing,
  bitPerfectBlockers,
  exclusiveSummary,
  formatOutputFormat,
  formatSampleRate,
  formatSourceFormat,
} from "./signalPath";
import { useOutputDevices } from "./useOutputDevices";

function Stage({ label, children, muted }: { label: string; children: ReactNode; muted?: boolean }) {
  return (
    <div className="rounded-md bg-surface px-3 py-2">
      <p className="text-xs text-subdued">{label}</p>
      <p className={cn("text-sm break-words", muted && "text-subdued")}>{children}</p>
    </div>
  );
}

function SignalPath() {
  const { t } = useTranslation();
  const source = useEngineStatus((s) => s.sourceFormat);
  const output = useEngineStatus((s) => s.outputFormat);
  const dsp = useSettings((s) => s.dsp);
  const normalization = useSettings((s) => s.normalization);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);

  const stages = activeProcessing(dsp, normalization);
  const blockers = output ? bitPerfectBlockers({ dsp, normalization, volume, muted, source, output }) : [];

  return (
    <section aria-label={t("output.signalPath")} className="rounded-lg bg-elevated p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-bold">{t("output.signalPath")}</h3>
        {output?.exclusive &&
          (output.bitPerfect ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[13px] font-bold text-on-accent"
              data-testid="bit-perfect-badge"
            >
              <AudioWaveform size={14} aria-hidden="true" />
              {t("output.bitPerfect")}
            </span>
          ) : (
            <span className="rounded-full bg-highlight px-3 py-1 text-[13px] text-subdued">
              {t("output.notBitPerfect")}
            </span>
          ))}
      </div>

      <div className="flex flex-col items-stretch gap-1">
        <Stage label={t("output.source")} muted={!source}>
          {source ? formatSourceFormat(source) : t("output.nothingPlaying")}
        </Stage>
        <ArrowDown size={16} className="self-center text-muted" aria-hidden="true" />
        <Stage label={t("output.processing")} muted={stages.length === 0}>
          {stages.length === 0
            ? t("output.unchanged")
            : stages.map((s) => t(`output.stages.${s}`)).join(", ")}
        </Stage>
        <ArrowDown size={16} className="self-center text-muted" aria-hidden="true" />
        <Stage label={t("output.destination")} muted={!output}>
          {output ? formatOutputFormat(output) : t("output.nothingPlaying")}
          {output?.resampled && output.sourceRate ? (
            <span className="block text-xs text-subdued" data-testid="resampled-note">
              {t("output.resampledFrom", {
                from: formatSampleRate(output.sourceRate),
                to: formatSampleRate(output.sampleRate),
              })}
            </span>
          ) : null}
        </Stage>
      </div>

      {output && !output.exclusive && (output.sourceRate ?? 0) > output.sampleRate && (
        <p className="mt-3 text-[13px] text-subdued" data-testid="mixer-limit">
          {t("output.mixerLimits", { rate: formatSampleRate(output.sampleRate) })}
        </p>
      )}
      {output?.exclusiveFallback && (
        <p className="mt-3 text-[13px] text-warning">
          {t("output.exclusiveFailed", { reason: output.exclusiveFallback })}
        </p>
      )}

      {output?.exclusive && !output.bitPerfect && blockers.length > 0 && (
        <div className="mt-3 text-[13px] text-subdued">
          <p>{t("output.reasonsTitle")}</p>
          <ul className="mt-1 list-disc pl-5">
            {blockers.map((b) => (
              <li key={b}>{t(`output.reasons.${b}`)}</li>
            ))}
          </ul>
        </div>
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
export function OutputPanel() {
  const { t } = useTranslation();
  const setRightPanel = useLayout((s) => s.setRightPanel);
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
        <h2 className="min-w-0 flex-1 truncate font-bold">{t("devices.title")}</h2>
        <IconButton label={t("output.refresh")} onClick={refresh} disabled={loading}>
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
        </IconButton>
        <IconButton label={t("window.close")} onClick={() => setRightPanel(null)}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 [&>*]:shrink-0">
        <SignalPath />

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

        <Link
          to="/equalizer"
          className="text-sm font-bold text-subdued underline-offset-2 hover:text-text hover:underline"
        >
          {t("output.openEqualizer")}
        </Link>
      </div>
    </>
  );
}
