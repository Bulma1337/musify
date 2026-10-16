import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleX, ShieldCheck } from "lucide-react";
import { describeError } from "@/api/errors";
import { setInsecureTls } from "@/api/http";
import type { ServerProbe } from "@/api/provider";
import { detectServer, factoryFor } from "@/api/registry";
import { useSession } from "@/api/session";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { serverLabel } from "./serverLabel";

type Detection =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "found"; probe: ServerProbe }
  | { state: "failed"; message: string };

/** First-run / add-server screen: address, credentials, automatic server detection. */
export function ConnectServer() {
  const { t } = useTranslation();
  const addServer = useSession((s) => s.addServer);
  const sessionError = useSession((s) => s.error);

  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [detection, setDetection] = useState<Detection>({ state: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(sessionError ? describeError(t, sessionError) : null);

  // Detect the server type shortly after the user stops typing the address.
  const urlLongEnough = url.trim().length >= 4;
  useEffect(() => {
    const value = url.trim();
    if (value.length < 4) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setDetection({ state: "checking" });
      try {
        setInsecureTls(/^https?:\/\//i.test(value) ? value : `https://${value}`, insecure);
      } catch {
        // invalid URL – detectServer reports it
      }
      detectServer(value)
        .then((probe) => !cancelled && setDetection({ state: "found", probe }))
        .catch((e: unknown) => !cancelled && setDetection({ state: "failed", message: describeError(t, e) }));
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, insecure, t]);

  const current: Detection = urlLongEnough ? detection : { state: "idle" };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const probe = current.state === "found" ? current.probe : await detectServer(url);
      setInsecureTls(probe.url, insecure);
      const result = await factoryFor(probe.kind).login(
        { url: probe.url, username: username.trim(), password },
        probe,
      );
      await addServer({ ...result, server: { ...result.server, allowInsecureTls: insecure || undefined } });
    } catch (e) {
      setError(describeError(t, e));
    } finally {
      setSubmitting(false);
    }
  }

  const detectionHint =
    current.state === "checking" ? (
      <span className="flex items-center gap-2">
        <Spinner size={14} /> {t("onboarding.detecting")}
      </span>
    ) : current.state === "found" ? (
      <span className="flex items-center gap-2 text-text">
        <CircleCheck size={16} className="text-accent" />
        {t("onboarding.detected", { server: serverLabel(current.probe) })}
      </span>
    ) : current.state === "failed" ? (
      <span className="flex items-center gap-2">
        <CircleX size={16} className="text-danger" /> {current.message}
      </span>
    ) : (
      t("onboarding.urlHint")
    );

  return (
    <div className="relative flex min-h-0 flex-1 overflow-y-auto">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-accent-soft),transparent_60%)]" />
      <form
        onSubmit={onSubmit}
        className="relative m-auto flex w-full max-w-[440px] flex-col gap-4 px-6 py-8"
        noValidate
      >
        <div className="mb-2 flex flex-col items-center gap-3 text-center">
          <img src="/navify.svg" alt="" className="size-12" draggable={false} />
          <h1 className="text-[28px] leading-tight font-extrabold tracking-tight">{t("onboarding.title")}</h1>
          <p className="text-subdued">{t("onboarding.subtitle")}</p>
        </div>

        <TextField
          label={t("onboarding.url")}
          placeholder="https://music.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          autoComplete="url"
          spellCheck={false}
          hint={detectionHint}
        />
        <TextField
          label={t("onboarding.username")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          spellCheck={false}
        />
        <TextField
          label={t("onboarding.password")}
          type="password"
          revealable
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          hint={t("onboarding.passwordHint")}
        />

        <div className="flex items-center justify-between gap-4">
          <label htmlFor="insecure-tls" className="text-sm text-subdued">
            {t("onboarding.allowInsecure")}
          </label>
          <Switch
            id="insecure-tls"
            checked={insecure}
            onCheckedChange={setInsecure}
            label={t("onboarding.allowInsecure")}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-danger/15 px-4 py-3 text-sm text-text">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" loading={submitting} disabled={!url.trim() || !password}>
          {t("onboarding.connect")}
        </Button>

        <p className="flex items-start gap-2 text-[13px] text-subdued">
          <ShieldCheck size={16} className="mt-0.5 shrink-0" />
          {t("onboarding.secureStorage")}
        </p>
      </form>
    </div>
  );
}
